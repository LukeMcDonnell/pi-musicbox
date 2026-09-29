import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCdReactor } from './cd-autoplay.ts';
import { discFromState, type CdState } from './cd.ts';

const NONE: CdState = { present: false };
const DISC: CdState = { present: true, tracks: 3 };

function harness(autoPlay = true) {
    const calls: string[] = [];
    const react = createCdReactor({
        setCd: async (state) => {
            calls.push(`setCd ${state?.present ?? null}`);
            return state?.present ? discFromState(state, false) : null;
        },
        playCd: async (n) => void calls.push(`play ${n.join(',')}`),
        removeCdTracks: async () => void calls.push('remove'),
        autoPlay: () => autoPlay,
        log: () => {},
    });
    return { calls, react };
}

test('a disc going into an empty drive plays it', async () => {
    const { calls, react } = harness();
    await react(DISC, NONE);
    assert.deepEqual(calls, ['setCd true', 'play 1,2,3']);
});

test('THE REDEPLOY: a disc already in when the server starts is not played', async () => {
    const { calls, react } = harness();
    await react(DISC, null);
    assert.deepEqual(calls, ['setCd true']);
});

test('auto-play off: the disc is announced but not played', async () => {
    const { calls, react } = harness(false);
    await react(DISC, NONE);
    assert.deepEqual(calls, ['setCd true']);
});

test('removing the disc drops its tracks from the queue', async () => {
    const { calls, react } = harness();
    await react(NONE, DISC);
    assert.deepEqual(calls, ['setCd false', 'remove']);
});

test('the helper going away is unknown, not a removal', async () => {
    const { calls, react } = harness();
    await react(null, DISC);
    assert.deepEqual(calls, ['setCd null']);
});

test('MPD being down is logged, not thrown', async () => {
    const react = createCdReactor({
        setCd: async (state) => (state?.present ? discFromState(state, false) : null),
        playCd: async () => {
            throw new Error('MPD is not connected');
        },
        removeCdTracks: async () => {},
        autoPlay: () => true,
        log: () => {},
    });
    await react(DISC, NONE);
});
