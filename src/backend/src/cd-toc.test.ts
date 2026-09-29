import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioTracks, discIdOf, type Toc } from './cd-toc.ts';

// Pearl Jam, Ten — read off the device, and the ID confirmed by MusicBrainz.
const TEN: Toc = {
    first: 1,
    leadout: 240517,
    offsets: [150, 17525, 39547, 65122, 80135, 105915, 129832, 141990, 157772, 180202, 199570],
    data: Array(11).fill(false),
};

test('the disc ID matches MusicBrainz', () => {
    assert.equal(discIdOf(TEN), '7ERaumle6LFsf.EAoXTUaW3juc4-');
});

test('durations come from the offsets, the last from the lead-out', () => {
    const tracks = audioTracks(TEN);
    assert.equal(tracks.length, 11);
    assert.deepEqual(tracks[0], { number: 1, duration: 232 }); // MusicBrainz: 231893ms
    assert.deepEqual(tracks[10], { number: 11, duration: 546 }); // (240517 - 199570) / 75
});

test('an Enhanced CD: the trailing data track is neither played nor counted', () => {
    const enhanced: Toc = { first: 1, leadout: 90000, offsets: [150, 20000, 60000], data: [false, false, true] };
    const tracks = audioTracks(enhanced);
    assert.deepEqual(tracks.map((t) => t.number), [1, 2]);
    // The audio session ends 11400 frames before the data track starts.
    assert.equal(tracks[1].duration, Math.round((60000 - 11400 - 20000) / 75));
    // As if the disc held only its audio session, ending there.
    const audioOnly: Toc = { first: 1, leadout: 60000 - 11400, offsets: [150, 20000], data: [false, false] };
    assert.equal(discIdOf(enhanced), discIdOf(audioOnly));
});

test('a leading data track is skipped, and the audio keeps its real numbers', () => {
    const mixed: Toc = { first: 1, leadout: 50000, offsets: [150, 10000, 30000], data: [true, false, false] };
    assert.deepEqual(audioTracks(mixed).map((t) => t.number), [2, 3]);
});
