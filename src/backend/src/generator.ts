/**
 * The playlist generator: filters in, tracks out. Matched in memory over an
 * index of every song, built once and kept until a scan or a harvest changes it.
 * See .claude/docs/decisions.md.
 */

import {
    GENERATOR_LENGTHS,
    GENERATOR_LISTS,
    fold,
    type GeneratorFilters,
    type GeneratorGenre,
    type GeneratorList,
    type GeneratorOptions,
    type Range,
} from '../../shared/api.ts';
import type { InfoLookup } from './library.ts';
import { SIMILAR_LIMIT, releaseDateOf } from './library.ts';
import type { SimilarArtist } from './enrich.ts';
import type { LibrarySong } from './mpd/bridge.ts';

/** Songs per `find` window: the size `songsByAdded` already pages in. */
export const INDEX_PAGE = 1000;
export const GENERATOR_MAX_LENGTH = Math.max(...GENERATOR_LENGTHS);
/** How many artists "Most Played Artists" means. */
export const MOST_PLAYED_ARTISTS = 25;
/** How many albums "Recently Added Albums" means: the Home shelf's screen. */
export const RECENTLY_ADDED_ALBUMS = 100;
const MAX_NAMES = 2_000;

export interface Entry {
    file: string;
    albumArtist: string;
    release: string | null;
    year: number | null;
    /** Folded, for matching. */
    genres: string[];
    recordingId: string | null;
    /** 0–100 within the album artist, or null when nothing is known. */
    popularity: number | null;
    /** 0–100 across the library, or null when nothing is known. */
    libraryPopularity: number | null;
}

export interface GeneratorIndex {
    entries: Entry[];
    options: GeneratorOptions;
    /** Album artist name to its MusicBrainz ids; Queen carry two. */
    artistIds: Map<string, string[]>;
}

/**
 * The library's artists similar to these, as the artist screen picks them: the
 * first SIMILAR_LIMIT the library holds, per artist. The chosen ones are left out.
 */
export function relatedTo(
    names: readonly string[],
    artistIds: ReadonlyMap<string, readonly string[]>,
    similarOf: (mbid: string) => readonly SimilarArtist[],
    limit = SIMILAR_LIMIT,
): Set<string> {
    const nameOf = new Map<string, string>();
    for (const [name, ids] of artistIds) for (const id of ids) nameOf.set(id, name);
    const chosen = new Set(names);
    const out = new Set<string>();
    for (const name of names) {
        const found = new Set<string>();
        for (const id of artistIds.get(name) ?? []) {
            for (const s of similarOf(id)) {
                if (found.size === limit) break;
                const other = nameOf.get(s.mbid);
                if (other !== undefined && other !== name) found.add(other);
            }
        }
        for (const other of found) if (!chosen.has(other)) out.add(other);
    }
    return out;
}

/** Where each list's members come from. Structural, so the tests need no database. */
export interface ListSources {
    favouriteReleases(): Iterable<string>;
    recentReleases(): Iterable<string>;
    mostPlayedArtists(): Iterable<string>;
    playedFiles(): Iterable<string>;
    recentlyAddedReleases(): Promise<Iterable<string>>;
}

/** Before the phonograph is a bad tag, not a year: the box's library has 43 tracks dated 0001. */
const FIRST_YEAR = 1877;

export function yearOf(date: string | null): number | null {
    const m = date === null ? null : /^(\d{4})/.exec(date);
    const year = m === null ? null : Number(m[1]);
    return year === null || year < FIRST_YEAR ? null : year;
}

/** Each id's percentile among these counts: 100 the most listened, 0 the least. */
function percentiles(counts: ReadonlyMap<string, number>): Map<string, number> {
    const sorted = [...counts.values()].sort((a, b) => a - b);
    const below = new Map<number, number>();
    sorted.forEach((n, i) => below.has(n) || below.set(n, i));
    const top = sorted.length - 1;
    const out = new Map<string, number>();
    for (const [id, n] of counts) out.set(id, top === 0 ? 100 : Math.round((100 * below.get(n)!) / top));
    return out;
}

/**
 * Percentiles over distinct recordings, within each album artist (keyed
 * `artist\0recording`) and across the library (keyed by recording). Raw counts
 * are too skewed to slide over — one hit can outweigh the rest of an album.
 */
