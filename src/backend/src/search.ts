/**
 * Library search: matched in memory, ranked here. Not MPD's `search`, which
 * does not fold accents or punctuation — see decisions.md.
 */

import type {
    ArtistSummary,
    SearchAlbum,
    SearchGroup,
    SearchResponse,
    Track,
} from '../../shared/api.ts';
import { fold, squeeze } from '../../shared/api.ts';
import type { Library } from './library.ts';
import { releaseDateOf } from './library.ts';
import type { LibrarySong, MpdBridge } from './mpd/bridge.ts';
import type { Reply } from './mpd/protocol.ts';

export const SEARCH_LIMITS = { artist: 5, album: 5, track: 10 } as const;

/** A name, folded once at build time rather than on every search. */
interface Keyed {
    folded: string;
    squeezed: string;
}

export interface AlbumEntry extends Keyed {
    albumArtist: string;
    album: string;
    mbAlbumId: string | null;
}

export interface TrackEntry extends Keyed {
    albumArtist: string;
    album: string;
    title: string;
}

export interface SearchIndex {
    albums: AlbumEntry[];
    tracks: TrackEntry[];
}

function keyed(text: string): Keyed {
    const folded = fold(text);
    return { folded, squeezed: squeeze(folded) };
}

/** The query, folded the way the index is. */
export function needleOf(query: string): Keyed {
    return keyed(query.trim());
}

const WORD = /[\p{L}\p{N}]/u;

/** 5 exact, 4 leading whole words, 3 prefix, 2 start of a word, 1 anywhere, 0 not at all. */
export function scoreKeyed(needle: Keyed, text: Keyed): number {
    const n = needle.folded;
    if (n === '') return 0;
    const t = text.folded;
    if (t === n) return 5;
    // `The Top` over `Them` for "the".
    if (t.startsWith(n)) return WORD.test(t[n.length]) ? 3 : 4;
    for (let at = t.indexOf(n); at !== -1; at = t.indexOf(n, at + 1)) {
        if (at === 0 || !WORD.test(t[at - 1])) return 2;
    }
    if (t.includes(n)) return 1;
    // `acdc` for `AC/DC`. `!!!` squeezes to '', which would match everything.
    const sn = needle.squeezed;
    if (sn === '') return 0;
    if (text.squeezed === sn) return 5;
    if (text.squeezed.startsWith(sn)) return 3;
    return text.squeezed.includes(sn) ? 1 : 0;
}

export function scoreMatch(query: string, text: string): number {
    return scoreKeyed(needleOf(query), keyed(text));
}

/**
 * Leaf values with the group values current at each, from a grouped `list`.
 * Groups arrive only when they change, so they are carried forward.
 */
export function groupedRows(reply: Reply, leaf: string, groups: string[]): Array<Record<string, string>> {
    const current: Record<string, string> = {};
    const rows: Array<Record<string, string>> = [];
    for (const [key, value] of reply.pairs) {
        if (key === leaf) rows.push({ ...current, [leaf]: value });
        else if (groups.includes(key)) current[key] = value;
    }
    return rows;
}

export async function buildIndex(bridge: Pick<MpdBridge, 'list'>): Promise<SearchIndex> {
    const albums = groupedRows(
        await bridge.list('album', 'albumartist', 'MUSICBRAINZ_ALBUMID'),
        'Album',
        ['AlbumArtist', 'MUSICBRAINZ_ALBUMID'],
    )
        // The library screens need an album artist to open anything.
        .filter((row) => row.AlbumArtist && row.Album)
        .map((row) => ({
            albumArtist: row.AlbumArtist,
            album: row.Album,
            mbAlbumId: row.MUSICBRAINZ_ALBUMID || null,
            ...keyed(row.Album),
        }));
    const tracks = groupedRows(await bridge.list('title', 'album', 'albumartist'), 'Title', ['AlbumArtist', 'Album'])
        .filter((row) => row.AlbumArtist && row.Album && row.Title)
        .map((row) => ({
            albumArtist: row.AlbumArtist,
            album: row.Album,
            title: row.Title,
            ...keyed(row.Title),
        }));
    return { albums, tracks };
}

export interface Scored<T> {
    item: T;
    score: number;
    length: number;
}

