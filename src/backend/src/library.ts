/**
 * Browsing the library: artists, an artist's albums, an album's tracks.
 *
 * Everything here is derived from MPD's in-memory tag database, never from the
 * NFS share. That is not a performance preference — the share is mounted
 * `noauto,x-systemd.automount` with a 10 minute idle timeout, so it is routinely
 * not mounted at all, and the whole box is built around the NAS being allowed to
 * be off. The tag database survives that; the filesystem does not. (Cover art is
 * the one exception, and it is allowed to 404 for exactly this reason.)
 *
 * WHAT WAS MEASURED, AND WHAT IT RULED OUT
 *   Against the real library — 37,289 songs, 2,757 albums, 487 artists:
 *
 *     listallinfo                        MPD CLOSES THE CONNECTION after 112ms.
 *                                        Its output buffer overflows. A single
 *                                        full dump of this library is impossible,
 *                                        so there is no "load it all once" design
 *                                        to be had.
 *     list album group albumartist       80ms, every artist and album count
 *     lsinfo ""                          3ms, 486 artist directories
 *     find albumartist "X" window 0:1    11.4ms EACH — 5.6s for all 487
 *     find base "X" window 0:1           0.23ms EACH — 111ms for all 486
 *     walking the tree with lsinfo       12.6s over 3,894 calls
 *
 *   The 50x gap between the two `find`s is the whole design. A tag filter scans
 *   every song; `base` is a path prefix and is indexed. So the index below asks
 *   MPD 488 questions and still costs about 200ms.
 *
 * WHY THERE IS AN INDEX AT ALL
 *   Only for the artists list, and only for one field: the image. An artist's
 *   picture lives in the artist's DIRECTORY, and MPD's tag database talks in
 *   names. 48 of 487 names differ from their directory (`AC/DC` is filed under
 *   `AC-DC`), so the two must be joined rather than transformed into each other.
 *   The artist and album screens need no index — each is a single `find`.
 */

import type { AlbumSummary, ArtistSummary, Track } from '../../shared/api.ts';
import { artUriForDir } from './art.ts';
import { groupBy } from './mpd/protocol.ts';
import type { LibrarySong, MpdBridge } from './mpd/bridge.ts';

/**
 * Synology litters the share with these and MPD indexes the share, not our idea
 * of it. `setup-mpd.sh` already keeps them out of the scan; this keeps any that
 * slip through out of the artist list. Same list as art.ts, same reason.
 */
const JUNK_DIRS = ['@eaDir', '#recycle'];

/**
 * The artist directory a song lives in: the FIRST path segment.
 *
 * NOT `dirname` applied twice, which is the obvious-looking version and is wrong.
 * 149 albums here keep their tracks in a disc subdirectory, so a path can be
 * `Black Sabbath/13 (2013)/CD 01/01.flac` — two dirnames gives `Black Sabbath/13
 * (2013)`, the album. The library is `Artist/...` all the way down, and that was
 * verified for all 487 artists: every first segment is a real top-level directory.
 */
export function artistDirOf(file: string): string {
    const slash = file.indexOf('/');
    return slash === -1 ? '' : file.slice(0, slash);
}

/**
 * Group a `find albumartist "<name>"` reply into albums.
 *
 * Takes LibrarySongs rather than Tracks because the album's genres, label and
 * MusicBrainz ids are not on the wire per track — see LibrarySong. Everything
 * here is folded from rows already fetched; nothing asks MPD a second question.
 *
 * Grouped by the ALBUM TAG rather than by directory. The two nearly always
 * agree, and where they do not — a multi-disc album spread over `CD 01` and
 * `CD 02` — the tag is right and the directory would split one album in two.
 *
 * The album's art comes from the first track's own album directory, which for
 * those multi-disc albums is the disc directory. That is correct here rather
 * than merely tolerable: all 149 of them carry a cover inside the disc
 * directory, measured.
 */
