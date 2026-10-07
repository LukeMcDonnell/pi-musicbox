import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import {
    ALBUM_TTL_MS,
    MISS_TTL_MS,
    createEnrich,
    genresOf,
    idsOf,
    similarOf,
    tidyExtract,
    titleOfArticle,
} from './enrich.ts';

const PEARL_JAM = '83b9cbe7-9857-49e2-ab8e-b57b01038103';
const NIRVANA = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';
const TEN = 'd37a0c9e-aff4-42e9-b5fa-9fc4e5a2a210';
const UNKNOWN_ALBUM = '11111111-1111-4111-8111-111111111111';
const ALIVE = 'ea3d5df8-95f9-417a-8657-098d2186e237';
const EVEN_FLOW = '54f025fd-cc09-40f0-bb57-7d7aac2d810f';
const NOT_OWNED = '8972c8e0-4e44-43b5-9f58-fd7c5d91f304';

interface Call {
    url: string;
    body: string | null;
    userAgent: string | null;
    authorization: string | null;
}

type Answer = (url: URL, body: string | null) => Response | Promise<Response>;

/** Answers like the real services, for the ids above. */
const services: Answer = (url, body) => {
    if (url.host === 'query.wikidata.org') {
        const query = new URLSearchParams(body ?? '').get('query') ?? '';
        const bindings = [];
        if (query.includes(PEARL_JAM)) {
            bindings.push({ id: { value: PEARL_JAM }, article: { value: 'https://en.wikipedia.org/wiki/Pearl_Jam' } });
        }
        if (query.includes(TEN)) {
            bindings.push({
                id: { value: TEN },
                article: { value: 'https://en.wikipedia.org/wiki/Ten_(Pearl_Jam_album)' },
            });
        }
        return Response.json({ results: { bindings } });
    }
    if (url.host === 'en.wikipedia.org') {
        const titles = (url.searchParams.get('titles') ?? '').split('|');
        return Response.json({
            query: {
                normalized: titles.filter((t) => t.includes('_')).map((t) => ({ from: t, to: t.replace(/_/g, ' ') })),
                pages: [
                    { title: 'Pearl Jam', extract: 'Pearl Jam are an American rock band.\n\n\nFormed in Seattle.' },
                    { title: 'Ten (Pearl Jam album)', extract: 'Ten is the debut studio album by Pearl Jam.' },
                ],
            },
        });
    }
    if (url.host === 'musicbrainz.org') {
        return Response.json({ genres: [{ name: 'rock', count: 3 }, { name: 'grunge', count: 9 }] });
    }
    if (url.host === 'labs.api.listenbrainz.org') {
        return Response.json([
            { artist_mbid: NIRVANA, name: 'Nirvana', score: 9335 },
            { artist_mbid: PEARL_JAM, name: 'Pearl Jam', score: 1 },
        ]);
    }
    if (url.host === 'api.listenbrainz.org') {
        return Response.json([
            { recording_mbid: ALIVE, total_listen_count: 900 },
            { recording_mbid: EVEN_FLOW, total_listen_count: 700 },
            { recording_mbid: NOT_OWNED, total_listen_count: 500 },
            // ListenBrainz splits a recording's count over several rows: 44 of Metallica's.
            { recording_mbid: ALIVE, total_listen_count: 100 },
        ]);
    }
    return new Response('no', { status: 500 });
};

function harness(
    t: { after: (fn: () => void) => void },
    opts: { token?: string | null; answer?: Answer; albums?: string[]; db?: ReturnType<typeof openDb> } = {},
) {
    const db = opts.db ?? openDb({ path: ':memory:' });
    if (opts.db === undefined) t.after(() => db.close());
    const calls: Call[] = [];
    const slept: number[] = [];
    let clock = 1_000_000;
    const answer = opts.answer ?? services;
    const enrich = createEnrich({
        db,
        bridge: {
            async list(tag) {
                const values: Record<string, string[]> = {
                    MUSICBRAINZ_ALBUMARTISTID: [PEARL_JAM, 'not-an-id'],
                    MUSICBRAINZ_RELEASEGROUPID: opts.albums ?? [TEN, UNKNOWN_ALBUM],
                    MUSICBRAINZ_TRACKID: [ALIVE, EVEN_FLOW],
                };
                return { pairs: (values[tag] ?? []).map((v): [string, string] => [tag, v]) };
            },
        },
        userAgent: 'musicbox/test ( x )',
        listenBrainzToken: opts.token === undefined ? 'secret' : opts.token,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            const body = typeof init?.body === 'string' ? init.body : null;
            calls.push({
                url: String(input),
                body,
                userAgent: headers.get('user-agent'),
                authorization: headers.get('authorization'),
            });
            return answer(new URL(String(input)), body);
        }) as typeof fetch,
        now: () => clock,
        sleep: async (ms) => {
            slept.push(ms);
        },
        intervals: {},
    });
    return { enrich, db, calls, slept, advance: (ms: number) => (clock += ms) };
}

