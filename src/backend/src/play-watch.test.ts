import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, type Snapshot, type Track } from '../../shared/api.ts';
import { createPlayWatch } from './play-watch.ts';
import type { Plays, TrackPlay } from './plays.ts';

/** Records what it was told, so a test can assert on plays without a database. */
function recorder(): Plays & { recorded: TrackPlay[] } {
    const recorded: TrackPlay[] = [];
    return {
        recorded,
        recentAlbums: () => [],
        mostPlayedArtists: () => [],
        record: (play) => void recorded.push(play),
        onChange: () => () => {},
    };
}

function song(file: string, id: number): Track {
    return {
        id,
        file,
        title: file,
        album: 'Ænima',
        albumArtist: 'Tool',
        release: 'mb:aenima',
        image: '/api/art?album=Tool',
    };
}

interface FrameOptions {
    at: number;
    track?: Track | null;
    state?: Snapshot['state'];
    elapsed?: number | null;
    source?: Snapshot['source'];
    status?: Snapshot['status'];
}

function frame({ at, track = song('a.flac', 1), state = 'play', elapsed = 0, source = 'mpd', status = 'ok' }: FrameOptions): Snapshot {
    return {
        apiVersion: API_VERSION,
        status,
        source,
        state,
        bluetooth: null,
        repeat: false,
        random: false,
        single: false,
        consume: false,
        track,
        elapsed,
        duration: 300,
        queueVersion: 1,
        queueLength: 2,
        queuePosition: 0,
        serverTime: at,
    };
}

const SECOND = 1000;

test('a track skipped after five seconds is not a play', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    watch.observe(frame({ at: 0 }));
    watch.observe(frame({ at: 5 * SECOND, track: song('b.flac', 2) }));
    assert.deepEqual(plays.recorded, []);
});

test('a track played for thirty seconds is', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    watch.observe(frame({ at: 0 }));
    watch.observe(frame({ at: 30 * SECOND, track: song('b.flac', 2) }));
    assert.deepEqual(
        plays.recorded.map((p) => p.file),
        ['a.flac'],
    );
});

test('the play carries the tags, so the shelf needs no MPD lookup', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    watch.observe(frame({ at: 0 }));
    watch.observe(frame({ at: 60 * SECOND, track: song('b.flac', 2) }));
    assert.deepEqual(plays.recorded[0], {
        file: 'a.flac',
        title: 'a.flac',
        artist: undefined,
        album: 'Ænima',
        albumArtist: 'Tool',
        release: 'mb:aenima',
        image: '/api/art?album=Tool',
    });
});

test('four minutes with no frames in between still counts — idle says nothing meanwhile', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    watch.observe(frame({ at: 0 }));
    watch.observe(frame({ at: 240 * SECOND, track: song('b.flac', 2) }));
    assert.equal(plays.recorded.length, 1);
});

test('time spent paused does not accrue', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    watch.observe(frame({ at: 0 }));
    // Paused after 10s, resumed an hour later, skipped 10s after that.
    watch.observe(frame({ at: 10 * SECOND, state: 'pause', elapsed: 10 }));
    watch.observe(frame({ at: 3610 * SECOND, state: 'play', elapsed: 10 }));
    watch.observe(frame({ at: 3620 * SECOND, track: song('b.flac', 2) }));
    assert.deepEqual(plays.recorded, []);
});

test('a pause in the middle of a long listen still leaves it a play', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    watch.observe(frame({ at: 0 }));
    watch.observe(frame({ at: 20 * SECOND, state: 'pause', elapsed: 20 }));
    watch.observe(frame({ at: 600 * SECOND, state: 'play', elapsed: 20 }));
    watch.observe(frame({ at: 615 * SECOND, track: song('b.flac', 2) }));
    assert.equal(plays.recorded.length, 1);
});

test('the last track of a queue is banked by the frame that reports the stop', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    watch.observe(frame({ at: 0 }));
    watch.observe(frame({ at: 200 * SECOND, track: null, state: 'stop', elapsed: null }));
    assert.deepEqual(
        plays.recorded.map((p) => p.file),
        ['a.flac'],
    );
});

test('stopping and playing the same track again is two plays, not one long one', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    watch.observe(frame({ at: 0 }));
    watch.observe(frame({ at: 60 * SECOND, state: 'stop', elapsed: null }));
    watch.observe(frame({ at: 61 * SECOND, elapsed: 0 }));
    watch.observe(frame({ at: 121 * SECOND, track: song('b.flac', 2) }));
    assert.equal(plays.recorded.length, 2);
});

test('repeat-one replays the same songid, and elapsed falling back is the only tell', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    watch.observe(frame({ at: 0, elapsed: 0 }));
    watch.observe(frame({ at: 120 * SECOND, elapsed: 120 }));
    // Round it goes again: same file, same id, position back to the top.
    watch.observe(frame({ at: 300 * SECOND, elapsed: 0 }));
    watch.observe(frame({ at: 420 * SECOND, track: song('b.flac', 2) }));
    assert.deepEqual(
        plays.recorded.map((p) => p.file),
        ['a.flac', 'a.flac'],
    );
});

test('a small seek is not a restart', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    watch.observe(frame({ at: 0, elapsed: 0 }));
    watch.observe(frame({ at: 40 * SECOND, elapsed: 39 }));
    watch.observe(frame({ at: 41 * SECOND, elapsed: 38 }));
    watch.observe(frame({ at: 80 * SECOND, track: song('b.flac', 2) }));
    assert.equal(plays.recorded.length, 1);
});

test('a phone taking over ends the MPD play and records nothing of its own', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    watch.observe(frame({ at: 0 }));
    watch.observe(frame({ at: 60 * SECOND, source: 'bluetooth', track: { image: null, title: 'Whatever' } }));
    watch.observe(frame({ at: 300 * SECOND, source: 'bluetooth', track: { image: null, title: 'Whatever' } }));
    assert.deepEqual(
        plays.recorded.map((p) => p.file),
        ['a.flac'],
    );
});

test('MPD going unavailable banks what was playing and stops there', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    watch.observe(frame({ at: 0 }));
    watch.observe(frame({ at: 60 * SECOND, status: 'unavailable', track: null, state: 'stop', elapsed: null }));
    watch.observe(frame({ at: 600 * SECOND, status: 'unavailable', track: null, state: 'stop', elapsed: null }));
    assert.equal(plays.recorded.length, 1);
});

test('the extra frames a client causes change nothing', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    watch.observe(frame({ at: 0, elapsed: 0 }));
    // /api/status and every SSE connect call refresh(), which publishes.
    for (let i = 1; i <= 10; i++) watch.observe(frame({ at: i * SECOND, elapsed: i }));
    watch.observe(frame({ at: 11 * SECOND, track: song('b.flac', 2) }));
    assert.deepEqual(plays.recorded, []);
});

test('a play is recorded once, however many frames carried it', () => {
    const plays = recorder();
    const watch = createPlayWatch(plays);
    for (let i = 0; i <= 60; i++) watch.observe(frame({ at: i * SECOND, elapsed: i }));
    watch.observe(frame({ at: 61 * SECOND, track: song('b.flac', 2) }));
    assert.equal(plays.recorded.length, 1);
});