export function albumsFromSongs(albumArtist: string, songs: LibrarySong[]): AlbumSummary[] {
    const byAlbum = new Map<string, AlbumSummary>();
    // Disc numbers per album, and whether a track has gone by with no duration.
    const discs = new Map<string, Set<string>>();
    const undurated = new Set<string>();
    for (const song of songs) {
        const track = song.track;
        const album = track.album;
        if (album === undefined) continue; // untagged; there is nothing to file it under
        if (track.duration === undefined) undurated.add(album);
        let seenDiscs = discs.get(album);
        if (seenDiscs === undefined) discs.set(album, (seenDiscs = new Set()));
        if (track.disc !== undefined) seenDiscs.add(track.disc);

        const existing = byAlbum.get(album);
        if (existing === undefined) {
            byAlbum.set(album, {
                album,
                albumArtist,
                date: releaseDateOf(track),
                trackCount: 1,
                genres: song.genres,
                discCount: 1,
                duration: track.duration ?? 0,
                ...(song.label === undefined ? {} : { label: song.label }),
                ...(song.mbAlbumId === undefined ? {} : { mbAlbumId: song.mbAlbumId }),
                ...(song.mbReleaseGroupId === undefined
                    ? {}
                    : { mbReleaseGroupId: song.mbReleaseGroupId }),
                image: track.image,
            });
            continue;
        }
        existing.trackCount += 1;
        if (existing.duration !== null) existing.duration += track.duration ?? 0;
        // First non-empty date wins. Tracks on one album occasionally disagree —
        // a remaster year on a bonus track — and the first is the album proper.
        if (existing.date === null) existing.date = releaseDateOf(track);
        // The same rule for the rest: the first track that has one is the album's.
        if (existing.genres.length === 0) existing.genres = song.genres;
        if (existing.label === undefined && song.label !== undefined) {
            existing.label = song.label;
        }
        if (existing.mbAlbumId === undefined && song.mbAlbumId !== undefined) {
            existing.mbAlbumId = song.mbAlbumId;
        }
        if (existing.mbReleaseGroupId === undefined && song.mbReleaseGroupId !== undefined) {
            existing.mbReleaseGroupId = song.mbReleaseGroupId;
        }
    }
    for (const summary of byAlbum.values()) {
        // Never 0: an album with no Disc tag at all is still one disc.
        summary.discCount = Math.max(1, discs.get(summary.album)?.size ?? 1);
        // All or nothing. A sum that quietly skips the untagged tracks is a
        // wrong number presented as a right one.
        if (undurated.has(summary.album)) summary.duration = null;
    }
    return [...byAlbum.values()].sort(compareAlbums);
}

/**
 * When the album came out: `OriginalDate` if the track has it, else `Date`.
 *
 * THE PREFERENCE IS LOAD-BEARING, not a nicety. `Date` is the year of the
 * pressing. Measured across all 2,758 albums here: 2,726 carry `OriginalDate`
 * and **940 of those disagree with `Date`** — AC/DC's whole catalogue is stamped
 * 2020, `Back in Black` is 2003 against 1980, `All Eyez on Me` 2001 against
 * 1996. An artist page sorted on `Date` is therefore wrong for a third of this
 * library, and visibly so: the year on screen would contradict the year in the
 * folder name on disk.
 */
function releaseDateOf(track: Track): string | null {
    return track.originalDate ?? track.date ?? null;
}

/**
 * Oldest first, undated last, ties broken by title.
 *
 * `date` is free text, not a number: MPD hands back `1997`, `1997-06-16` and
 * worse, so the comparison is on the leading four digits and anything without
 * them sorts as undated. 18 of 2,757 albums here carry no date at all, and they
 * go to the END rather than to year zero — an unknown year is not 0 AD, and
 * putting them first would bury a real album under them on every artist page.
 */
function compareAlbums(a: AlbumSummary, b: AlbumSummary): number {
    const ya = yearOf(a.date);
    const yb = yearOf(b.date);
    if (ya !== yb) {
        if (ya === null) return 1;
        if (yb === null) return -1;
        return ya - yb;
    }
    // Same year: fall back to the whole string, which is ISO-ish and therefore
    // orders correctly as text — two 1976 AC/DC records are May and September.
    // The year is still compared first because the string is free text and a
    // malformed one must not be allowed to reorder well-formed years around it.
    if (a.date !== null && b.date !== null && a.date !== b.date) {
        return a.date < b.date ? -1 : 1;
    }
    return a.album.localeCompare(b.album);
}

function yearOf(date: string | null): number | null {
    if (date === null) return null;
    const match = /^(\d{4})/.exec(date);
    return match ? Number(match[1]) : null;
}

/**
 * An album's tracks in playing order: directory, then disc, then track number.
 *
 * A flat list — the client groups it — but every disc's tracks are contiguous
 * within it. See comparePlayingOrder for why all three keys are needed.
 *
 * `Track` and `Disc` are strings on the wire and `Track` is sometimes `4/12`, so
 * both are parsed to a leading integer rather than compared as text, which would
 * order 10 before 2.
 */
