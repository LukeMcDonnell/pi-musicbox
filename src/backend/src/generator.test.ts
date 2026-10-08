import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    INDEX_PAGE,
    createGenerator,
    filtersFrom,
    indexOf,
    isOuttake,
    lengthFrom,
    listTests,
    matching,
    pick,
    popularityOf,
    readLibrary,
    relatedTo,
    songKey,
    yearOf,
    type Entry,
    type ListSources,
} from './generator.ts';
import { songFromTags, type LibrarySong } from './mpd/bridge.ts';
import type { ArtistInfo, SimilarArtist } from './enrich.ts';
import { DECADE_PRESETS, GENERATOR_PRESETS, presetById, presetFilters, type GeneratorFilters } from '../../shared/api.ts';

function lsong(file: string, tags: Record<string, string | string[]> = {}): LibrarySong {
    const map = new Map<string, string[]>([['file', [file]]]);
    for (const [key, value] of Object.entries(tags)) map.set(key, Array.isArray(value) ? value : [value]);
    const built = songFromTags(map);
    assert.ok(built);
    return built;
}

function entry(file: string, over: Partial<Entry> = {}): Entry {
    return {
        file,
        albumArtist: file.split('/')[0]!,
        release: `dir:${file.split('/').slice(0, 2).join('/')}`,
        year: null,
        genres: [],
        recordingId: null,
        popularity: null,
        libraryPopularity: null,
        outtake: false,
        song: null,
        ...over,
    };
}

const ANY: GeneratorFilters = {
    lists: [],
    popularity: { min: 0, max: 100 },
    libraryPopularity: { min: 0, max: 100 },
    years: null,
    artists: [],
    related: [],
    genres: [],
    outtakes: false,
};

const NO_SOURCES: ListSources = {
    favouriteReleases: () => [],
    recentReleases: () => [],
    mostPlayedArtists: () => [],
    playedFiles: () => [],
    recentlyAddedReleases: async () => [],
};

/** Counts the calls, so a fixed sequence stands in for Math.random. */
function seeded(values: number[]): () => number {
    let i = 0;
    return () => values[i++ % values.length]!;
}

test('the year is the leading four digits of OriginalDate, else Date', () => {
    assert.equal(yearOf('1997-06-16'), 1997);
    assert.equal(yearOf('c. 1997'), null);
    assert.equal(yearOf(null), null);
    assert.equal(yearOf('0001-01-01'), null);
    assert.equal(yearOf('1877'), 1877);
    const [song] = indexOf([lsong('A/B/1.flac', { AlbumArtist: 'A', Date: '2003', OriginalDate: '1980' })]).entries;
    assert.equal(song!.year, 1980);
});

test('popularity is a percentile within the album artist, by distinct recording', () => {
    const rows = [
        { albumArtist: 'A', recordingId: 'r1' },
        { albumArtist: 'A', recordingId: 'r2' },
        { albumArtist: 'A', recordingId: 'r3' },
        { albumArtist: 'A', recordingId: 'r3' },
        { albumArtist: 'B', recordingId: 'r4' },
        { albumArtist: 'C', recordingId: 'r5' },
    ];
    const listens = new Map([['r1', 10], ['r2', 2_000_000], ['r3', 50], ['r4', 1]]);
    const pop = popularityOf(rows, listens).artist;
    assert.equal(pop.get('A\0r1'), 0);
    assert.equal(pop.get('A\0r3'), 50);
    assert.equal(pop.get('A\0r2'), 100);
    // An artist with one recording is its own top.
    assert.equal(pop.get('B\0r4'), 100);
    // An artist with no counts at all was never harvested.
    assert.equal(pop.has('C\0r5'), false);
});

test('library popularity is a percentile across every harvested recording', () => {
    const rows = [
        { albumArtist: 'A', recordingId: 'r1' },
        { albumArtist: 'A', recordingId: 'r2' },
        { albumArtist: 'B', recordingId: 'r3' },
        { albumArtist: 'B', recordingId: 'r4' },
        { albumArtist: 'C', recordingId: 'r5' },
    ];
    const listens = new Map([['r1', 1_000_000], ['r2', 10], ['r3', 500], ['r4', 1]]);
    const { artist, library } = popularityOf(rows, listens);
    // B's hit is B's top, but only a middling song across the library.
    assert.equal(artist.get('B\0r3'), 100);
    assert.equal(library.get('r3'), 67);
    assert.equal(library.get('r1'), 100);
    assert.equal(library.get('r2'), 33);
    assert.equal(library.get('r4'), 0);
    assert.equal(library.has('r5'), false);
});