export function popularityOf(
    rows: ReadonlyArray<{ albumArtist: string; recordingId: string | null }>,
    listens: ReadonlyMap<string, number>,
): { artist: Map<string, number>; library: Map<string, number> } {
    const byArtist = new Map<string, Map<string, number>>();
    for (const { albumArtist, recordingId } of rows) {
        if (recordingId === null) continue;
        let counts = byArtist.get(albumArtist);
        if (counts === undefined) byArtist.set(albumArtist, (counts = new Map()));
        counts.set(recordingId, listens.get(recordingId) ?? 0);
    }
    const artist = new Map<string, number>();
    const all = new Map<string, number>();
    for (const [name, counts] of byArtist) {
        // An artist with no counts at all was never asked about, which is not "unpopular".
        if (![...counts.values()].some((n) => n > 0)) continue;
        for (const [id, pct] of percentiles(counts)) artist.set(`${name}\0${id}`, pct);
        for (const [id, n] of counts) all.set(id, n);
    }
    return { artist, library: percentiles(all) };
}

export interface IndexBuilder {
    add(songs: readonly LibrarySong[]): void;
    finish(): GeneratorIndex;
}

/**
 * Fed a page at a time, so the full songs are never all held at once: holding
 * them took the server from 114MB to 411MB on the box. Repeated strings and
 * genre lists are shared between entries for the same reason.
 */
export function indexBuilder(info?: Pick<InfoLookup, 'artist' | 'listens'>): IndexBuilder {
    const entries: Entry[] = [];
    const strings = new Map<string, string>();
    const intern = (s: string): string => strings.get(s) ?? (strings.set(s, s), s);
    const genreLists = new Map<string, string[]>();
    const artistGenres = new Map<string, string[]>();
    const genreOfArtist = (mbid: string | undefined): string[] => {
        if (mbid === undefined || info === undefined) return [];
        let genres = artistGenres.get(mbid);
        if (genres === undefined) artistGenres.set(mbid, (genres = info.artist(mbid)?.genres ?? []));
        return genres;
    };
    // The spelling shown is whichever the most tracks use.
    const spellings = new Map<string, Map<string, number>>();
    const tracks = new Map<string, number>();
    let years: Range | null = null;
    const artistIds = new Map<string, Set<string>>();

    return {
        add(songs) {
            for (const song of songs) {
                const { file, albumArtist, release } = song.track;
                if (file === undefined || albumArtist === undefined) continue;
                const names = [...song.genres, ...genreOfArtist(song.mbArtistId)];
                const folded = [...new Set(names.map(fold))];
                const key = folded.join('\0');
                let genres = genreLists.get(key);
                if (genres === undefined) genreLists.set(key, (genres = folded.map(intern)));
                for (const name of names) {
                    const k = fold(name);
                    let spelt = spellings.get(k);
                    if (spelt === undefined) spellings.set(k, (spelt = new Map()));
                    spelt.set(name, (spelt.get(name) ?? 0) + 1);
                }
                for (const k of genres) tracks.set(k, (tracks.get(k) ?? 0) + 1);
                if (song.mbArtistId !== undefined) {
                    let ids = artistIds.get(albumArtist);
                    if (ids === undefined) artistIds.set(albumArtist, (ids = new Set()));
                    ids.add(song.mbArtistId);
                }
                const year = yearOf(releaseDateOf(song.track));
                if (year !== null) {
                    years = years === null ? { min: year, max: year } : { min: Math.min(years.min, year), max: Math.max(years.max, year) };
                }
                entries.push({
                    file,
                    albumArtist: intern(albumArtist),
                    release: release === undefined ? null : intern(release),
                    year,
                    genres,
                    recordingId: song.mbRecordingId ?? null,
                    popularity: null,
                    libraryPopularity: null,
                });
            }
        },
        finish() {
            const ids = entries.flatMap((e) => e.recordingId ?? []);
            const popularity = popularityOf(entries, info === undefined ? new Map() : info.listens(ids));
            for (const e of entries) {
                if (e.recordingId === null) continue;
                e.popularity = popularity.artist.get(`${e.albumArtist}\0${e.recordingId}`) ?? null;
                e.libraryPopularity = popularity.library.get(e.recordingId) ?? null;
            }
            const genres: GeneratorGenre[] = [...tracks]
                .map(([k, n]) => ({
                    name: [...spellings.get(k)!].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0],
                    tracks: n,
                }))
                .sort((a, b) => b.tracks - a.tracks || a.name.localeCompare(b.name));
            return {
                entries,
                options: { genres, years },
                artistIds: new Map([...artistIds].map(([name, ids]) => [name, [...ids]])),
            };
        },
    };
}

export function indexOf(songs: readonly LibrarySong[], info?: Pick<InfoLookup, 'artist' | 'listens'>): GeneratorIndex {
    const builder = indexBuilder(info);
    builder.add(songs);
    return builder.finish();
}