export function sortAlbumTracks(tracks: Track[]): Track[] {
    return [...tracks].sort(comparePlayingOrder);
}

/** The same order, for the songs the browse path actually carries. */
export function sortAlbumSongs(songs: LibrarySong[]): LibrarySong[] {
    return [...songs].sort((a, b) => comparePlayingOrder(a.track, b.track));
}

/**
 * Directory, then disc, then track number.
 *
 * ALL THREE ARE LOAD-BEARING. 313 albums here span more than one disc and only
 * 149 of them keep the discs in separate directories; for the other 164 every
 * track shares one directory, so directory-then-track sorts purely on the track
 * number and interleaves the discs — three tracks numbered 1, then three
 * numbered 2. Disc has to come between the two.
 *
 * It cannot replace the directory either: where the discs ARE separate
 * directories, the directory is what the filenames agree with. The two never
 * disagree — `CD 01` holds disc 1 — so disc as the middle key is free there.
 */
function comparePlayingOrder(a: Track, b: Track): number {
    const da = dirOf(a.file);
    const db = dirOf(b.file);
    if (da !== db) return da.localeCompare(db);
    const ca = trackNo(a.disc);
    const cb = trackNo(b.disc);
    if (ca !== cb) return ca - cb;
    const ta = trackNo(a.track);
    const tb = trackNo(b.track);
    if (ta !== tb) return ta - tb;
    return (a.file ?? '').localeCompare(b.file ?? '');
}

function dirOf(file: string | undefined): string {
    if (file === undefined) return '';
    const slash = file.lastIndexOf('/');
    return slash === -1 ? '' : file.slice(0, slash);
}