test('a recording with no count is the bottom of an artist that has counts', () => {
    const pop = popularityOf([{ albumArtist: 'A', recordingId: 'r1' }, { albumArtist: 'A', recordingId: 'r2' }], new Map([['r1', 5]])).artist;
    assert.equal(pop.get('A\0r2'), 0);
    assert.equal(pop.get('A\0r1'), 100);
});

test('genres join the tags and the artist harvest, folded, with the commonest spelling shown', () => {
    const info = {
        artist: (mbid: string): ArtistInfo | null =>
            mbid === 'a1' ? { bio: null, bioUrl: null, genres: ['Shoegaze'], similar: [] } : null,
        listens: () => new Map<string, number>(),
    };
    const { entries, options } = indexOf(
        [
            lsong('A/X/1.flac', { AlbumArtist: 'A', Genre: ['Rock', 'Dream Pop'], MUSICBRAINZ_ALBUMARTISTID: 'a1' }),
            lsong('A/X/2.flac', { AlbumArtist: 'A', Genre: 'rock', MUSICBRAINZ_ALBUMARTISTID: 'a1' }),
            lsong('B/Y/1.flac', { AlbumArtist: 'B', Genre: 'Rock', Date: '1971' }),
            // No album artist: nothing on screen could open it.
            lsong('C/Z/1.flac', { Genre: 'Rock' }),
        ],
        info,
    );
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[0]!.genres, ['rock', 'dream pop', 'shoegaze']);
    assert.deepEqual(options.genres, [
        { name: 'Rock', tracks: 3 },
        { name: 'Shoegaze', tracks: 2 },
        { name: 'Dream Pop', tracks: 1 },
    ]);
    assert.deepEqual(options.years, { min: 1971, max: 1971 });
});

test('filters are validated, clamped, and constrain nothing when missing', () => {
    assert.deepEqual(filtersFrom(undefined), ANY);
    assert.deepEqual(filtersFrom({ popularity: { min: -5, max: 120 } }), ANY);
    assert.deepEqual(filtersFrom({ libraryPopularity: { min: -5, max: 120 } }), ANY);
    assert.equal(typeof filtersFrom({ libraryPopularity: { min: 80, max: 20 } }), 'string');
    assert.equal(typeof filtersFrom({ lists: ['nope'] }), 'string');
    assert.equal(typeof filtersFrom({ popularity: { min: 80, max: 20 } }), 'string');
    assert.equal(typeof filtersFrom({ years: { min: '1990' } }), 'string');
    assert.equal(typeof filtersFrom({ artists: 'Tool' }), 'string');
    assert.equal(typeof filtersFrom({ related: [3] }), 'string');
    assert.equal(typeof filtersFrom({ genres: [1] }), 'string');
    assert.deepEqual(filtersFrom({ lists: ['unplayed-tracks', 'unplayed-tracks'] }), { ...ANY, lists: ['unplayed-tracks'] });
    assert.equal(lengthFrom(50), 50);
    for (const bad of [0, 251, 2.5, '50', undefined]) assert.equal(typeof lengthFrom(bad), 'string', String(bad));
});

test('filters AND together, and each ORs within itself', () => {
    const entries = [
        entry('A/X/1', { year: 1991, genres: ['rock'], popularity: 90, libraryPopularity: 20 }),
        entry('A/X/2', { year: 1991, genres: ['rock'], popularity: 10, libraryPopularity: 5 }),
        entry('B/Y/1', { year: 2005, genres: ['jazz'], popularity: 95, libraryPopularity: 99 }),
        entry('C/Z/1', { year: null, genres: ['rock', 'jazz'], popularity: null }),
    ];
    const files = (f: Partial<GeneratorFilters>) => matching(entries, { ...ANY, ...f }, []).map((e) => e.file);
    assert.deepEqual(files({}), ['A/X/1', 'A/X/2', 'B/Y/1', 'C/Z/1']);
    assert.deepEqual(files({ popularity: { min: 80, max: 100 } }), ['A/X/1', 'B/Y/1']);
    assert.deepEqual(files({ libraryPopularity: { min: 80, max: 100 } }), ['B/Y/1']);
    assert.deepEqual(files({ popularity: { min: 80, max: 100 }, libraryPopularity: { min: 0, max: 50 } }), ['A/X/1']);
    assert.deepEqual(files({ years: { min: 1990, max: 1999 } }), ['A/X/1', 'A/X/2']);
    assert.deepEqual(files({ artists: ['A', 'C'] }), ['A/X/1', 'A/X/2', 'C/Z/1']);
    assert.deepEqual(files({ genres: ['Jazz'] }), ['B/Y/1', 'C/Z/1']);
    assert.deepEqual(files({ genres: ['jazz'], popularity: { min: 50, max: 100 } }), ['B/Y/1']);
});

