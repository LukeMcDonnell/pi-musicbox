/**
 * Cover thumbnails: one ART_THUMB_EDGE size, served from disk.
 *
 * The server never builds them: it has no child_process, by design. It asks
 * `musicbox-thumbs` (a helper unit installed by setup-server.sh) by dropping a
 * request file, the same pattern as power.ts, and serves whatever is built. A
 * thumbnail not built yet is a 404 and the client falls back to the original.
 * See .claude/docs/decisions.md, "Cover thumbnails".
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ThumbnailStatus } from '../../shared/api.ts';
import { ART_MAX_AGE_S, etagFor } from './art.ts';

/** `album` is a library directory (albums and artists alike), `release` a CD's MusicBrainz id. */
export type ThumbKind = 'album' | 'release';

export const DEFAULT_THUMB_REQUEST_DIR = '/run/musicbox-thumbs';

/** The helper writes this after a full pass that produced anything. */
export const THUMBS_COMPLETE_MARKER = '.complete';

/** The helper's one-line progress report, in the request directory (tmpfs). */
export const THUMBS_STATUS_FILE = 'status';

/** The cache file stem. MUST match the helper's `printf '%s:%s' kind key | sha1sum`. */
export function thumbName(kind: ThumbKind, key: string): string {
    return createHash('sha1').update(`${kind}:${key}`).digest('hex');
}

/** What can be asked of the helper. The request is the file's NAME; it is never read. */
export type ThumbRequest = 'library' | 'cd';

export interface ThumbRequests {
    /** Ask for a build. Quietly nothing where no helper is installed (a dev machine). */
    request: (what: ThumbRequest) => Promise<void>;
    /** Whether a full build has ever completed. */
    built: () => Promise<boolean>;
    /** What the helper is doing, or last did. */
    status: () => Promise<ThumbnailStatus>;
}

const NO_STATUS: ThumbnailStatus = {
    state: 'never', scope: null, progress: null, total: null,
    startedAt: null, finishedAt: null, built: null, failed: null,
};

/**
 * Parse the helper's status line. MUST match `status` in setup-server.sh's helper:
 * `running <pid> <started> <progress> <total> <scope>` or
 * `idle <finished> <built> <current> <without> <failed> <scope>`, times in epoch seconds.
 */
export function parseThumbStatus(line: string, alive: (pid: number) => boolean): ThumbnailStatus | null {
    const f = line.trim().split(' ');
    const n = (i: number) => Number(f[i]);
    const scope = f.at(-1) === 'library' || f.at(-1) === 'cd' ? (f.at(-1) as 'library' | 'cd') : null;
    if (f[0] === 'running' && f.length === 6 && [1, 2, 3, 4].every((i) => Number.isInteger(n(i)))) {
        return {
            ...NO_STATUS,
            state: alive(n(1)) ? 'running' : 'interrupted',
            scope,
            progress: n(3),
            total: n(4),
            startedAt: n(2) * 1000,
        };
    }
    if (f[0] === 'idle' && f.length === 7 && [1, 2, 3, 4, 5].every((i) => Number.isInteger(n(i)))) {
        return { ...NO_STATUS, state: 'done', scope, finishedAt: n(1) * 1000, built: n(2), failed: n(5) };
    }
    return null;
}

const processAlive = (pid: number): boolean => existsSync(`/proc/${pid}`);

export function createThumbRequests(requestDir: string, thumbDir: string): ThumbRequests {
    return {
        request: async (what) => {
            try {
                await writeFile(join(requestDir, what), '');
            } catch {
                // No request directory: no helper to ask.
            }
        },
        built: async () => {
            try {
                await access(join(thumbDir, THUMBS_COMPLETE_MARKER));
                return true;
            } catch {
                return false;
            }
        },
        status: async () => {
            try {
                const parsed = parseThumbStatus(await readFile(join(requestDir, THUMBS_STATUS_FILE), 'utf8'), processAlive);
                if (parsed) return parsed;
            } catch {
                // No pass since boot: the status file lives on tmpfs.
            }
            try {
                const marker = await stat(join(thumbDir, THUMBS_COMPLETE_MARKER));
                return { ...NO_STATUS, state: 'done', scope: 'library', finishedAt: marker.mtimeMs };
            } catch {
                return NO_STATUS;
            }
        },
    };
}

/**
 * GET /api/art/thumb?album= and /api/cd/art/thumb?release=: the built thumbnail,
 * or a 404 the browser must not cache, so it asks again once one exists.
 */
export function createThumbHandler(dir: string, kind: ThumbKind, param: string) {
    return async function thumbHandler(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
        const key = (request.query as Record<string, string | undefined>)[param];
        if (key === undefined) return reply.code(400).send({ error: `missing '${param}' query parameter` });

        const path = join(dir, `${thumbName(kind, key)}.jpg`);
        let info;
        try {
            info = await stat(path);
        } catch {
            return reply.code(404).header('cache-control', 'no-store').send({ error: 'no thumbnail yet' });
        }

        const etag = etagFor({ path, size: info.size, mtimeMs: info.mtimeMs });
        reply
            .header('etag', etag)
            .header('cache-control', `public, max-age=${ART_MAX_AGE_S}`)
            .header('content-type', 'image/jpeg');
        if (request.headers['if-none-match'] === etag) return reply.code(304).send();
        reply.header('content-length', String(info.size));
        return reply.send(createReadStream(path));
    };
}