test('ids are taken from a list reply, deduplicated, and only when well formed', () => {
    const reply = {
        pairs: [
            ['MUSICBRAINZ_TRACKID', ALIVE],
            ['MUSICBRAINZ_TRACKID', ALIVE],
            ['MUSICBRAINZ_TRACKID', 'nonsense'],
            ['Album', EVEN_FLOW],
        ] as Array<[string, string]>,
    };
    assert.deepEqual(idsOf(reply, 'MUSICBRAINZ_TRACKID'), [ALIVE]);
});

test('an article URL names its title, slashes and all', () => {
    assert.equal(titleOfArticle('https://en.wikipedia.org/wiki/AC%2FDC'), 'AC/DC');
    assert.equal(titleOfArticle('https://en.wikipedia.org/wiki/Ten_(Pearl_Jam_album)'), 'Ten (Pearl Jam album)');
    assert.equal(titleOfArticle('https://example.org/nope'), null);
});

test('an extract keeps its paragraphs, loses blank runs, and is capped on a word', () => {
    assert.equal(tidyExtract('One.\n\n\nTwo.\n'), 'One.\nTwo.');
    assert.equal(tidyExtract('  \n '), null);
    const long = tidyExtract('word '.repeat(2_000))!;
    assert.ok(long.length <= 6_001);
    assert.match(long, /word…$/);
});

test('genres come most-voted first', () => {
    assert.deepEqual(genresOf({ genres: [{ name: 'rock', count: 3 }, { name: 'grunge', count: 9 }] }), [
        'grunge',
        'rock',
    ]);
    assert.deepEqual(genresOf(null), []);
});

test('similar artists never include the artist themself', () => {
    assert.deepEqual(similarOf([{ artist_mbid: PEARL_JAM, name: 'Pearl Jam' }, { artist_mbid: NIRVANA, name: 'Nirvana' }], PEARL_JAM), [
        { mbid: NIRVANA, name: 'Nirvana' },
    ]);
});

test('a run stores bios, genres, similar artists, album text and owned listen counts', async (t) => {
    const { enrich, calls } = harness(t);
    const result = await enrich.run();

    assert.equal(result.stopped, null);
    assert.deepEqual(enrich.artist(PEARL_JAM), {
        bio: 'Pearl Jam are an American rock band.\nFormed in Seattle.',
        bioUrl: 'https://en.wikipedia.org/wiki/Pearl_Jam',
        genres: ['grunge', 'rock'],
        similar: [{ mbid: NIRVANA, name: 'Nirvana' }],
    });
    assert.deepEqual(enrich.album(TEN), {
        about: 'Ten is the debut studio album by Pearl Jam.',
        aboutUrl: 'https://en.wikipedia.org/wiki/Ten_(Pearl_Jam_album)',
    });
    assert.equal(enrich.album(UNKNOWN_ALBUM), null);
    // Only recordings the library holds are kept, and a split count is added up.
    assert.deepEqual(Object.fromEntries(enrich.listens([ALIVE, EVEN_FLOW, NOT_OWNED])), {
        [ALIVE]: 1000,
        [EVEN_FLOW]: 700,
    });
    assert.ok(calls.every((c) => c.userAgent === 'musicbox/test ( x )'));
    const popularity = calls.filter((c) => c.url.includes('/popularity/'));
    assert.equal(popularity.length, 1);
    assert.equal(popularity[0]!.authorization, 'Token secret');
});

test('a fresh library fetches nothing; a stale one only what is due', async (t) => {
    const { enrich, calls, advance } = harness(t);
    await enrich.run();
    const first = calls.length;

    await enrich.run();
    assert.equal(calls.length, first);

    // A week on, the album Wikipedia did not know is asked about again — and only it.
    advance(MISS_TTL_MS);
    await enrich.run();
    const sparql = calls.slice(first).filter((c) => c.url.includes('wikidata'));
    assert.equal(sparql.length, 1);
    assert.ok(sparql[0]!.body!.includes(UNKNOWN_ALBUM));
    assert.ok(!sparql[0]!.body!.includes(TEN));

    advance(ALBUM_TTL_MS);
    await enrich.run();
    assert.ok(calls.slice(first).some((c) => c.body?.includes(TEN)));
});

