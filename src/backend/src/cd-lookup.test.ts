import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { NOT_FOUND_TTL_MS, createCdArtResolver, createCdLookup, pickRelease } from './cd-lookup.ts';

// The real answer for Pearl Jam's Ten, trimmed to the fields read.
const TEN = JSON.parse(
    readFileSync(new URL('./fixtures/musicbrainz-discid-ten.json', import.meta.url), 'utf8'),
) as { id: string; releases: Array<Record<string, unknown>> };
const DISC = TEN.id;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

interface Call {
    url: string;
    userAgent: string | null;
}

function fakeFetch(answers: { mb?: () => Response; art?: () => Response } = {}) {
    const calls: Call[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, userAgent: new Headers(init?.headers).get('user-agent') });
        if (url.includes('coverartarchive.org')) {
            return answers.art?.() ?? new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
        }
        return answers.mb?.() ?? Response.json(TEN);
    }) as typeof fetch;
    return { impl, calls };
}

async function harness(t: { after: (fn: () => Promise<void> | void) => void }, answers = {}, now = () => 1_000_000) {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-cdlookup-'));
    const db = openDb({ path: ':memory:' });
    t.after(async () => {
        db.close();
        await rm(dir, { recursive: true, force: true });
    });
    const f = fakeFetch(answers);
    const lookup = createCdLookup({ db, artDir: dir, userAgent: 'musicbox/test ( x )', fetch: f.impl, now, minIntervalMs: 0 });
    return { lookup, calls: f.calls, dir, db };
}

test('the pressing with a front cover is chosen, and its medium gives the titles', () => {
    const release = pickRelease(TEN, DISC)!;
    assert.equal(release.releaseId, '8d0bc6d4-8700-44e8-90c8-b86c23e7ff14');
    assert.equal(release.album, 'Ten');
    assert.equal(release.artist, 'Pearl Jam');
    assert.equal(release.tracks.length, 11);
    assert.deepEqual(release.tracks[0], { title: 'Once', artist: 'Pearl Jam' });
    assert.equal(release.tracks[2].title, 'Alive');
});

test('a release without a front loses to one with, whatever MusicBrainz ordered', () => {
    const [first, ...rest] = TEN.releases;
    const body = { releases: [{ ...first, 'cover-art-archive': { front: false } }, ...rest] };
    assert.equal(pickRelease(body, DISC)!.releaseId, (rest[0] as { id: string }).id);
});

test('a medium that is not this disc is never used', () => {
    assert.equal(pickRelease(TEN, 'someOtherDisc-'), null);
});

test('a found disc brings its cover home and names it', async (t) => {
    const { lookup, calls, dir } = await harness(t);
    const result = await lookup.find(DISC);
    assert.equal(result.status, 'found');
    assert.ok(result.status === 'found');
    assert.equal(result.image, '/api/cd/art?release=8d0bc6d4-8700-44e8-90c8-b86c23e7ff14');
    assert.deepEqual(await readFile(join(dir, '8d0bc6d4-8700-44e8-90c8-b86c23e7ff14.jpg')), JPEG);
    // MusicBrainz turns away clients that do not say who they are.
    assert.ok(calls.every((c) => c.userAgent === 'musicbox/test ( x )'));
    assert.match(calls[0].url, /\/ws\/2\/discid\/7ERaumle6LFsf\.EAoXTUaW3juc4-\?inc=recordings\+artist-credits&fmt=json$/);
});

test('the second time is from the database and the disk: nothing is fetched', async (t) => {
    const { lookup, calls } = await harness(t);
    await lookup.find(DISC);
    const before = calls.length;
    const again = await lookup.find(DISC);
    assert.equal(again.status, 'found');
    assert.equal(calls.length, before);
});

test('not on MusicBrainz: remembered for a week, then asked again', async (t) => {
    let clock = 1_000_000;
    const { lookup, calls } = await harness(t, { mb: () => new Response('{}', { status: 404 }) }, () => clock);
    assert.equal((await lookup.find(DISC)).status, 'not-found');
    assert.equal((await lookup.find(DISC)).status, 'not-found');
    assert.equal(calls.length, 1);
    clock += NOT_FOUND_TTL_MS + 1;
    await lookup.find(DISC);
    assert.equal(calls.length, 2);
});

test('a network failure is not remembered: the disc is asked about again', async (t) => {
    const { lookup, calls } = await harness(t, {
        mb: () => {
            throw new TypeError('fetch failed');
        },
    });
    assert.equal((await lookup.find(DISC)).status, 'failed');
    assert.equal((await lookup.find(DISC)).status, 'failed');
    assert.equal(calls.length, 2);
});

test('a missing cover still finds the disc, and is tried again next time', async (t) => {
    const { lookup, calls } = await harness(t, { art: () => new Response('nope', { status: 404 }) });
    const first = await lookup.find(DISC);
    assert.ok(first.status === 'found');
    assert.equal(first.image, null);
    await lookup.find(DISC);
    assert.equal(calls.filter((c) => c.url.includes('coverartarchive')).length, 2);
    assert.equal(calls.filter((c) => c.url.includes('musicbrainz')).length, 1);
});

test('the cover resolver serves only release IDs, and sees a file the moment it lands', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-cdart-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const resolver = createCdArtResolver(dir);
    const id = '8d0bc6d4-8700-44e8-90c8-b86c23e7ff14';
    assert.equal(await resolver.resolve('../../etc/passwd'), null);
    assert.equal(await resolver.resolve(id), null);
    await writeFile(join(dir, `${id}.jpg`), JPEG);
    assert.equal((await resolver.resolve(id))?.size, JPEG.length);
});
