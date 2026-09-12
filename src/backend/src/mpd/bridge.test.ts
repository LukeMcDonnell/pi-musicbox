/**
 * Snapshot construction. These are the assertions that protect the API contract
 * agreed in the plan: every event is a COMPLETE snapshot, and the queue is
 * referenced by version rather than embedded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, trackFromTags, unavailableSnapshot } from './bridge.ts';
import type { Reply } from './protocol.ts';

/** Build a Reply the way MpdConnection would, from raw "key: value" lines. */
function reply(...lines: string[]): Reply {
    return {
        pairs: lines.map((l) => {
            const i = l.indexOf(': ');
            return [l.slice(0, i), l.slice(i + 2)] as [string, string];
        }),
    };
}

const STATUS = reply(
    'volume: 74',
    'repeat: 0',
    'random: 1',
    'single: 0',
    'consume: 0',
    'playlist: 42',
    'playlistlength: 1337',
    'state: play',
    'song: 3',
    'songid: 12',
    'elapsed: 65.482',
    'duration: 243.000',
);

const CURRENT = reply(
    'file: Radiohead/OK Computer/03 Subterranean Homesick Alien.flac',
    'Title: Subterranean Homesick Alien',
    'Artist: Radiohead',
    'Album: OK Computer',
    'Track: 3',
    'Date: 1997',
    'duration: 243.000',
    'Pos: 3',
    'Id: 12',
);

test('snapshot carries complete playback state', () => {
    const s = buildSnapshot(STATUS, CURRENT, 1_700_000_000_000);
    assert.equal(s.status, 'ok');
    assert.equal(s.state, 'play');
    assert.equal(s.volume, 74);
    assert.equal(s.random, true);
    assert.equal(s.repeat, false);
    assert.equal(s.elapsed, 65.482);
    assert.equal(s.duration, 243);
    assert.equal(s.serverTime, 1_700_000_000_000);
    assert.equal(s.track?.title, 'Subterranean Homesick Alien');
    assert.equal(s.track?.artist, 'Radiohead');
    assert.equal(s.track?.id, 12);
});

test('queuePosition comes from status.song', () => {
    const s = buildSnapshot(STATUS, CURRENT, Date.now());
    assert.equal(s.queuePosition, 3);
    // track.position carries the same number, but from currentsong.
    assert.equal(s.track?.position, 3);
});

test('queuePosition survives currentsong returning nothing', () => {
    // The reason it is read from status rather than the track: MPD can report a
    // selected song in status while currentsong gives nothing useful.
    const s = buildSnapshot(STATUS, reply(), Date.now());
    assert.equal(s.track, null);
    assert.equal(s.queuePosition, 3);
});

test('queuePosition is null when nothing is selected', () => {
    const s = buildSnapshot(reply('state: stop', 'playlist: 1', 'playlistlength: 0'), reply(), 0);
    assert.equal(s.queuePosition, null);
});

test('queue position 0 is a real position, not falsy-null', () => {
    // The first track in the queue is position 0; a `|| null` would lose it.
    const s = buildSnapshot(reply('state: play', 'song: 0', 'playlist: 2'), reply(), 0);
    assert.equal(s.queuePosition, 0);
});

test('the queue is referenced by version, never embedded', () => {
    const s = buildSnapshot(STATUS, CURRENT, Date.now());
    assert.equal(s.queueVersion, 42);
    assert.equal(s.queueLength, 1337);
    // The contract: a 37k-song library must never be serialised into an event.
    assert.equal(
        Object.prototype.hasOwnProperty.call(s, 'queue'),
        false,
        'snapshot must not embed the queue',
    );
});

test('snapshots contain no delta or patch fields', () => {
    const s = buildSnapshot(STATUS, CURRENT, Date.now()) as unknown as Record<string, unknown>;
    for (const banned of ['changed', 'delta', 'patch', 'ops', 'diff']) {
        assert.equal(
            Object.prototype.hasOwnProperty.call(s, banned),
            false,
            `snapshot must not carry '${banned}' — events are full snapshots by design`,
        );
    }
});

test('every snapshot key is present even when MPD is stopped and empty', () => {
    const full = buildSnapshot(STATUS, CURRENT, 0);
    const empty = buildSnapshot(reply('state: stop', 'playlist: 0', 'playlistlength: 0'), reply(), 0);
    // A dropped event must be recoverable from any later one, so the shape has
    // to be stable rather than sprouting and losing keys.
    assert.deepEqual(Object.keys(full).sort(), Object.keys(empty).sort());
});

test('unavailable snapshot has the same shape as a live one', () => {
    const live = buildSnapshot(STATUS, CURRENT, 0);
    const dead = unavailableSnapshot(0);
    assert.deepEqual(Object.keys(live).sort(), Object.keys(dead).sort());
    assert.equal(dead.status, 'unavailable');
    assert.equal(dead.track, null);
});

test('MPD reporting no mixer surfaces as null, not -1', () => {
    const s = buildSnapshot(reply('volume: -1', 'state: stop'), reply(), 0);
    assert.equal(s.volume, null);
});

test('unknown play states fall back to stop', () => {
    const s = buildSnapshot(reply('state: banana'), reply(), 0);
    assert.equal(s.state, 'stop');
});

test('oneshot single mode counts as single', () => {
    const s = buildSnapshot(reply('state: play', 'single: oneshot'), reply(), 0);
    assert.equal(s.single, true);
});

test('a stream without duration does not invent one', () => {
    const s = buildSnapshot(
        reply('state: play', 'elapsed: 12.0'),
        reply('file: http://example.com/stream', 'Title: Some Radio'),
        0,
    );
    assert.equal(s.duration, null);
    assert.equal(s.track?.file, 'http://example.com/stream');
});

test('absent tags are omitted rather than set to undefined keys', () => {
    const t = trackFromTags(new Map([['file', 'a.flac']]));
    assert.deepEqual(t, { file: 'a.flac' });
});

test('a tag map with no file is not a track', () => {
    assert.equal(trackFromTags(new Map([['Title', 'orphan']])), null);
});
