import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCdSession } from './cd-session.ts';
import type { CdDisc, CdState } from './cd.ts';
import type { LookupResult } from './cd-lookup.ts';

const DISC: CdState = {
    present: true,
    tracks: 2,
    toc: { first: 1, leadout: 900, offsets: [150, 450], data: [false, false] },
};

const FOUND: LookupResult = {
    status: 'found',
    release: {
        releaseId: '8d0bc6d4-8700-44e8-90c8-b86c23e7ff14',
        album: 'Ten',
        artist: 'Pearl Jam',
        date: '1991-08-27',
        hasFront: true,
        tracks: [
            { title: 'Once', artist: 'Pearl Jam' },
            { title: 'Even Flow', artist: 'Pearl Jam' },
        ],
    },
    image: '/api/cd/art?release=8d0bc6d4-8700-44e8-90c8-b86c23e7ff14',
};

const tick = () => new Promise((r) => setImmediate(r));

function harness(answers: LookupResult[], enabled = true) {
    const published: Array<CdDisc | null> = [];
    let asked = 0;
    const session = createCdSession({
        publish: async (disc) => void published.push(disc),
        lookup: { find: async () => answers[Math.min(asked++, answers.length - 1)] },
        lookupEnabled: () => enabled,
        log: () => {},
        retryDelaysMs: [5],
    });
    return { session, published, asked: () => asked };
}

test('the drive is published at once, the lookup merged in after', async () => {
    const { session, published } = harness([FOUND]);
    const first = await session.update(DISC);
    assert.equal(first?.info.lookup, 'pending');
    assert.equal(first?.tracks[0].duration, 4);
    await tick();
    const last = published.at(-1)!;
    assert.equal(last.info.lookup, 'found');
    assert.equal(last.info.album, 'Ten');
    assert.equal(last.info.image, FOUND.status === 'found' ? FOUND.image : null);
    assert.deepEqual(last.tracks.map((t) => [t.title, t.duration]), [['Once', 4], ['Even Flow', 6]]);
});

test('setting off: nothing is asked', async () => {
    const { session, asked, published } = harness([FOUND], false);
    await session.update(DISC);
    await tick();
    assert.equal(asked(), 0);
    assert.equal(published.at(-1)?.info.lookup, 'off');
});

test('a failure is published and retried while the disc stays in', async (t) => {
    const { session, published, asked } = harness([{ status: 'failed', reason: 'offline' }, FOUND]);
    t.after(() => session.stop());
    await session.update(DISC);
    await tick();
    assert.equal(published.at(-1)?.info.lookup, 'failed');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(asked(), 2);
    assert.equal(published.at(-1)?.info.lookup, 'found');
});

test('an answer for a disc that has been ejected is thrown away', async () => {
    let release!: (r: LookupResult) => void;
    const published: Array<CdDisc | null> = [];
    const session = createCdSession({
        publish: async (disc) => void published.push(disc),
        lookup: { find: () => new Promise<LookupResult>((r) => (release = r)) },
        lookupEnabled: () => true,
        log: () => {},
    });
    await session.update(DISC);
    await session.update({ present: false });
    release(FOUND);
    await tick();
    assert.equal(published.at(-1), null);
});
