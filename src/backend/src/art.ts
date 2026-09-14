/**
 * Album art.
 *
 * WHY THE FILESYSTEM AND NOT MPD
 *   MPD 0.24 has `albumart`, and it was the obvious first choice. It only looks
 *   for `cover.png/jpg/tiff/bmp` beside the song, and a census of this library
 *   found 86 such files against 3201 `folder.jpg` — about 1.4% coverage. Reading
 *   the directory ourselves gets 92.5% (measured: 111 of 120 sampled album dirs).
 *
 *   The alternative was `readpicture`, for embedded art. That means teaching
 *   MpdConnection to read binary replies, and that class matches replies to
 *   commands purely by queue order with a timeout that destroys the socket — a
 *   second parser mode inside it is real risk for a small gain. Deferred, on
 *   purpose. See .claude/docs/architecture.md.
 *
 * WHY THE URI IS KEYED BY ALBUM DIRECTORY
 *   Art belongs to an album, not a track, so every track on an album yields the
 *   same URL. The browser fetches it once and reuses it for all twelve tracks,
 *   and because the bound value does not change between tracks of one album, a
 *   track change causes no refetch and no image repaint. That matters more here
 *   than it would elsewhere: repaints on the DSI panel go through the vc4 commit
 *   path implicated in the clock deadlock (see .claude/docs/clock-deadlock.md),
 *   which is also why the frontend has no CSS transitions.
 *
 * WHY A QUERY PARAMETER
 *   Album directories in this library contain `!`, `&`, `#`, `(`, spaces and of
 *   course `/`. Carrying that in a path segment means encoding `/` as `%2F`,
 *   which routers and proxies are entitled to normalise back. One
 *   encodeURIComponent into `?album=` has none of those hazards.
 *
 * NO RESIZING
 *   These files are large — median 542KB, max 1.48MB — and the panel is 800x480.
 *   Resizing would need sharp (a native module, which breaks the single-file
 *   esbuild bundle and the one-runtime-dependency rule) or a pure-JS decoder
 *   (slow on a Pi, and bundle bloat). The per-album key plus a week of cache is
 *   the mitigation instead: one fetch per album, not one per track.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { posix } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { contentTypeFor, safeJoin } from './static.ts';

/**
 * Candidate cover filenames, best first.
 *
 * THIS ORDER IS LOAD-BEARING. A naive "first image in the directory" is wrong
 * here: `discart.jpg` + `discart.png` together outnumber `cover.jpg` 44 to 1,
 * and a discart is a round disc image on a transparent background — it would
 * look broken as a cover. `fanart`, `banner`, `logo` and `clearlogo` are the
 * rest of the Kodi artwork set and are excluded for the same reason.
 *
 * `cover.*` comes first because it is the explicit convention (and MPD's own);
 * `folder.*` is what this library actually uses for all but a handful.
 */
export const ART_FILENAMES = [
    'cover.jpg',
    'cover.jpeg',
    'cover.png',
    'folder.jpg',
    'folder.jpeg',
    'folder.png',
    'front.jpg',
    'front.png',
] as const;

/**
 * Synology litters the share with these. `setup-mpd.sh` already excludes them
 * from MPD's scan; the same junk must never be served as art.
 */
const JUNK_SEGMENTS = ['@eaDir', '#recycle'];

/** A week. Art for a given album effectively never changes. */
export const ART_MAX_AGE_S = 604_800;

/** Bound on the resolution cache. Comfortably more albums than fit on a panel. */
const CACHE_LIMIT = 512;

/**
 * The album directory a song lives in, relative to the music root.
 *
 * MPD paths are always POSIX and always relative, so posix.dirname is correct
 * regardless of the host platform. A song at the library root has no album
 * directory — posix.dirname returns '.' — and gets '' so the URI is still
 * well-formed and resolution simply looks in the root.
 */
export function albumDirOf(file: string): string {
    const dir = posix.dirname(file);
    return dir === '.' || dir === '/' ? '' : dir;
}

/**
 * The URI for a library DIRECTORY's image. Always well-formed; may 404.
 *
 * `album` is the parameter's name because albums were the only caller when this
 * was written, and renaming it now would break every cached URL in every
 * browser for a week (see ART_MAX_AGE_S). What the handler actually does is
 * resolve a cover inside whatever library directory it is given, and ARTIST
 * DIRECTORIES ARE A SECOND CALLER — src/backend/src/library.ts builds artist
 * images with this. It turns out this library files a `folder.jpg` of the artist
 * beside their albums exactly as it files one of the sleeve beside the tracks:
 * 473 of 487 artist directories have one, measured, so artist art needed no new
 * endpoint, no new filename list and no new cache.
 *
 * So do not "tighten" the resolver to albums only. Nothing about it is
 * album-specific, and two screens now depend on that.
 */
