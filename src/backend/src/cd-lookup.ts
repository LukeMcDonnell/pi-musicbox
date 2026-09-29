/**
 * A disc's titles and cover, from MusicBrainz and the Cover Art Archive.
 *
 * Exact disc ID matches only — MusicBrainz's fuzzy `?toc=` search can return a
 * near miss, and a wrong title shown confidently is worse than "Track 3". The
 * answer is cached in SQLite, so a disc is asked about once. See .claude/docs/cd.md.
 */

import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.ts';
import type { ArtResolver } from './art.ts';

export const MUSICBRAINZ = 'https://musicbrainz.org/ws/2';
export const COVER_ART_ARCHIVE = 'https://coverartarchive.org';

const TIMEOUT_MS = 10_000;
/** MusicBrainz asks for no more than one request a second. */
const MIN_INTERVAL_MS = 1_000;
/** A disc MusicBrainz did not know may have been added since. */
export const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isReleaseId(value: unknown): value is string {
    return typeof value === 'string' && UUID.test(value);
}

export function cdArtUri(releaseId: string): string {
    return `/api/cd/art?release=${releaseId}`;
}

/**
 * Covers fetched by the lookup, by release ID. Misses are NOT cached, unlike the
 * library's: the file appears moments after the disc's first request for it.
 */
export function createCdArtResolver(artDir: string): ArtResolver {
    let stats = 0;
    return {
        resolve: async (releaseId) => {
            if (!isReleaseId(releaseId)) return null;
            const path = join(artDir, `${releaseId}.jpg`);
            stats++;
            try {
                const s = await stat(path);
                return { path, size: s.size, mtimeMs: s.mtimeMs };
            } catch {
                return null;
            }
        },
        stats: () => stats,
    };
}

/** The pressing chosen for a disc, trimmed to what the box shows. */
export interface CdRelease {
    releaseId: string;
    album: string;
    artist: string | null;
    date: string | null;
    hasFront: boolean;
    /** The medium this disc is, in order — mapped by position onto its audio tracks. */
    tracks: { title: string; artist: string | null }[];
}

export type LookupResult =
    | { status: 'found'; release: CdRelease; image: string | null }
    | { status: 'not-found' }
    | { status: 'failed'; reason: string };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function credit(v: unknown): string | null {
    const parts = arr(v).map((c) => `${str(obj(c).name) ?? ''}${str(obj(c).joinphrase) ?? ''}`);
    return str(parts.join('').trim());
}

/**
 * Choose among the releases a disc ID matches. They share a tracklist by
 * construction, so this only decides the cover: one that has a front wins, then
 * MusicBrainz's own order.
 */
export function pickRelease(body: unknown, discId: string): CdRelease | null {
    const candidates: CdRelease[] = [];
    for (const r of arr(obj(body).releases)) {
        const release = obj(r);
        const id = release.id;
        const album = str(release.title);
        if (!isReleaseId(id) || album === null) continue;
        const medium = arr(release.media).map(obj).find((m) => arr(m.discs).some((d) => obj(d).id === discId));
        if (!medium) continue;
        const albumArtist = credit(release['artist-credit']);
        candidates.push({
            releaseId: id,
            album,
            artist: albumArtist,
            date: str(release.date),
            hasFront: obj(release['cover-art-archive']).front === true,
            tracks: arr(medium.tracks).map((t) => ({
                title: str(obj(t).title) ?? '',
                artist: credit(obj(t)['artist-credit']) ?? albumArtist,
            })),
        });
    }
    return candidates.find((c) => c.hasFront) ?? candidates[0] ?? null;
}

export interface CdLookupOptions {
    db: Db;
    /** Where covers are kept: beside the database, never under backend/. */
    artDir: string;
    userAgent: string;
    fetch?: typeof fetch;
    now?: () => number;
    log?: (level: 'warn' | 'info', message: string) => void;
    minIntervalMs?: number;
}

export interface CdLookup {
    find(discId: string): Promise<LookupResult>;
}