test('each list selects its tracks, and several lists are a union', async () => {
    const entries = [entry('A/X/1'), entry('A/X/2'), entry('A/Y/1'), entry('B/Z/1'), entry('C/W/1', { release: null })];
    const sources: ListSources = {
        favouriteReleases: () => ['dir:A/Y'],
        recentReleases: () => ['dir:B/Z'],
        mostPlayedArtists: () => ['B'],
        playedFiles: () => ['A/X/1'],
        recentlyAddedReleases: async () => ['dir:A/X'],
    };
    const files = async (...lists: GeneratorFilters['lists']) =>
        matching(entries, { ...ANY, lists }, await listTests(lists, sources, entries)).map((e) => e.file);
    assert.deepEqual(await files('favourite-albums'), ['A/Y/1']);
    assert.deepEqual(await files('recent-albums'), ['B/Z/1']);
    assert.deepEqual(await files('most-played-artists'), ['B/Z/1']);
    assert.deepEqual(await files('unplayed-artists'), ['B/Z/1', 'C/W/1']);
    assert.deepEqual(await files('unplayed-albums'), ['A/Y/1', 'B/Z/1']);
    assert.deepEqual(await files('unplayed-tracks'), ['A/X/2', 'A/Y/1', 'B/Z/1', 'C/W/1']);
    assert.deepEqual(await files('recently-added'), ['A/X/1', 'A/X/2']);
    assert.deepEqual(await files('favourite-albums', 'recent-albums'), ['A/Y/1', 'B/Z/1']);
});

test('pick takes the length asked for, one per recording', () => {
    const entries = [
        entry('A/X/1', { recordingId: 'r1' }),
        entry('A/Comp/9', { recordingId: 'r1' }),
        entry('B/Y/1', { recordingId: 'r2' }),
        entry('C/Z/1'),
    ];
    const all = pick(entries, 10, seeded([0.3, 0.7, 0.1]));
    assert.equal(all.length, 3);
    assert.equal(all.filter((e) => e.recordingId === 'r1').length, 1);
    assert.equal(pick(entries, 2, seeded([0.5])).length, 2);
});

test('pick keeps one artist from playing twice running where it can', () => {
    const entries = [...['1', '2', '3'].map((n) => entry(`A/X/${n}`)), entry('B/Y/1'), entry('C/Z/1')];
    for (const seed of [0, 0.2, 0.5, 0.9]) {
        const out = pick(entries, 5, seeded([seed])).map((e) => e.albumArtist);
        for (let i = 1; i < out.length; i += 1) assert.notEqual(out[i], out[i - 1], out.join(''));
    }
    // Where it cannot, it still returns everything.
    assert.equal(pick([entry('A/X/1'), entry('A/X/2')], 5).length, 2);
});

test('pick draws artists by the square root of their tracks, not by their tracks', () => {
    const entries = [
        ...Array.from({ length: 500 }, (_, i) => entry(`Quo/A/${i}`)),
        ...Array.from({ length: 50 }, (_, a) => Array.from({ length: 10 }, (_, i) => entry(`X${a}/A/${i}`))).flat(),
    ];
    let state = 1;
    const random = () => ((state = (state * 48271) % 2147483647) / 2147483647);
    let quo = 0;
    for (let run = 0; run < 40; run += 1) quo += pick(entries, 50, random).filter((e) => e.albumArtist === 'Quo').length;
    // sqrt(500) / (sqrt(500) + 50 sqrt(10)) is 12%; an even shuffle gives 48%.
    assert.ok(quo / 40 > 3 && quo / 40 < 9, `${quo / 40} per 50`);
});

