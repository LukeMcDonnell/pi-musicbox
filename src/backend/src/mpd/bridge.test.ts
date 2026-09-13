/**
 * Snapshot construction. These are the assertions that protect the API contract
 * agreed in the plan: every event is a COMPLETE snapshot, and the queue is
 * referenced by version rather than embedded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, trackFromBluetooth, trackFromTags, unavailableSnapshot } from './bridge.ts';
import type { BluetoothState } from '../bluetooth.ts';
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

test('the snapshot carries no volume at all', () => {
    // This box has no volume control: MPD runs mixer_type "none" and volume is
    // handled downstream by the preamp. A reappearing `volume` field would mean
    // someone gave MPD the pcm512x attenuator back, which costs bits.
    const s = buildSnapshot(reply('volume: -1', 'state: stop'), reply(), 0) as unknown as Record<
        string,
        unknown
    >;
    assert.equal(Object.prototype.hasOwnProperty.call(s, 'volume'), false);
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
    // `image` is the one field that is always present: it is derived from `file`
    // rather than from a tag, so there is no "absent" case for it.
    const t = trackFromTags(new Map([['file', 'a.flac']]));
    assert.deepEqual(t, { file: 'a.flac', image: '/api/art?album=' });
});

test('every track carries an art URI derived from its own directory', () => {
    const t = trackFromTags(new Map([['file', 'Radiohead/In Rainbows/01 - 15 Step.flac']]));
    assert.equal(t?.image, `/api/art?album=${encodeURIComponent('Radiohead/In Rainbows')}`);

    // Two tracks on the SAME album must produce the SAME URI — that identity is
    // what lets the browser cache one image per album and avoids a repaint on
    // every track change. See src/backend/src/art.ts.
    const other = trackFromTags(new Map([['file', 'Radiohead/In Rainbows/02 - Bodysnatchers.flac']]));
    assert.equal(other?.image, t?.image);
});

test('a tag map with no file is not a track', () => {
    assert.equal(trackFromTags(new Map([['Title', 'orphan']])), null);
});

/*
 * ---------------------------------------------------------------------------
 * Bluetooth. The DAC is opened raw as hw:0,0, so MPD and the Bluetooth sink can
 * never both hold it — `source` is a hard statement about who owns the hardware,
 * not a hint. install/setup-bluetooth.sh enforces the exclusion on the device;
 * these guard the half of it that reaches the UI.
 * ---------------------------------------------------------------------------
 */

/** What the arbiter publishes for a phone that is playing. See bluetooth.ts. */
const PHONE: BluetoothState = {
    device: { name: "Luke's iPhone", address: 'AA:BB:CC:DD:EE:FF', codec: 'aptX-HD' },
    state: 'play',
    title: 'A National Acrobat',
    artist: 'Black Sabbath',
    album: 'Sabbath Bloody Sabbath',
    duration: 375.107,
    elapsed: 76.472,
    queuePosition: 1,
    queueLength: 8,
    repeat: false,
    random: false,
    single: false,
};

/** A phone that has connected but told us nothing yet. */
const SILENT: BluetoothState = {
    device: { name: 'Pixel', address: 'D4:3A:2C:65:B5:D6', codec: null },
    state: null,
    title: null,
    artist: null,
    album: null,
    duration: null,
    elapsed: null,
    queuePosition: null,
    queueLength: null,
    repeat: false,
    random: false,
    single: false,
};

test('a connected device flips source to bluetooth and names itself', () => {
    const s = buildSnapshot(STATUS, CURRENT, 0, PHONE);
    assert.equal(s.source, 'bluetooth');
    assert.deepEqual(s.bluetooth, PHONE.device);
});

test('no connected device leaves source as mpd', () => {
    // The default must be the MPD case: every existing three-argument call site
    // in this file depends on it, and so does the whole pre-Bluetooth codebase.
    assert.equal(buildSnapshot(STATUS, CURRENT, 0).source, 'mpd');
    assert.equal(buildSnapshot(STATUS, CURRENT, 0).bluetooth, null);
    assert.equal(buildSnapshot(STATUS, CURRENT, 0, null).source, 'mpd');
});

test('THE ACTIVE SOURCE: a Bluetooth snapshot describes the phone, not MPD', () => {
    /*
     * This replaces a test that asserted the exact opposite — that MPD's fields
     * survived a Bluetooth connection so the play button could resume in place.
     * That was right while a phone had no readable metadata: the top-level fields
     * meant MPD and clients were told to branch on `source`.
     *
     * AVRCP changed what is possible, so it changed what is right. `state`,
     * `track`, `elapsed` and `duration` now answer "what is playing". MPD's
     * position is not lost — it is paused, not stopped, so disconnecting brings
     * it back on the next snapshot — it is simply not what you are hearing.
     */
    const s = buildSnapshot(STATUS, CURRENT, 0, PHONE);
    assert.equal(s.state, 'play', "the phone's state, not MPD's pause");
    assert.equal(s.track?.title, 'A National Acrobat');
    assert.equal(s.track?.artist, 'Black Sabbath');
    assert.equal(s.elapsed, 76.472);
    assert.equal(s.duration, 375.107);

    // None of MPD's numbers leak through. STATUS says elapsed 65.482, song 3,
    // playlistlength 1337 — all absent here.
    assert.notEqual(s.elapsed, 65.482);
    assert.equal(s.queuePosition, 1, "the phone's track 2 of 8, 0-based");
    assert.equal(s.queueLength, 8);
    assert.equal(s.track?.file, undefined, 'a phone track has no library file');
});