const LIST_IDS = new Set<string>(GENERATOR_LISTS.map((l) => l.id));

function rangeFrom(value: unknown, field: string, lo: number, hi: number): Range | string {
    const { min, max } = (value ?? {}) as { min?: unknown; max?: unknown };
    if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max)) {
        return `'${field}' must be { min, max }`;
    }
    if (min > max) return `'${field}': min is above max`;
    return { min: Math.max(lo, Math.min(hi, min)), max: Math.max(lo, Math.min(hi, max)) };
}

function namesFrom(value: unknown, field: string): string[] | string {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_NAMES || !value.every((v) => typeof v === 'string')) {
        return `'${field}' must be a list of names`;
    }
    return value as string[];
}

/** A request's filters, or what is wrong with them. Missing fields constrain nothing. */
export function filtersFrom(body: unknown): GeneratorFilters | string {
    const raw = (body ?? {}) as Record<string, unknown>;
    const lists = namesFrom(raw.lists, 'lists');
    if (typeof lists === 'string') return lists;
    if (!lists.every((id) => LIST_IDS.has(id))) return "unknown list in 'lists'";
    const popularity = raw.popularity === undefined ? { min: 0, max: 100 } : rangeFrom(raw.popularity, 'popularity', 0, 100);
    if (typeof popularity === 'string') return popularity;
    const libraryPopularity =
        raw.libraryPopularity === undefined
            ? { min: 0, max: 100 }
            : rangeFrom(raw.libraryPopularity, 'libraryPopularity', 0, 100);
    if (typeof libraryPopularity === 'string') return libraryPopularity;
    const years = raw.years == null ? null : rangeFrom(raw.years, 'years', 0, 9999);
    if (typeof years === 'string') return years;
    const artists = namesFrom(raw.artists, 'artists');
    if (typeof artists === 'string') return artists;
    const related = namesFrom(raw.related, 'related');
    if (typeof related === 'string') return related;
    const genres = namesFrom(raw.genres, 'genres');
    if (typeof genres === 'string') return genres;
    return { lists: [...new Set(lists)] as GeneratorList[], popularity, libraryPopularity, years, artists, related, genres };
}

export function lengthFrom(value: unknown): number | string {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= GENERATOR_MAX_LENGTH
        ? value
        : `'length' must be a whole number from 1 to ${GENERATOR_MAX_LENGTH}`;
}

type Test = (e: Entry) => boolean;

/** One test per selected list; a track passes the lists filter if any passes. */
export async function listTests(ids: readonly GeneratorList[], sources: ListSources, entries: readonly Entry[]): Promise<Test[]> {
    let played: Set<string> | null = null;
    const playedFiles = () => (played ??= new Set(sources.playedFiles()));
    const heard = (key: (e: Entry) => string | null): Set<string> => {
        const files = playedFiles();
        const out = new Set<string>();
        for (const e of entries) {
            const k = key(e);
            if (k !== null && files.has(e.file)) out.add(k);
        }
        return out;
    };
    const tests: Test[] = [];
    for (const id of ids) {
        switch (id) {
            case 'favourite-albums': {
                const set = new Set(sources.favouriteReleases());
                tests.push((e) => e.release !== null && set.has(e.release));
                break;
            }
            case 'recent-albums': {
                const set = new Set(sources.recentReleases());
                tests.push((e) => e.release !== null && set.has(e.release));
                break;
            }
            case 'most-played-artists': {
                const set = new Set(sources.mostPlayedArtists());
                tests.push((e) => set.has(e.albumArtist));
                break;
            }
            case 'unplayed-artists': {
                const set = heard((e) => e.albumArtist);
                tests.push((e) => !set.has(e.albumArtist));
                break;
            }
            case 'unplayed-albums': {
                const set = heard((e) => e.release);
                tests.push((e) => e.release !== null && !set.has(e.release));
                break;
            }
            case 'unplayed-tracks': {
                const files = playedFiles();
                tests.push((e) => !files.has(e.file));
                break;
            }
            case 'recently-added': {
                const set = new Set(await sources.recentlyAddedReleases());
                tests.push((e) => e.release !== null && set.has(e.release));
                break;
            }
        }
    }
    return tests;
}

