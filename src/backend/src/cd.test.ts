import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    CdUnavailableError,
    cdInfoOf,
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

test('only a disc goes on the wire', () => {
    assert.deepEqual(cdInfoOf({ present: true, tracks: 3 }), { tracks: 3 });
    assert.equal(cdInfoOf({ present: false }), null);
    assert.equal(cdInfoOf(null), null);
});

test('playing the disc replaces the queue with every track in order', () => {
    assert.deepEqual(cdPlayCommands(3), [
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
