/**
 * Backup and restore of the box's state: MPD's files and this server's database.
 *
 * Building a backup needs no privilege — every file is world-readable. Restoring
 * does: MPD's files are its own and MPD must be stopped first, so this only
 * stages a validated payload and root's musicbox-restore helper does the swap.
 * See install/setup-server.sh.
 */

import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile, constants as fsConstants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BACKUP_MAX_BYTES } from '../../shared/api.ts';
import { SCHEMA_VERSION, checkDbFile, type Db } from './db.ts';
import { TarError, packTar, unpackTar, type TarEntry } from './tar.ts';

export const BACKUP_FORMAT = 1;

/** Uncompressed ceiling: tag_cache is ~3.7MB today, so this is room to grow, not a target. */
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

const DB_MEMBER = 'musicbox.db';
const MANIFEST_MEMBER = 'manifest.json';
const MPD_REQUIRED = ['state'] as const;
const MPD_OPTIONAL = ['tag_cache', 'sticker.sql'] as const;
// Must match the helper's own allowlist in install/setup-server.sh.
const PLAYLIST_MEMBER = /^mpd\/playlists\/[^/\x00-\x1f]+\.m3u$/;

export interface Manifest {
    format: number;
    createdAt: number;
    build: string;
    schemaVersion: number;
}

export class BackupError extends Error {
    code: 400 | 409 | 503;
    constructor(message: string, code: 400 | 409 | 503) {
        super(message);
        this.name = 'BackupError';
        this.code = code;
    }
}

export interface Backups {
    create(): Promise<{ filename: string; archive: Buffer }>;
    /** Whether a staged restore is still waiting for the helper. */
    pending(): Promise<boolean>;
    /** Validate an uploaded archive and hand it to the root helper. */
    restore(archive: Buffer): Promise<void>;
}

export interface BackupOptions {
    db: Db;
    build: string;
    mpdDir: string;
    restoreDir: string;
    now?: () => number;
}

export function isAllowedMember(name: string): boolean {
    if (name === DB_MEMBER || name === MANIFEST_MEMBER) return true;
    if ([...MPD_REQUIRED, ...MPD_OPTIONAL].some((file) => name === `mpd/${file}`)) return true;
    return PLAYLIST_MEMBER.test(name) && !name.startsWith('mpd/playlists/.');
}

export function backupFilename(now: number): string {
    const d = new Date(now);
    const two = (n: number) => String(n).padStart(2, '0');
    return `musicbox-backup-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}.tar.gz`;
}

async function readOptional(path: string): Promise<Buffer | null> {
    try {
        return await readFile(path);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
    }
}

/** Unpack and check an archive, without touching the filesystem beyond a scratch db copy. */
export async function readBackup(archive: Buffer, known: number = SCHEMA_VERSION): Promise<TarEntry[]> {
    let entries: TarEntry[];
    try {
        entries = unpackTar(gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES }));
    } catch (err) {
        if (err instanceof TarError) throw new BackupError(`not a valid backup: ${err.message}`, 400);
        throw new BackupError('not a valid backup: not a gzip archive, or too large', 400);
    }

    const names = new Set<string>();
    for (const { name } of entries) {
        if (!isAllowedMember(name)) throw new BackupError(`unexpected file in backup: ${name}`, 400);
        if (names.has(name)) throw new BackupError(`duplicate file in backup: ${name}`, 400);
        names.add(name);
    }

    const manifestEntry = entries.find((e) => e.name === MANIFEST_MEMBER);
    let manifest: Partial<Manifest> | null = null;
    try {
        manifest = manifestEntry ? (JSON.parse(manifestEntry.data.toString('utf8')) as Partial<Manifest>) : null;
    } catch {
        // Reported below as a missing manifest.
    }
    if (manifest?.format !== BACKUP_FORMAT) {
        throw new BackupError('not a musicbox backup, or from an incompatible version', 400);
    }
    for (const required of [DB_MEMBER, ...MPD_REQUIRED.map((f) => `mpd/${f}`)]) {
        if (!names.has(required)) throw new BackupError(`backup is missing ${required}`, 400);
    }

    const scratch = await mkdtemp(join(tmpdir(), 'musicbox-backup-check-'));
    try {
        const path = join(scratch, DB_MEMBER);
        await writeFile(path, entries.find((e) => e.name === DB_MEMBER)!.data);
        checkDbFile(path, known);
    } catch (err) {
        throw new BackupError(`backup database is unusable: ${(err as Error).message}`, 400);
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
    return entries;
}

