/**
 * Backup and restore of the looked-up CD covers, apart from the main backup.
 *
 * The covers are this server's own files, so restore needs no root helper and
 * no restart. It only ever adds: a cover is keyed by an immutable release ID.
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CD_ART_BACKUP_MAX_BYTES } from '../../shared/api.ts';
import { BackupError, filenameStamp } from './backup.ts';
import { isReleaseId } from './cd-lookup.ts';
import { TarError, packTar, unpackTar, type TarEntry } from './tar.ts';

export const CD_ART_BACKUP_FORMAT = 1;

const MANIFEST_MEMBER = 'manifest.json';
const COVER_MEMBER = /^cd-art\/([^/]+)\.jpg$/;

export interface CdArtManifest {
    kind: 'cd-art';
    format: number;
    createdAt: number;
    build: string;
}

export interface CdArtBackups {
    create(): Promise<{ filename: string; archive: Buffer }>;
    /** Add every cover in the archive; returns how many were written. */
    restore(archive: Buffer): Promise<number>;
}

export interface CdArtBackupOptions {
    artDir: string;
    build: string;
    now?: () => number;
}

export function cdArtBackupFilename(now: number): string {
    return `musicbox-cd-covers-${filenameStamp(now)}.tar.gz`;
}

/** The release ID a member holds the cover of, or null if it is not a cover. */
export function coverRelease(name: string): string | null {
    const id = COVER_MEMBER.exec(name)?.[1];
    return isReleaseId(id) ? id : null;
}

/** Unpack and check an archive; every cover is returned with its release ID. */
export function readCdArtBackup(archive: Buffer): { releaseId: string; data: Buffer }[] {
    let entries: TarEntry[];
    try {
        entries = unpackTar(gunzipSync(archive, { maxOutputLength: CD_ART_BACKUP_MAX_BYTES * 2 }));
    } catch (err) {
        if (err instanceof TarError) throw new BackupError(`not a valid cover backup: ${err.message}`, 400);
        throw new BackupError('not a valid cover backup: not a gzip archive, or too large', 400);
    }

    let manifest: Partial<CdArtManifest> | null = null;
    try {
        const entry = entries.find((e) => e.name === MANIFEST_MEMBER);
        manifest = entry ? (JSON.parse(entry.data.toString('utf8')) as Partial<CdArtManifest>) : null;
    } catch {
        // Reported below.
    }
    if (manifest?.kind !== 'cd-art' || manifest.format !== CD_ART_BACKUP_FORMAT) {
        throw new BackupError('not a CD cover backup, or from an incompatible version', 400);
    }

    const covers: { releaseId: string; data: Buffer }[] = [];
    const seen = new Set<string>();
    for (const { name, data } of entries) {
        if (name === MANIFEST_MEMBER) continue;
        const releaseId = coverRelease(name);
        if (releaseId === null) throw new BackupError(`unexpected file in cover backup: ${name}`, 400);
        if (seen.has(releaseId)) throw new BackupError(`duplicate file in cover backup: ${name}`, 400);
        if (data.length === 0) throw new BackupError(`empty file in cover backup: ${name}`, 400);
        seen.add(releaseId);
        covers.push({ releaseId, data });
    }
    return covers;
}

export function createCdArtBackups(opts: CdArtBackupOptions): CdArtBackups {
    const now = opts.now ?? Date.now;

    return {
        async create() {
            const createdAt = now();
            const manifest: CdArtManifest = { kind: 'cd-art', format: CD_ART_BACKUP_FORMAT, createdAt, build: opts.build };
            const entries: TarEntry[] = [
                { name: MANIFEST_MEMBER, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
            ];
            let files: string[] = [];
            try {
                files = (await readdir(opts.artDir)).sort();
            } catch (err) {
                // No directory yet is the same as no covers.
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            }
            for (const file of files) {
                const name = `cd-art/${file}`;
                if (coverRelease(name) === null) continue;
                try {
                    entries.push({ name, data: await readFile(join(opts.artDir, file)) });
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
                }
            }
            return {
                filename: cdArtBackupFilename(createdAt),
                archive: gzipSync(packTar(entries, Math.floor(createdAt / 1000))),
            };
        },

        async restore(archive) {
            if (archive.length > CD_ART_BACKUP_MAX_BYTES) throw new BackupError('cover backup is too large', 400);
            const covers = readCdArtBackup(archive);
            await mkdir(opts.artDir, { recursive: true });
            for (const { releaseId, data } of covers) {
                const path = join(opts.artDir, `${releaseId}.jpg`);
                await writeFile(`${path}.tmp`, data, { mode: 0o644 });
                await rename(`${path}.tmp`, path);
            }
            return covers.length;
        },
    };
}
