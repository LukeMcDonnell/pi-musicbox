/**
 * What the NAS's `.nfo` sidecars say, harvested into SQLite after a scan.
 *
 * WHY HARVESTED AND NOT READ ON DEMAND
 *   `/api/art` reads the share when a client asks and is allowed to 404, because
 *   a missing cover shows a placeholder and nobody is misled. A rating is not
 *   like that: the share is mounted `noauto,x-systemd.automount` with a 10 minute
 *   idle timeout, so it is routinely not mounted, and a number that silently
 *   disappeared whenever the NAS slept would look like a bug. So it is read once,
 *   behind the same reachability guard that gates a scan, and served from the
 *   local database forever after.
 *
 * WHAT IS TAKEN, AND WHY SO LITTLE
 *   Measured on this library: `album.nfo` is almost entirely a duplicate of tags
 *   MPD already has — title, releasedate, label (3,192 of 3,262 files, against
 *   97.5% from the tags) and the MusicBrainz ids are all already on AlbumSummary.
 *   The only facts MPD's tag database lacks are the RATING and the BIOGRAPHY.
 *   Harvested against the real library: 445 of 506 artists and 2,613 of 3,062
 *   albums carry a rating, and just 60 artists carry a biography. Falling back
 *   to an album's `<artistdesc>` is most of that 60 — on its own, `artist.nfo`
 *   yields only 51. See decisions.md for why it is not the 107 the files on
 *   disk suggest.
 *
 * WHY THE DIRECTORIES COME FROM MPD
 *   A recursive walk of the share for `*.nfo` costs 55 seconds, measured, and
 *   would have to learn to skip `@eaDir` and `#recycle` for itself. MPD already
 *   knows the tree and answers from memory, and its directory strings are the
 *   very ones `/api/art` is keyed by — so asking it is faster AND removes any
 *   chance of this file holding a second opinion about what the library contains.
 */

import { open, stat } from 'node:fs/promises';
import type { Db } from './db.ts';
import { NFO_MAX_BYTES, parseNfo, type Nfo } from './nfo.ts';
import { groupBy, type Reply } from './mpd/protocol.ts';
import { safeJoin } from './static.ts';

/** Synology litters the share with these. Same list as art.ts and library.ts. */
const JUNK_DIRS = ['@eaDir', '#recycle'];

export const ARTIST_NFO = 'artist.nfo';
export const ALBUM_NFO = 'album.nfo';

/** Structural, so the tests never open a socket. */
export interface NotesBridge {
    lsinfo(path: string): Promise<Reply>;
}

/** One directory's note. Both fields may be null; the row exists either way. */
export interface LibraryNote {
    rating: number | null;
    biography: string | null;
}

export interface HarvestResult {
    artists: number;
    albums: number;
    ratings: number;
    biographies: number;
    /** Reads that failed for a reason other than "no such file". */
    failures: number;
    pruned: number;
    ms: number;
}

/** Injected in tests, so nothing here needs a real NFS mount. */
export interface NotesDeps {
    /** The file's text, or null when there is no such file. Throws if unwell. */
    readNfo: (path: string) => Promise<string | null>;
    /** Whether the music root is there at all. */
    rootReadable: (root: string) => Promise<boolean>;
}

/**
 * Read at most NFO_MAX_BYTES.
 *
 * A handle and one bounded read rather than `readFile`, so a pathological file
 * on the share cannot pull ten megabytes into this process. It is the same
 * single round trip over NFS either way.
 *
 * ENOENT IS NOT AN ERROR AND EVERYTHING ELSE IS. That distinction is the whole
 * safety of the prune below: a directory with no `album.nfo` is ordinary, and an
 * EIO from a soft mount whose NAS went away mid-harvest is not.
 */
async function readNfoFile(path: string): Promise<string | null> {
    let fh;
    try {
        fh = await open(path, 'r');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
    }
    try {
        const buf = Buffer.allocUnsafe(NFO_MAX_BYTES);
        const { bytesRead } = await fh.read(buf, 0, NFO_MAX_BYTES, 0);
        return buf.toString('utf8', 0, bytesRead);
    } finally {
        await fh.close();
    }
}

/** Exported only so the ENOENT-versus-everything-else rule can be tested for real. */
export const realNotesDeps: NotesDeps = {
    readNfo: readNfoFile,
    rootReadable: async (root) => {
        try {
            return (await stat(root)).isDirectory();
        } catch {
            return false;
        }
    },
};

export interface LibraryNotesOptions {
    db: Db;
    bridge: NotesBridge;
    musicRoot: string;
    log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
    now?: () => number;
    deps?: NotesDeps;
}

export interface LibraryNotes {
    /** Cheap: one primary-key lookup. Null when nothing has been harvested for it. */
    forArtist(directory: string): LibraryNote | null;
    forAlbum(directory: string): LibraryNote | null;
    /** How many rows are stored. Startup uses it to decide whether to harvest. */
    count(): number;
    harvest(): Promise<HarvestResult>;
}

interface NoteRow {
    rating: number | null;
    biography: string | null;
}

/** The directories under `path`, junk removed. MPD gives full relative paths. */
function directoriesOf(reply: Reply): string[] {
    const dirs: string[] = [];
    for (const entry of groupBy(reply, 'directory')) {
        const dir = entry.get('directory');
        if (dir === undefined) continue;
        if (dir.split('/').some((segment) => JUNK_DIRS.includes(segment))) continue;
        dirs.push(dir);
    }
    return dirs;
}