export function artUriForDir(dir: string): string {
    return `/api/art?album=${encodeURIComponent(dir)}`;
}

/** The URI to put on a Track. Always well-formed; may 404. */
export function artUriFor(file: string): string {
    return artUriForDir(albumDirOf(file));
}

/** Injected in tests so cache behaviour can be asserted without timing. */
export interface ArtDeps {
    statFile: (path: string) => Promise<{ size: number; mtimeMs: number } | null>;
}

const realDeps: ArtDeps = {
    statFile: async (path) => {
        try {
            const info = await stat(path);
            return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
        } catch {
            // Missing, unreadable, or — since this lives on a soft-mounted NFS
            // share — the NAS being unreachable. All the same answer: no art.
            return null;
        }
    },
};

export interface ResolvedArt {
    path: string;
    size: number;
    mtimeMs: number;
}

export interface ArtResolver {
    resolve: (albumDir: string) => Promise<ResolvedArt | null>;
    /** Test seam: how many stat calls have been made. */
    stats: () => number;
}

/**
 * Resolve album dir -> art file, memoised.
 *
 * NEGATIVE RESULTS ARE CACHED TOO, and that is the important half: ~7.5% of
 * albums have no cover, and without this every request for one would walk the
 * whole candidate list over NFS again.
 */
export function createArtResolver(musicRoot: string, deps: ArtDeps = realDeps): ArtResolver {
    const cache = new Map<string, ResolvedArt | null>();
    let statCount = 0;

    return {
        stats: () => statCount,
        resolve: async (albumDir: string): Promise<ResolvedArt | null> => {
            if (cache.has(albumDir)) return cache.get(albumDir) ?? null;

            let found: ResolvedArt | null = null;
            const dirPath = safeJoin(musicRoot, `/${albumDir}`);

            // safeJoin returning null means the request tried to escape the music
            // root. Junk directories are refused outright.
            const junk = JUNK_SEGMENTS.some((j) => albumDir.split('/').includes(j));
            if (dirPath !== null && !junk) {
                for (const name of ART_FILENAMES) {
                    const candidate = safeJoin(dirPath, `/${name}`);
                    if (candidate === null) continue;
                    statCount += 1;
                    const info = await deps.statFile(candidate);
                    if (info) {
                        found = { path: candidate, size: info.size, mtimeMs: info.mtimeMs };
                        break;
                    }
                }
            }

            // FIFO eviction. Insertion order is Map's iteration order, so the
            // oldest key is simply the first one.
            if (cache.size >= CACHE_LIMIT) {
                const oldest = cache.keys().next();
                if (!oldest.done) cache.delete(oldest.value);
            }
            cache.set(albumDir, found);
            return found;
        },
    };
}

/**
 * Weak ETag from mtime and size.
 *
 * Weak, not strong, because it is derived from metadata rather than the bytes:
 * two different images written in the same millisecond at the same length would
 * collide. For cover art that is not a risk worth a hash over NFS.
 */
export function etagFor(art: ResolvedArt): string {
    return `W/"${art.mtimeMs.toString(36)}-${art.size.toString(36)}"`;
}

/**
 * GET /api/art?album=<encoded album directory>
 *
 * 400 when the parameter is missing, 404 when there is no art. Deliberately no
 * distinction between "no such album" and "album with no cover": both mean the
 * client should show its placeholder, and telling them apart would leak whether
 * a path exists.
 */
export function createArtHandler(resolver: ArtResolver) {
    return async function artHandler(
        request: FastifyRequest,
        reply: FastifyReply,
    ): Promise<FastifyReply> {
        const { album } = request.query as { album?: string };
        if (album === undefined) {
            return reply.code(400).send({ error: "missing 'album' query parameter" });
        }

        const art = await resolver.resolve(album);
        if (art === null) {
            return reply.code(404).send({ error: 'no art for that album' });
        }

        const etag = etagFor(art);
        reply
            .header('etag', etag)
            .header('cache-control', `public, max-age=${ART_MAX_AGE_S}`)
            .header('content-type', contentTypeFor(art.path));

        // A repeat visit revalidates for free rather than re-sending ~540KB.
        if (request.headers['if-none-match'] === etag) {
            return reply.code(304).send();
        }

        reply.header('content-length', String(art.size));
        return reply.send(createReadStream(art.path));
    };
}