export function createBackups(opts: BackupOptions): Backups {
    const { mpdDir, restoreDir } = opts;
    const now = opts.now ?? Date.now;
    const request = join(restoreDir, 'request');
    const payload = join(restoreDir, 'payload');
    let staging = false;

    async function pending(): Promise<boolean> {
        return (await readOptional(request)) !== null;
    }

    return {
        pending,

        async create() {
            const createdAt = now();
            const scratch = await mkdtemp(join(tmpdir(), 'musicbox-backup-'));
            const entries: TarEntry[] = [];
            try {
                const dbCopy = join(scratch, DB_MEMBER);
                opts.db.snapshot(dbCopy);
                const manifest: Manifest = {
                    format: BACKUP_FORMAT,
                    createdAt,
                    build: opts.build,
                    schemaVersion: SCHEMA_VERSION,
                };
                entries.push(
                    { name: MANIFEST_MEMBER, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
                    { name: DB_MEMBER, data: await readFile(dbCopy) },
                );
            } finally {
                await rm(scratch, { recursive: true, force: true });
            }

            for (const file of MPD_REQUIRED) {
                const data = await readOptional(join(mpdDir, file));
                if (!data) throw new BackupError(`cannot read ${join(mpdDir, file)} — is MPD installed?`, 503);
                entries.push({ name: `mpd/${file}`, data });
            }
            for (const file of MPD_OPTIONAL) {
                const data = await readOptional(join(mpdDir, file));
                if (data) entries.push({ name: `mpd/${file}`, data });
            }
            let playlists: string[] = [];
            try {
                playlists = (await readdir(join(mpdDir, 'playlists'))).sort();
            } catch {
                // No playlist directory is the same as no playlists.
            }
            for (const file of playlists) {
                const name = `mpd/playlists/${file}`;
                if (!isAllowedMember(name)) continue;
                const data = await readOptional(join(mpdDir, 'playlists', file));
                if (data) entries.push({ name, data });
            }

            return {
                filename: backupFilename(createdAt),
                archive: gzipSync(packTar(entries, Math.floor(createdAt / 1000))),
            };
        },

        async restore(archive) {
            if (archive.length > BACKUP_MAX_BYTES) throw new BackupError('backup is too large', 400);
            try {
                await access(restoreDir, fsConstants.W_OK);
            } catch {
                throw new BackupError('restore is not available — is setup-server.sh installed?', 503);
            }
            if (staging || (await pending())) {
                throw new BackupError('a restore is already in progress', 409);
            }

            staging = true;
            try {
                const entries = await readBackup(archive);
                const next = await mkdtemp(join(restoreDir, 'payload.tmp-'));
                try {
                    for (const entry of entries) {
                        if (entry.name === MANIFEST_MEMBER) continue;
                        const target = join(next, entry.name);
                        await mkdir(dirname(target), { recursive: true });
                        await writeFile(target, entry.data, { mode: 0o644 });
                    }
                    await rm(payload, { recursive: true, force: true });
                    await rename(next, payload);
                } catch (err) {
                    await rm(next, { recursive: true, force: true });
                    throw err;
                }
                // Last, so the helper never sees a half-written payload.
                await writeFile(request, '');
            } finally {
                staging = false;
            }
        },
    };
}
