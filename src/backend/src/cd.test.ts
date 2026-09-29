import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    CdUnavailableError,
    discFromState,
    cdPlayCommands,
    createCdWatcher,
    parseCdState,
    sendCdControl,
    type CdState,
} from './cd.ts';

test('the helper documents parse', () => {
    assert.deepEqual(parseCdState('{"present":true,"tracks":11}\n'), { present: true, tracks: 11 });
    assert.deepEqual(parseCdState('{"present":false}'), { present: false });
});

test('anything else is unknown, never "no disc"', () => {
    for (const bad of [null, '', '{', '[]', '{}', '{"present":true}', '{"present":true,"tracks":0}',
        '{"present":true,"tracks":2.5}', '{"present":"false"}']) {
        assert.equal(parseCdState(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
});

const TOC = { first: 1, leadout: 900, offsets: [150, 450], data: [false, false] };

test('a table of contents is kept when it is consistent, and dropped when not', () => {
    assert.deepEqual(parseCdState(JSON.stringify({ present: true, tracks: 2, toc: TOC })), {
        present: true,
        tracks: 2,
        toc: TOC,
    });
    for (const toc of [
        { ...TOC, offsets: [450, 150] },
        { ...TOC, leadout: 300 },
        { ...TOC, data: [false] },
        { ...TOC, first: 0 },
        { ...TOC, offsets: [150, '450'] },
    ]) {
        assert.deepEqual(parseCdState(JSON.stringify({ present: true, tracks: 2, toc })), { present: true, tracks: 2 });
    }
});

test('the drive alone gives durations and a disc ID, and says the lookup is due', () => {
    const disc = discFromState({ tracks: 2, toc: TOC }, true);
    assert.deepEqual(disc.tracks.map((t) => [t.number, t.duration]), [[1, 4], [2, 6]]);
    assert.equal(typeof disc.info.discId, 'string');
    assert.equal(disc.info.lookup, 'pending');
    assert.equal(discFromState({ tracks: 2, toc: TOC }, false).info.lookup, 'off');
});

test('without a TOC there is no ID to look up: tracks 1..N, no durations', () => {
    const disc = discFromState({ tracks: 3 }, true);
    assert.deepEqual(disc.tracks.map((t) => [t.number, t.duration]), [[1, null], [2, null], [3, null]]);
    assert.equal(disc.info.discId, null);
    assert.equal(disc.info.lookup, 'not-found');
});

test('playing the disc replaces the queue with every track in order', () => {
    assert.deepEqual(cdPlayCommands([1, 2, 3]), [
        'clear',
        'add "cdda:///1"',
        'add "cdda:///2"',
        'add "cdda:///3"',
        'play',
    ]);
});

test('the watcher reports each change with the value it replaced', async (t) => {
    let text: string | null = '{"present":false}';
    const seen: Array<[CdState | null, CdState | null]> = [];
    const w = createCdWatcher({
        path: '/nonexistent/musicbox-cd/cd.json',
        deps: { readText: async () => text },
        onChange: (next, previous) => void seen.push([next, previous]),
    });
    t.after(() => w.stop());
    await w.poll();
    text = '{"present":true,"tracks":9}';
    await w.poll();
    await w.poll();
    assert.deepEqual(seen, [
        [{ present: false }, null],
        [{ present: true, tracks: 9 }, { present: false }],
    ]);
});

test('eject with no helper fails fast and says why', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-cd-'));
    try {
        await assert.rejects(() => sendCdControl('eject', join(dir, 'control')), CdUnavailableError);
        await assert.rejects(() => sendCdControl('eject', join(dir, 'control')), /setup-cd\.sh/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