export function createCdLookup(opts: CdLookupOptions): CdLookup {
    const doFetch = opts.fetch ?? fetch;
    const now = opts.now ?? Date.now;
    const log = opts.log ?? (() => {});
    const minInterval = opts.minIntervalMs ?? MIN_INTERVAL_MS;
    let lastRequest = 0;
    // One request at a time, spaced out: MusicBrainz blocks clients that burst.
    let queue: Promise<unknown> = Promise.resolve();

    const politely = <T>(work: () => Promise<T>): Promise<T> => {
        const run = queue.then(async () => {
            const wait = lastRequest + minInterval - now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            lastRequest = now();
            return work();
        });
        queue = run.catch(() => {});
        return run;
    };

    const get = (url: string) =>
        doFetch(url, {
            headers: { 'user-agent': opts.userAgent, accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });

    const artPath = (releaseId: string) => join(opts.artDir, `${releaseId}.jpg`);

    /** The cover's URI once it is on disk, fetching it first if it is not. */
    const cover = async (release: CdRelease): Promise<string | null> => {
        const path = artPath(release.releaseId);
        try {
            await stat(path);
            return cdArtUri(release.releaseId);
        } catch {
            // Not fetched yet.
        }
        if (!release.hasFront) return null;
        try {
            const res = await get(`${COVER_ART_ARCHIVE}/release/${release.releaseId}/front-500`);
            if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) {
                log('warn', `cd: no cover for ${release.releaseId} (HTTP ${res.status})`);
                return null;
            }
            const bytes = Buffer.from(await res.arrayBuffer());
            await mkdir(opts.artDir, { recursive: true });
            await writeFile(`${path}.tmp`, bytes);
            await rename(`${path}.tmp`, path);
            return cdArtUri(release.releaseId);
        } catch (err) {
            log('warn', `cd: cover for ${release.releaseId} failed: ${(err as Error).message}`);
            return null;
        }
    };

    const cached = (discId: string) =>
        opts.db.get<{ status: string; info: string | null; fetched_at: number }>(
            'SELECT status, info, fetched_at FROM cd_disc WHERE disc_id = ?',
            discId,
        );

    const store = (discId: string, status: 'found' | 'not-found', release: CdRelease | null) =>
        opts.db.run(
            'INSERT INTO cd_disc (disc_id, status, info, fetched_at) VALUES (?, ?, ?, ?) ' +
                'ON CONFLICT(disc_id) DO UPDATE SET status = excluded.status, info = excluded.info, ' +
                'fetched_at = excluded.fetched_at',
            discId,
            status,
            release === null ? null : JSON.stringify(release),
            now(),
        );

    return {
        async find(discId) {
            const row = cached(discId);
            if (row?.status === 'found' && row.info !== null) {
                const release = JSON.parse(row.info) as CdRelease;
                return { status: 'found', release, image: await cover(release) };
            }
            if (row?.status === 'not-found' && now() - row.fetched_at < NOT_FOUND_TTL_MS) {
                return { status: 'not-found' };
            }
            try {
                const url = `${MUSICBRAINZ}/discid/${encodeURIComponent(discId)}?inc=recordings+artist-credits&fmt=json`;
                const res = await politely(() => get(url));
                if (res.status === 404) {
                    store(discId, 'not-found', null);
                    log('info', `cd: ${discId} is not on MusicBrainz`);
                    return { status: 'not-found' };
                }
                if (!res.ok) return { status: 'failed', reason: `MusicBrainz answered HTTP ${res.status}` };
                const release = pickRelease(await res.json(), discId);
                if (release === null) {
                    store(discId, 'not-found', null);
                    return { status: 'not-found' };
                }
                store(discId, 'found', release);
                log('info', `cd: ${discId} is ${release.artist ?? '?'} — ${release.album} (${release.releaseId})`);
                return { status: 'found', release, image: await cover(release) };
            } catch (err) {
                // Not cached: the network being down says nothing about the disc.
                return { status: 'failed', reason: (err as Error).message };
            }
        },
    };
}