/** Untagged sorts last, not as track zero. */
function trackNo(track: string | undefined): number {
    if (track === undefined) return Number.MAX_SAFE_INTEGER;
    const n = parseInt(track, 10);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * The artist's picture, from any one of their tracks.
 *
 * Null for an artist with no tracks, and for one whose files sit at the library
 * root — there is no artist directory to look in, and a guessed one would be a
 * confidently wrong picture rather than an obvious missing one.
 */
export function artistImageOf(songs: LibrarySong[]): string | null {
    const file = songs.find((s) => s.track.file !== undefined)?.track.file;
    if (file === undefined) return null;
    const dir = artistDirOf(file);
    return dir === '' ? null : artUriForDir(dir);
}

export interface Library {
    /** The browse list. Built once, then served from memory until invalidated. */
    artists: () => Promise<ArtistSummary[]>;
    albumsOf: (albumArtist: string) => Promise<{ image: string | null; albums: AlbumSummary[] }>;
    /** The album's songs, in playing order. Routes take `.track` for the wire. */
    songsOf: (albumArtist: string, album: string) => Promise<LibrarySong[]>;
    /** Drop the cached index. Called when MPD reports a database update. */
    invalidate: () => void;
    /** Test seam: how many index builds have actually run. */
    builds: () => number;
}

export function createLibrary(bridge: MpdBridge): Library {
    let cached: ArtistSummary[] | null = null;
    let building: Promise<ArtistSummary[]> | null = null;
    /** Bumped by invalidate(), so a build that started before it cannot win. */
    let generation = 0;
    let builds = 0;

    async function build(): Promise<ArtistSummary[]> {
        builds += 1;

        // 1. Names and album counts. This reply is also what sets the ORDER of
        //    the whole screen: MPD returns it sorted by AlbumArtist, and that
        //    plain A-Z is what the list shows. No second opinion about sorting
        //    is applied here — one would have to be maintained forever, and
        //    "should The Panics be under T" has no answer worth owning.
        const counts = new Map<string, number>();
        const order: string[] = [];
        //    Read the pairs directly rather than through groupBy: a grouped
        //    reply repeats `Album` within one artist, and groupBy builds a Map
        //    per group, where repeated keys overwrite each other. Counting them
        //    is exactly what is wanted here, so the flat stream is the right
        //    shape — `AlbumArtist` opens a group, every `Album` until the next
        //    one belongs to it.
        let current: string | null = null;
        for (const [key, value] of (await bridge.list('album', 'albumartist')).pairs) {
            if (key === 'AlbumArtist') {
                // An empty value is MPD's group for albums with no AlbumArtist
                // tag. Null here, so its albums are counted against nobody
                // rather than against whichever artist happened to precede it.
                current = value === '' ? null : value;
                if (current !== null && !counts.has(current)) {
                    order.push(current);
                    counts.set(current, 0);
                }
            } else if (key === 'Album' && current !== null) {
                counts.set(current, (counts.get(current) ?? 0) + 1);
            }
        }

        // 1b. Songs and playtime per artist, for all 488 in ONE command — 35ms
        //     measured, against a build that already costs ~200ms. Same flat
        //     pair stream as above: `AlbumArtist` opens a group, `songs` and
        //     `playtime` follow it.
        const totals = new Map<string, { songs: number; playtime: number }>();
        let group: string | null = null;
        for (const [key, value] of (await bridge.count('albumartist')).pairs) {
            if (key === 'AlbumArtist') {
                group = value === '' ? null : value;
                if (group !== null) totals.set(group, { songs: 0, playtime: 0 });
            } else if (group !== null) {
                const into = totals.get(group);
                if (into === undefined) continue;
                if (key === 'songs') into.songs = Number(value) || 0;
                else if (key === 'playtime') into.playtime = Number(value) || 0;
            }
        }

        // 2 and 3. The join: for each directory, ask MPD for one song inside it
        //    and read the AlbumArtist off that song. `base` is an indexed path
        //    prefix — 0.23ms a call against 11.4ms for the tag filter, which is
        //    what makes asking 486 separate questions reasonable.
        const dirs = new Map<string, string>();
        const mbids = new Map<string, string>();
        for (const entry of groupBy(await bridge.lsinfo(''), 'directory')) {
            const dir = entry.get('directory');
            if (dir === undefined || JUNK_DIRS.includes(dir)) continue;
            // findFirstSong rather than findFirst: the MusicBrainz id rides
            // along on a song we are already fetching, so it costs nothing.
            const song = await bridge.findFirstSong(['base', dir]);
            const name = song?.track.albumArtist ?? song?.track.artist;
            // First directory wins. Two directories claiming one name is a
            // tagging mistake in the library, not something to represent.
            if (name !== undefined && !dirs.has(name)) {
                dirs.set(name, dir);
                if (song?.mbArtistId !== undefined) mbids.set(name, song.mbArtistId);
            }
        }

        return order.map((name) => {
            const directory = dirs.get(name);
            const total = totals.get(name);
            const mbArtistId = mbids.get(name);
            return {
                name,
                directory: directory ?? '',
                albumCount: counts.get(name) ?? 0,
                trackCount: total?.songs ?? 0,
                // Null, not 0, when MPD reports nothing: an artist whose
                // playtime is unknown has not been listened to for no seconds.
                duration: total === undefined || total.playtime === 0 ? null : total.playtime,
                ...(mbArtistId === undefined ? {} : { mbArtistId }),
                // Null rather than a guessed URI when no directory was found.
                // The client shows its placeholder, which is the same thing it
                // does for the 16 artists whose directory has no image file.
                image: directory === undefined ? null : artUriForDir(directory),
            };
        });
    }

    return {
        builds: () => builds,
        invalidate: () => {
            cached = null;
            building = null;
            // A build already in flight must not install its result: it read the
            // library BEFORE the scan that just invalidated it, and dropping the
            // promise is not enough to stop its `.then`. That would cache a stale
            // list for the life of the process.
            generation += 1;
        },
        artists: async () => {
            if (cached !== null) return cached;
            // Share one build between concurrent callers. The panel and a phone
            // opening the library at the same moment would otherwise each run
            // 488 MPD commands.
            if (building === null) {
                const mine = generation;
                building = build()
                    .then((artists) => {
                        if (mine === generation) cached = artists;
                        return artists;
                    })
                    .finally(() => {
                        if (mine === generation) building = null;
                    });
            }
            return building;
        },
        albumsOf: async (albumArtist) => {
            const songs = await bridge.findSongs(['albumartist', albumArtist]);
            return {
                // From a track we already have, so this costs no MPD command and
                // does not touch the index. `artistDirOf` is the first path
                // segment — see its note for why not two dirnames.
                image: artistImageOf(songs),
                albums: albumsFromSongs(albumArtist, songs),
            };
        },
        songsOf: async (albumArtist, album) =>
            sortAlbumSongs(await bridge.findSongs(['albumartist', albumArtist], ['album', album])),
    };
}