test('pick doesn’t bunch the busiest artist at the start of a long queue', () => {
    const entries = Array.from({ length: 150 }, (_, a) => Array.from({ length: a < 3 ? 300 : 15 }, (_, i) => entry(`X${a}/A/${i}`))).flat();
    let state = 7;
    const random = () => ((state = (state * 48271) % 2147483647) / 2147483647);
    let first = 0;
    for (let run = 0; run < 40; run += 1) {
        const head = pick(entries, 250, random).slice(0, 50);
        first += head.filter((e) => e.albumArtist === head[0]!.albumArtist).length;
    }
    // Ordering by most left gave the first artist 6 of the first 50.
    assert.ok(first / 40 < 3, `${first / 40} of the first 50`);
});

test('pick plays one version of a song, but keeps untitled tracks apart', () => {
    const entries = [
        entry('A/X/1', { song: 'A\0blackbird' }),
        entry('A/Y/1', { song: 'A\0blackbird' }),
        entry('A/Z/1'),
        entry('A/Z/2'),
    ];
    const out = pick(entries, 10, seeded([0.1, 0.6, 0.3, 0.9]));
    assert.equal(out.length, 3);
    assert.equal(out.filter((e) => e.song !== null).length, 1);
});

test('outtakes are read from the title’s tags', () => {
    for (const title of [
        'Yer Blues (Esher demo)',
        'Revolution (take 14 / instrumental backing track)',
        'Julia (two rehearsals)',
        'Blue Moon (studio jam)',
        'Hazel Eyes [Whitfield Street Rough Mix]',
        'Drain You - Demo',
    ]) {
        assert.ok(isOuttake(title), title);
    }
    for (const title of [
        'Blackbird (2018 mix)',
        'Brown Sugar (live at Wembley)',
        'Taxman (mono)',
        'Demolition Man',
        'Takedown',
        'Instrumental Song',
        undefined,
    ]) {
        assert.ok(!isOuttake(title), title);
    }
});

test('a song is its artist and bare title', () => {
    assert.equal(songKey('The Beatles', 'Blackbird (2018 mix)'), songKey('The Beatles', 'Blackbird'));
    assert.equal(songKey('The Beatles', 'Ob‐La‐Di, Ob‐La‐Da (take 3)'), 'The Beatles\0obladioblada');
    assert.notEqual(songKey('Low', 'Blackbird'), songKey('The Beatles', 'Blackbird'));
    assert.equal(songKey('Tool', ''), null);
    assert.equal(songKey('Tool', '(silence)'), null);
    assert.equal(songKey('Tool', undefined), null);
});

test('outtakes are left out unless asked for', () => {
    const entries = indexOf([lsong('A/X/1', { AlbumArtist: 'A', Title: 'Song' }), lsong('A/X/2', { AlbumArtist: 'A', Title: 'Song (demo)' })]).entries;
    assert.deepEqual(matching(entries, ANY, []).map((e) => e.file), ['A/X/1']);
    assert.equal(matching(entries, { ...ANY, outtakes: true }, []).length, 2);
    assert.equal((filtersFrom({}) as GeneratorFilters).outtakes, false);
    assert.equal((filtersFrom({ outtakes: true }) as GeneratorFilters).outtakes, true);
    assert.equal(typeof filtersFrom({ outtakes: 'yes' }), 'string');
});

test('the library is read in pages until a short one', async () => {
    const asked: number[] = [];
    const pages: number[] = [];
    await readLibrary(
        {
            songsWindow: async (offset) => {
                asked.push(offset);
                const n = offset === 0 ? INDEX_PAGE : 3;
                return Array.from({ length: n }, (_, i) => lsong(`A/X/${offset + i}.flac`, { AlbumArtist: 'A' }));
            },
        },
        (page) => pages.push(page.length),
    );
    assert.deepEqual(asked, [0, INDEX_PAGE]);
    assert.deepEqual(pages, [INDEX_PAGE, 3]);
});

test('the index is built once and shared, until invalidated', async () => {
    let builds = 0;
    const generator = createGenerator({
        bridge: {
            songsWindow: async () => {
                builds += 1;
                return [lsong('A/X/1.flac', { AlbumArtist: 'A', Date: '1999' }), lsong('B/Y/1.flac', { AlbumArtist: 'B' })];
            },
        },
        sources: NO_SOURCES,
    });
    const [count, options] = await Promise.all([generator.count(ANY), generator.options()]);
    assert.equal(count, 2);
    assert.deepEqual(options.years, { min: 1999, max: 1999 });
    assert.deepEqual(await generator.generate({ ...ANY, artists: ['B'] }, 50), ['B/Y/1.flac']);
    assert.equal(builds, 1);
    generator.invalidate();
    await generator.count(ANY);
    assert.equal(builds, 2);
});