/** `related` is `relatedTo(filters.related)`, resolved by the caller; null when none were chosen. */
export function matching(
    entries: readonly Entry[],
    filters: GeneratorFilters,
    lists: readonly Test[],
    related: ReadonlySet<string> | null = null,
): Entry[] {
    const { years } = filters;
    const within = (range: Range) =>
        range.min > 0 || range.max < 100
            ? (value: number | null) => value !== null && value >= range.min && value <= range.max
            : () => true;
    const byPopularity = within(filters.popularity);
    const byLibraryPopularity = within(filters.libraryPopularity);
    const artists = new Set(filters.artists);
    const genres = new Set(filters.genres.map(fold));
    return entries.filter(
        (e) =>
            (lists.length === 0 || lists.some((t) => t(e))) &&
            byPopularity(e.popularity) &&
            byLibraryPopularity(e.libraryPopularity) &&
            (years === null || (e.year !== null && e.year >= years.min && e.year <= years.max)) &&
            (artists.size === 0 || artists.has(e.albumArtist)) &&
            (related === null || related.has(e.albumArtist)) &&
            (genres.size === 0 || e.genres.some((g) => genres.has(g))),
    );
}

/** A random `length` of them, one per recording, the same artist never twice running where avoidable. */
export function pick(entries: readonly Entry[], length: number, random: () => number = Math.random): Entry[] {
    const deck = [...entries];
    for (let i = deck.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    const seen = new Set<string>();
    const chosen: Entry[] = [];
    for (const e of deck) {
        if (chosen.length === length) break;
        if (e.recordingId !== null) {
            if (seen.has(e.recordingId)) continue;
            seen.add(e.recordingId);
        }
        chosen.push(e);
    }
    // The artist with the most left goes next, else it ends up back to back at the end.
    const left = new Map<string, number>();
    for (const e of chosen) left.set(e.albumArtist, (left.get(e.albumArtist) ?? 0) + 1);
    const out: Entry[] = [];
    while (chosen.length > 0) {
        const last = out.at(-1)?.albumArtist;
        let at = 0;
        let most = -1;
        chosen.forEach((e, i) => {
            const n = left.get(e.albumArtist)!;
            if (e.albumArtist !== last && n > most) [at, most] = [i, n];
        });
        const [next] = chosen.splice(at, 1);
        left.set(next!.albumArtist, left.get(next!.albumArtist)! - 1);
        out.push(next!);
    }
    return out;
}

export interface GeneratorBridge {
    songsWindow(offset: number, count: number): Promise<LibrarySong[]>;
}

export interface Generator {
    options(): Promise<GeneratorOptions>;
    count(filters: GeneratorFilters): Promise<number>;
    /** Files, in playing order. */
    generate(filters: GeneratorFilters, length: number): Promise<string[]>;
    /** Drop the index. Called on a scan and after a harvest. */
    invalidate(): void;
}

export async function readLibrary(bridge: GeneratorBridge, onPage: (songs: LibrarySong[]) => void): Promise<void> {
    for (let offset = 0; ; offset += INDEX_PAGE) {
        const page = await bridge.songsWindow(offset, INDEX_PAGE);
        onPage(page);
        if (page.length < INDEX_PAGE) return;
    }
}

export function createGenerator(opts: {
    bridge: GeneratorBridge;
    sources: ListSources;
    info?: Pick<InfoLookup, 'artist' | 'listens'>;
    random?: () => number;
    log?: (message: string) => void;
}): Generator {
    let cached: GeneratorIndex | null = null;
    let building: Promise<GeneratorIndex> | null = null;
    let generation = 0;

    // Shared between concurrent callers; a build that a scan overtook is not kept.
    function index(): Promise<GeneratorIndex> {
        if (cached !== null) return Promise.resolve(cached);
        if (building === null) {
            const mine = generation;
            const began = Date.now();
            const builder = indexBuilder(opts.info);
            building = readLibrary(opts.bridge, (page) => builder.add(page))
                .then(() => {
                    const built = builder.finish();
                    opts.log?.(`generator: indexed ${built.entries.length} songs in ${Date.now() - began}ms`);
                    if (mine === generation) cached = built;
                    return built;
                })
                .finally(() => {
                    if (mine === generation) building = null;
                });
        }
        return building;
    }

    const matched = async (filters: GeneratorFilters): Promise<Entry[]> => {
        const { entries, artistIds } = await index();
        const related =
            filters.related.length === 0
                ? null
                : relatedTo(filters.related, artistIds, (id) => opts.info?.artist(id)?.similar ?? []);
        return matching(entries, filters, await listTests(filters.lists, opts.sources, entries), related);
    };

    return {
        options: async () => (await index()).options,
        count: async (filters) => (await matched(filters)).length,
        generate: async (filters, length) => pick(await matched(filters), length, opts.random).map((e) => e.file),
        invalidate: () => {
            cached = null;
            building = null;
            generation += 1;
        },
    };
}