test('without a token there is no popularity call, and adding one later fetches it', async (t) => {
    const db = openDb({ path: ':memory:' });
    t.after(() => db.close());
    const without = harness(t, { token: null, db });
    await without.enrich.run();
    assert.ok(!without.calls.some((c) => c.url.includes('/popularity/')));
    assert.deepEqual(without.enrich.artist(PEARL_JAM)?.genres, ['grunge', 'rock']);
    assert.equal(without.enrich.listens([ALIVE]).size, 0);

    // Long before the artist is stale.
    const withToken = harness(t, { db });
    await withToken.enrich.run();
    assert.ok(withToken.calls.some((c) => c.url.includes('/popularity/')));
    assert.equal(withToken.enrich.listens([ALIVE]).get(ALIVE), 1000);
});

test('two calls share one run', async (t) => {
    const { enrich } = harness(t);
    const [a, b] = await Promise.all([enrich.run(), enrich.run()]);
    assert.equal(a, b);
});

test('a service asking us to slow down is waited on and retried', async (t) => {
    let refused = 0;
    const { enrich, slept } = harness(t, {
        answer: (url, body) => {
            if (url.host === 'musicbrainz.org' && refused === 0) {
                refused += 1;
                return new Response('', { status: 503, headers: { 'retry-after': '2' } });
            }
            return services(url, body);
        },
    });
    const result = await enrich.run();
    assert.equal(result.stopped, null);
    assert.ok(slept.includes(2_000));
    assert.deepEqual(enrich.artist(PEARL_JAM)?.genres, ['grunge', 'rock']);
});

test('the network going away stops the run and stores nothing for what it was doing', async (t) => {
    const { enrich, db } = harness(t, {
        answer: (url, body) => {
            if (url.host === 'en.wikipedia.org') throw new TypeError('fetch failed');
            return services(url, body);
        },
    });
    const result = await enrich.run();
    assert.match(result.stopped ?? '', /en\.wikipedia\.org: fetch failed/);
    // Not remembered as a miss: being offline says nothing about the artist.
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM artist_info')?.n, 0);
});

test('an unexpected status stops the run rather than recording a miss', async (t) => {
    const { enrich, db } = harness(t, {
        albums: [TEN],
        answer: (url, body) =>
            url.host === 'query.wikidata.org' && (body ?? '').includes(TEN)
                ? new Response('', { status: 500 })
                : services(url, body),
    });
    const result = await enrich.run();
    assert.match(result.stopped ?? '', /HTTP 500/);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM album_info')?.n, 0);
});

test('a similar-artists call that fails costs that list, not the run, and is asked again', async (t) => {
    let fail = true;
    const { enrich, calls } = harness(t, {
        answer: (url, body) => {
            if (url.host === 'labs.api.listenbrainz.org' && fail) throw new DOMException('timed out', 'TimeoutError');
            return services(url, body);
        },
    });
    const first = await enrich.run();
    assert.equal(first.stopped, null);
    assert.equal(first.unsure, 1);
    assert.deepEqual(enrich.artist(PEARL_JAM)?.similar, []);
    assert.deepEqual(enrich.artist(PEARL_JAM)?.genres, ['grunge', 'rock']);

    fail = false;
    const before = calls.length;
    await enrich.run();
    assert.ok(calls.slice(before).some((c) => c.url.includes('similar-artists')));
    assert.deepEqual(enrich.artist(PEARL_JAM)?.similar, [{ mbid: NIRVANA, name: 'Nirvana' }]);
});

test('status reports the phase in progress, then the last run and what is covered', async (t) => {
    let during: ReturnType<typeof h.enrich.status> | null = null;
    const h = harness(t, {
        answer: (url, body) => {
            if (url.host === 'musicbrainz.org') during ??= h.enrich.status();
            return services(url, body);
        },
    });
    const idle = h.enrich.status();
    assert.equal(idle.phase, null);
    assert.equal(idle.lastRun, null);
    assert.equal(idle.hasToken, true);

    await h.enrich.run();
    assert.equal(during!.phase, 'artists');
    assert.equal(during!.total, 1);

    const after = h.enrich.status();
    assert.equal(after.phase, null);
    assert.deepEqual(after.lastRun, { finishedAt: 1_000_000, albums: 2, artists: 1, unsure: 0, stopped: null });
    assert.deepEqual(after.coverage, {
        artists: 1,
        libraryArtists: 1,
        bios: 1,
        similar: 1,
        listens: 1,
        albums: 2,
        libraryAlbums: 2,
        abouts: 1,
    });
});

test('a timeout is retried; an unreachable host is not', async (t) => {
    let timeouts = 0;
    const { enrich } = harness(t, {
        answer: (url, body) => {
            if (url.host === 'query.wikidata.org' && timeouts < 2) {
                timeouts += 1;
                throw new DOMException('timed out', 'TimeoutError');
            }
            return services(url, body);
        },
    });
    assert.equal((await enrich.run()).stopped, null);
    assert.equal(timeouts, 2);
    assert.ok(enrich.album(TEN) !== null);
});