test('related artists are the similar ones the library holds, as many as the artist screen shows', () => {
    const ids = new Map([
        ['Tool', ['t1']],
        ['Queen', ['q1', 'q2']],
        ['A Perfect Circle', ['apc']],
        ['Puscifer', ['pus']],
        ['Muse', ['muse']],
    ]);
    const similar: Record<string, SimilarArtist[]> = {
        t1: [{ mbid: 'nope', name: 'Not Here' }, { mbid: 'apc', name: 'A Perfect Circle' }, { mbid: 'pus', name: 'Puscifer' }],
        // Queen's second id answers: whichever was harvested.
        q2: [{ mbid: 'muse', name: 'Muse' }, { mbid: 't1', name: 'Tool' }],
    };
    const of = (id: string) => similar[id] ?? [];
    assert.deepEqual([...relatedTo(['Tool'], ids, of)], ['A Perfect Circle', 'Puscifer']);
    assert.deepEqual([...relatedTo(['Tool'], ids, of, 1)], ['A Perfect Circle']);
    assert.deepEqual([...relatedTo(['Queen'], ids, of)].sort(), ['Muse', 'Tool']);
    // A chosen artist is not related to the selection, even when similar to another chosen one.
    assert.deepEqual([...relatedTo(['Queen', 'Tool'], ids, of)].sort(), ['A Perfect Circle', 'Muse', 'Puscifer']);
    assert.deepEqual([...relatedTo(['Nobody'], ids, of)], []);
});

test('the index knows each album artist by its MusicBrainz ids', () => {
    const { artistIds } = indexOf([
        lsong('Queen/A/1.flac', { AlbumArtist: 'Queen', MUSICBRAINZ_ALBUMARTISTID: 'q1' }),
        lsong('Queen/B/1.flac', { AlbumArtist: 'Queen', MUSICBRAINZ_ALBUMARTISTID: 'q2' }),
        lsong('Queen/B/2.flac', { AlbumArtist: 'Queen', MUSICBRAINZ_ALBUMARTISTID: 'q2' }),
        lsong('Low/C/1.flac', { AlbumArtist: 'Low' }),
    ]);
    assert.deepEqual(Object.fromEntries(artistIds), { Queen: ['q1', 'q2'] });
});

test('the related filter keeps only tracks by artists similar to the chosen ones', async () => {
    const generator = createGenerator({
        bridge: {
            songsWindow: async () => [
                lsong('Tool/X/1.flac', { AlbumArtist: 'Tool', MUSICBRAINZ_ALBUMARTISTID: 't1' }),
                lsong('APC/Y/1.flac', { AlbumArtist: 'A Perfect Circle', MUSICBRAINZ_ALBUMARTISTID: 'apc' }),
                lsong('Low/Z/1.flac', { AlbumArtist: 'Low', MUSICBRAINZ_ALBUMARTISTID: 'low' }),
            ],
        },
        sources: NO_SOURCES,
        info: {
            artist: (mbid) =>
                mbid === 't1' ? { bio: null, bioUrl: null, genres: [], similar: [{ mbid: 'apc', name: 'A Perfect Circle' }] } : null,
            listens: () => new Map(),
        },
    });
    assert.deepEqual(await generator.generate({ ...ANY, related: ['Tool'] }, 50), ['APC/Y/1.flac']);
    // Nothing known about Low's neighbours: nothing matches, rather than everything.
    assert.equal(await generator.count({ ...ANY, related: ['Low'] }), 0);
});

test('every preset is a valid set of filters, under its own id', () => {
    const all = [...GENERATOR_PRESETS, ...DECADE_PRESETS];
    assert.equal(new Set(all.map((p) => p.id)).size, all.length);
    for (const preset of all) {
        assert.deepEqual(filtersFrom(presetFilters(preset)), presetFilters(preset), preset.id);
        assert.equal(presetById(preset.id), preset);
    }
});

test('decade presets run from the 50s to the 2020s, ten years each', () => {
    assert.deepEqual(DECADE_PRESETS.map((p) => p.badge), ['50s', '60s', '70s', '80s', '90s', '2000s', '2010s', '2020s']);
    const seventies = presetById('decade-1970s')!;
    assert.equal(seventies.name, '70s Radio');
    assert.deepEqual(presetFilters(seventies).years, { min: 1970, max: 1979 });
    assert.equal(presetById('nope'), undefined);
});