test('MPD comes straight back when the phone goes away', () => {
    // The reassurance the replaced test was really about: nothing is destroyed by
    // a session, so the very next snapshot has MPD's position again.
    const during = buildSnapshot(STATUS, CURRENT, 0, PHONE);
    assert.equal(during.source, 'bluetooth');
    const after = buildSnapshot(STATUS, CURRENT, 0, null);
    assert.equal(after.source, 'mpd');
    assert.equal(after.elapsed, 65.482);
    assert.equal(after.queuePosition, 3);
    assert.equal(after.queueLength, 1337);
});

test('a queue listing is refused, not faked, for Bluetooth', () => {
    /*
     * queueVersion -1 is the signal not to fetch. A phone exposes no track list at
     * all — AVRCP browsing is not exposed by BlueZ — so anything else here would
     * send a client after a listing that cannot exist. The counts beside it ARE
     * real: "track 2 of 8" came from the phone.
     */
    const s = buildSnapshot(STATUS, CURRENT, 0, PHONE);
    assert.equal(s.queueVersion, -1);
    assert.equal(s.queueLength, 8);
    assert.equal(s.queuePosition, 1);
});

test('a Bluetooth track carries no cover art, deliberately', () => {
    /*
     * Not an oversight and not pending. The phone advertises AVRCP 1.6, which does
     * specify Cover Art, but offers no OBEX channel to fetch it over and BlueZ
     * implements none either. Borrowing a cover from the local library by matching
     * artist and album was considered and rejected: a near-miss would show a
     * confidently wrong cover, and a missing cover is obvious where a wrong one is
     * misinformation.
     */
    const s = buildSnapshot(STATUS, CURRENT, 0, PHONE);
    assert.equal(s.track?.image, null);
    assert.ok(s.track && 'image' in s.track, 'image must still be a key');
});

test('a snapshot with a connected device has the same keys as one without', () => {
    // The key-parity rule, extended to the new field: `bluetooth` is null when
    // nothing is connected, never an absent key.
    const withBt = buildSnapshot(STATUS, CURRENT, 0, PHONE);
    const without = buildSnapshot(STATUS, CURRENT, 0);
    assert.deepEqual(Object.keys(withBt).sort(), Object.keys(without).sort());
    assert.deepEqual(
        Object.keys(unavailableSnapshot(0, PHONE)).sort(),
        Object.keys(unavailableSnapshot(0)).sort(),
    );
});

test('MPD being down does not hide a connected phone', () => {
    /*
     * The two halves are independent: the arbiter is a root service that does not
     * care whether this one is healthy, so a phone can be connected and playing
     * while MPD is dead. It used to report `state: 'stop'` here while claiming
     * source 'bluetooth' — stopped and playing in the same breath.
     */
    const dead = unavailableSnapshot(0, PHONE);
    assert.equal(dead.status, 'unavailable');
    assert.equal(dead.source, 'bluetooth');
    assert.deepEqual(dead.bluetooth, PHONE.device);
    assert.equal(dead.state, 'play', 'the phone is audibly playing');
    assert.equal(dead.track?.title, 'A National Acrobat');
});

test('a phone that has told us nothing yet still produces a usable snapshot', () => {
    // Between the transport appearing and the phone answering. The device must be
    // reported — that is what the UI needs to offer a disconnect — but there is no
    // track and nothing is claimed to be playing.
    const s = buildSnapshot(STATUS, CURRENT, 0, SILENT);
    assert.equal(s.source, 'bluetooth');
    assert.equal(s.bluetooth?.name, 'Pixel');
    assert.equal(s.state, 'stop');
    assert.equal(s.track, null);
    assert.equal(s.elapsed, null);
    assert.equal(s.queueLength, 0);
});

test('repeat and shuffle come from the phone during a session', () => {
    const s = buildSnapshot(STATUS, CURRENT, 0, { ...PHONE, repeat: true, single: true, random: true });
    assert.equal(s.repeat, true);
    assert.equal(s.single, true);
    assert.equal(s.random, true);
    // STATUS has random: 1, repeat: 0 — MPD's values must not leak in.
    const mpd = buildSnapshot(STATUS, CURRENT, 0);
    assert.equal(mpd.repeat, false);
    assert.equal(mpd.random, true);
});

test('a device whose codec is not yet negotiated is still reported', () => {
    // A connect is visible before the codec is known; null means "not yet", and
    // must not suppress the device.
    const s = buildSnapshot(STATUS, CURRENT, 0, {
        ...PHONE,
        device: { ...PHONE.device, codec: null },
    });
    assert.equal(s.source, 'bluetooth');
    assert.equal(s.bluetooth?.codec, null);
    assert.equal(s.bluetooth?.name, "Luke's iPhone");
});

test('trackFromBluetooth refuses to build a row out of nothing', () => {
    // A phone with no metadata at all gets no track, so the UI shows its idle
    // state rather than a row of blanks.
    assert.equal(trackFromBluetooth(SILENT), null);
    assert.ok(trackFromBluetooth({ ...SILENT, title: 'Something' }));
});

test('trackFromTags still refuses a tag map with no file', () => {
    /*
     * Track.file became optional for Bluetooth's sake, and this is the invariant
     * that must NOT have loosened with it: for MPD, no file means no song. A
     * Bluetooth track gets its own constructor precisely so this stays strict.
     */
    assert.equal(trackFromTags(new Map([['Title', 'orphan']])), null);
});