/** Best first; a shorter name is the closer match; then `tiebreak`. */
function best<T>(rows: Scored<T>[], limit: number, tiebreak?: (a: T, b: T) => number): Scored<T>[] {
    return rows
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || a.length - b.length || (tiebreak?.(a.item, b.item) ?? 0))
        .slice(0, limit);
}

export interface Matches {
    artists: Scored<ArtistSummary>[];
    albums: Scored<AlbumEntry>[];
    tracks: Scored<TrackEntry>[];
}

export function match(query: string, artists: ArtistSummary[], index: SearchIndex): Matches {
    const needle = needleOf(query);
    return {
        artists: best(
            artists.map((item) => ({ item, score: scoreKeyed(needle, keyed(item.name)), length: item.name.length })),
            SEARCH_LIMITS.artist,
            (a, b) => b.trackCount - a.trackCount,
        ),
        albums: best(
            index.albums.map((item) => ({ item, score: scoreKeyed(needle, item), length: item.album.length })),
            SEARCH_LIMITS.album,
        ),
        tracks: best(
            index.tracks.map((item) => ({ item, score: scoreKeyed(needle, item), length: item.title.length })),
            SEARCH_LIMITS.track,
        ),
    };
}

/** Each group best first, the groups by their best; a tie keeps artist, album, track. */
export function orderGroups(groups: Array<{ group: SearchGroup; best: number }>): SearchGroup[] {
    return groups
        .filter(({ group }) => group.items.length > 0)
        .sort((a, b) => b.best - a.best)
        .map(({ group }) => group);
}

function albumOf(song: LibrarySong): SearchAlbum | null {
    const { album, albumArtist, release } = song.track;
    if (album === undefined || albumArtist === undefined || release === undefined) return null;
    return { album, albumArtist, release, date: releaseDateOf(song.track), image: song.track.image };
}

export interface Search {
    search: (query: string) => Promise<SearchResponse>;
    /** Drop the index. Called alongside Library.invalidate. */
    invalidate: () => void;
}

export function createSearch(
    library: Pick<Library, 'artists'>,
    bridge: Pick<MpdBridge, 'list' | 'findFirstSong'>,
): Search {
    let cached: SearchIndex | null = null;
    let building: Promise<SearchIndex> | null = null;
    let generation = 0;

    // Shared between concurrent callers; a build that a scan overtook is not kept.
    function index(): Promise<SearchIndex> {
        if (cached !== null) return Promise.resolve(cached);
        if (building === null) {
            const mine = generation;
            building = buildIndex(bridge)
                .then((built) => {
                    if (mine === generation) cached = built;
                    return built;
                })
                .finally(() => {
                    if (mine === generation) building = null;
                });
        }
        return building;
    }

    return {
        invalidate: () => {
            cached = null;
            building = null;
            generation += 1;
        },
        search: async (query) => {
            const needle = query.trim();
            // In turn, not in parallel: there is one command connection to MPD.
            const artists = await library.artists();
            const found = match(needle, artists, await index());

            const albums: Scored<SearchAlbum>[] = [];
            for (const hit of found.albums) {
                const { albumArtist, album, mbAlbumId } = hit.item;
                const song = mbAlbumId === null
                    ? await bridge.findFirstSong(['albumartist', albumArtist], ['album', album])
                    : await bridge.findFirstSong(['MUSICBRAINZ_ALBUMID', mbAlbumId]);
                const resolved = song === null ? null : albumOf(song);
                if (resolved !== null) albums.push({ ...hit, item: resolved });
            }
            const tracks: Scored<Track>[] = [];
            for (const hit of found.tracks) {
                const { albumArtist, album, title } = hit.item;
                const song = await bridge.findFirstSong(
                    ['albumartist', albumArtist],
                    ['album', album],
                    ['title', title],
                );
                if (song !== null) tracks.push({ ...hit, item: song.track });
            }

            const groups = orderGroups([
                { group: { kind: 'artist', items: found.artists.map((r) => r.item) }, best: found.artists[0]?.score ?? 0 },
                { group: { kind: 'album', items: albums.map((r) => r.item) }, best: albums[0]?.score ?? 0 },
                { group: { kind: 'track', items: tracks.map((r) => r.item) }, best: tracks[0]?.score ?? 0 },
            ]);
            return { query: needle, groups };
        },
    };
}