export function createLibraryNotes(options: LibraryNotesOptions): LibraryNotes {
    const { db, bridge, musicRoot } = options;
    const log = options.log ?? (() => {});
    const now = options.now ?? Date.now;
    const deps = options.deps ?? realNotesDeps;

    const read = (directory: string, kind: 'artist' | 'album'): LibraryNote | null => {
        const row = db.get<NoteRow>(
            'SELECT rating, biography FROM library_note WHERE directory = ? AND kind = ?',
            directory,
            kind,
        );
        return row === undefined ? null : { rating: row.rating, biography: row.biography };
    };

    /** Read one `.nfo`, or null. A failure is counted, logged once, and survived. */
    const readOne = async (
        directory: string,
        name: string,
        failures: { count: number },
    ): Promise<Nfo | null> => {
        const path = safeJoin(musicRoot, `/${directory}/${name}`);
        // safeJoin returning null means the directory tried to escape the music
        // root. MPD should never hand us such a thing; refuse it if it does.
        if (path === null) return null;
        try {
            const text = await deps.readNfo(path);
            return text === null ? null : parseNfo(text);
        } catch (err) {
            failures.count += 1;
            if (failures.count === 1) {
                log('warn', `nfo read failed for ${directory}: ${(err as Error).message}`);
            }
            return null;
        }
    };

    return {
        forArtist: (directory) => read(directory, 'artist'),
        forAlbum: (directory) => read(directory, 'album'),

        count: () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM library_note')?.n ?? 0,

        async harvest(): Promise<HarvestResult> {
            const began = now();
            const result: HarvestResult = {
                artists: 0,
                albums: 0,
                ratings: 0,
                biographies: 0,
                failures: 0,
                pruned: 0,
                ms: 0,
            };

            // Gate on the root the way canScan() does. Without this a music root
            // that is simply absent reads as 508 ENOENTs — "no nfo anywhere" —
            // and the prune below would then empty a perfectly good table.
            if (!(await deps.rootReadable(musicRoot))) {
                log('warn', 'nfo harvest skipped: the music share is not reachable');
                result.ms = now() - began;
                return result;
            }

            const failures = { count: 0 };
            const seen = new Set<string>();
            const artistDirs = directoriesOf(await bridge.lsinfo(''));

            for (const artistDir of artistDirs) {
                const artist = await readOne(artistDir, ARTIST_NFO, failures);

                // The albums first, because an album's <artistdesc> is the
                // fallback for an artist with no biography of their own, and
                // most of the 60 artists who end up with any text get it here.
                // Empty is not a fallback: 2,723 of 3,262 `<artistdesc>` are
                // self-closing, and parseNfo returns those as absent.
                const rows: Array<[string, Nfo]> = [];
                let desc: string | undefined;
                for (const albumDir of directoriesOf(await bridge.lsinfo(artistDir))) {
                    const album = await readOne(albumDir, ALBUM_NFO, failures);
                    if (album === null) continue;
                    rows.push([albumDir, album]);
                    desc ??= album.artistDesc;
                }

                const biography = artist?.biography ?? desc ?? null;
                const at = now();

                // One transaction per artist, not one for the whole harvest: a
                // single write lock held across a minute of NFS reads would block
                // a settings change on a box that is otherwise idle.
                db.transaction(() => {
                    if (artist !== null || biography !== null) {
                        upsert(db, artistDir, 'artist', artist?.rating ?? null, biography, at);
                        result.artists += 1;
                        if (artist?.rating !== undefined) result.ratings += 1;
                        if (biography !== null) result.biographies += 1;
                        seen.add(artistDir);
                    }
                    for (const [albumDir, album] of rows) {
                        upsert(db, albumDir, 'album', album.rating ?? null, null, at);
                        result.albums += 1;
                        if (album.rating !== undefined) result.ratings += 1;
                        seen.add(albumDir);
                    }
                });
            }

            result.failures = failures.count;

            // PRUNE ONLY AFTER A CLEAN RUN. A soft NFS mount returns EIO part way
            // through a walk, and a harvest that gave up half way would otherwise
            // delete every row it had not reached yet — throwing away good data
            // because the NAS blinked.
            if (failures.count === 0) {
                const stale = db
                    .all<{ directory: string }>('SELECT directory FROM library_note')
                    .filter((row) => !seen.has(row.directory));
                if (stale.length > 0) {
                    db.transaction(() => {
                        for (const row of stale) {
                            db.run('DELETE FROM library_note WHERE directory = ?', row.directory);
                        }
                    });
                    result.pruned = stale.length;
                }
            }

            result.ms = now() - began;
            log(
                failures.count === 0 ? 'info' : 'warn',
                `nfo harvest: ${result.artists} artists, ${result.albums} albums, ` +
                    `${result.ratings} ratings, ${result.biographies} biographies, ` +
                    `${result.pruned} pruned, ${failures.count} failed, in ` +
                    `${Math.round(result.ms / 1000)}s`,
            );
            return result;
        },
    };
}

function upsert(
    db: Db,
    directory: string,
    kind: 'artist' | 'album',
    rating: number | null,
    biography: string | null,
    at: number,
): void {
    db.run(
        'INSERT INTO library_note (directory, kind, rating, biography, read_at) VALUES (?, ?, ?, ?, ?) ' +
            'ON CONFLICT(directory) DO UPDATE SET ' +
            'kind = excluded.kind, rating = excluded.rating, ' +
            'biography = excluded.biography, read_at = excluded.read_at',
        directory,
        kind,
        rating,
        biography,
        at,
    );
}
