/**
 * Reading the Bluetooth arbiter's state file.
 *
 * This is a boundary between two processes written in different languages, which
 * is the kind of seam that breaks quietly. Two properties matter more than the
 * rest:
 *
 *   1. NOTHING HERE MAY THROW. The file is written by a root bash service on its
 *      own schedule. A parse error propagating out of the watcher would take the
 *      snapshot pipeline with it — turning "the pill is wrong" into "the web UI is
 *      down", which is a far worse failure for a box with no keyboard.
 *   2. THE WATCH MUST SURVIVE A RENAME. The arbiter writes a temp file and
 *      renames it over the target so a reader never sees half a document. An
 *      fs.watch on the path itself follows the old inode and goes permanently
 *      silent after one event; the directory watch is what makes it work. The
 *      rename test below is the one that catches that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { open as fsOpen, constants as fsConstants } from 'node:fs/promises';
import {
    BluetoothUnavailableError,
    CONTROL_VERBS,
    DEFAULT_POLL_MS,
    DEFAULT_STATE_PATH,
    createBluetoothWatcher,
    parseBluetoothState,
    sendControl,
    type BluetoothDeps,
} from './bluetooth.ts';

/**
 * Open a FIFO for reading without blocking, the way the arbiter holds its control
 * channel open. O_RDWR rather than O_RDONLY: a read-only open on a FIFO blocks
 * until a writer appears, which is the same trap sendControl avoids on the other
 * side.
 */
function openFileForTest(path: string) {
    return fsOpen(path, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
}

const VALID = '{"name":"Luke\'s iPhone","address":"AA:BB:CC:DD:EE:FF","codec":"aptX HD"}';

test('a well-formed device-only document parses', () => {
    const s = parseBluetoothState(VALID);
    assert.deepEqual(s?.device, {
        name: "Luke's iPhone",
        address: 'AA:BB:CC:DD:EE:FF',
        codec: 'aptX HD',
    });
    // Everything AVRCP has not reported yet degrades individually, not as a group.
    assert.equal(s?.state, null);
    assert.equal(s?.title, null);
    assert.equal(s?.elapsed, null);
    assert.equal(s?.queueLength, null);
});

test('the full AVRCP document parses, with units converted', () => {
    /*
     * The exact shape install/setup-bluetooth.sh publishes, captured from a real
     * Pixel 8 Pro. AVRCP speaks milliseconds and counts tracks from 1; the
     * snapshot speaks seconds and counts from 0, like MPD's `song`.
     */
    const s = parseBluetoothState(
        '{"name":"Pixel 8 Pro","address":"D4:3A:2C:65:B5:D6","codec":"aptX-HD",' +
            '"status":"playing","title":"A National Acrobat","artist":"Black Sabbath",' +
            '"album":"Sabbath Bloody Sabbath","durationMs":375107,"positionMs":76472,' +
            '"trackNumber":2,"numberOfTracks":8,"repeat":"off","shuffle":"off"}',
    );
    assert.equal(s?.state, 'play');
    assert.equal(s?.title, 'A National Acrobat');
    assert.equal(s?.artist, 'Black Sabbath');
    assert.equal(s?.album, 'Sabbath Bloody Sabbath');
    assert.equal(s?.duration, 375.107);
    assert.equal(s?.elapsed, 76.472);
    assert.equal(s?.queuePosition, 1, 'AVRCP track 2 is position 1');
    assert.equal(s?.queueLength, 8);
    assert.equal(s?.repeat, false);
    assert.equal(s?.random, false);
});

test('AVRCP status maps onto our own vocabulary', () => {
    const at = (status: string) =>
        parseBluetoothState(`{"name":"P","address":"A","status":"${status}"}`)?.state;
    assert.equal(at('playing'), 'play');
    assert.equal(at('paused'), 'pause');
    assert.equal(at('stopped'), 'stop');
    // Seeking is still playing as far as a listener is concerned; error is not.
    assert.equal(at('forward-seek'), 'play');
    assert.equal(at('reverse-seek'), 'play');
    assert.equal(at('error'), 'stop');
    // Anything unrecognised must not become a plausible-looking state.
    assert.equal(at('dancing'), null);
});

test('"Not Provided" is not a title', () => {
    /*
     * What a phone with nothing loaded actually sends, observed on the device.
     * Rendering it on the panel would look like a bug rather than like silence.
     */
    const s = parseBluetoothState('{"name":"P","address":"A","title":"Not Provided"}');
    assert.equal(s?.title, null);
});

test('a zero duration is absent, but a zero position is real', () => {
    /*
     * AVRCP reports Duration: 0 for a player with nothing loaded, and a zero
     * duration would make the progress bar divide by zero rather than mean
     * anything. Position 0 is different — it is the start of a track.
     */
    const s = parseBluetoothState('{"name":"P","address":"A","durationMs":0,"positionMs":0}');
    assert.equal(s?.duration, null);
    assert.equal(s?.elapsed, 0);
});

test('repeat and shuffle are reflected from AVRCP', () => {
    const s = parseBluetoothState(
        '{"name":"P","address":"A","repeat":"singletrack","shuffle":"alltracks"}',
    );
    assert.equal(s?.repeat, true);
    assert.equal(s?.single, true, 'singletrack is MPD\'s `single`');
    assert.equal(s?.random, true);
    const off = parseBluetoothState('{"name":"P","address":"A","repeat":"off","shuffle":"off"}');
    assert.equal(off?.repeat, false);
    assert.equal(off?.single, false);
    assert.equal(off?.random, false);
});

test('a missing codec becomes null rather than undefined', () => {
    // Absent means "not negotiated yet". It must be an explicit null so the wire
    // shape is stable — the snapshot rule does not allow keys to come and go.
    const info = parseBluetoothState('{"name":"Phone","address":"AA:BB:CC:DD:EE:FF"}');
    assert.equal(info?.device.codec, null);
    assert.ok(info && 'codec' in info.device, 'codec must be present as a key');
});

test('an empty codec string is treated as absent', () => {
    // The arbiter writes "" before BlueALSA has answered; "" is not a codec name.
    assert.equal(parseBluetoothState(VALID.replace('aptX HD', ''))?.device.codec, null);
});

test('every flavour of "nothing connected" yields null', () => {
    for (const input of [
        null,                    // the file does not exist
        '',                      // created but not yet written
        '   \n ',                // whitespace only
        '{}',                    // the arbiter's explicit "disconnected" document
        '{"name":"Phone"}',      // no address
        '{"address":"AA:BB:CC:DD:EE:FF"}', // no name
        '{"name":"","address":"AA:BB:CC:DD:EE:FF"}', // empty name is not a name
        '{"name":"Phone","address":""}',
    ]) {
        assert.equal(parseBluetoothState(input), null, `expected null for ${JSON.stringify(input)}`);
    }
});

test('malformed input returns null instead of throwing', () => {
    /*
     * Caught mid-write, or the arbiter emitting something unexpected. Each of
     * these must be a quiet null: see property 1 in the header.
     */
    for (const input of [
        '{"name":"Phone","addre',   // truncated mid-write
        'null',
        'true',
        '42',
        '"a string"',
        '[{"name":"Phone","address":"AA:BB:CC:DD:EE:FF"}]', // an array, not an object
        'PCMAdded /org/bluealsa/hci0',  // a monitor line leaking into the file
        '<html>',
    ]) {
        assert.equal(parseBluetoothState(input), null, `expected null for ${JSON.stringify(input)}`);
    }
});

test('non-string fields are rejected, not coerced', () => {
    // A number would stringify into something plausible-looking and end up in the
    // UI. Reject instead.
    assert.equal(parseBluetoothState('{"name":123,"address":"AA:BB:CC:DD:EE:FF"}'), null);
    assert.equal(parseBluetoothState('{"name":"Phone","address":456}'), null);
    const numericCodec = parseBluetoothState('{"name":"P","address":"A","codec":7}');
    assert.equal(numericCodec?.device.codec, null, 'a non-string codec must degrade to null');
});

test('the default path matches what setup-bluetooth.sh writes', () => {
    // If these drift the UI silently never shows a device, with nothing else
    // misbehaving — the same failure mode as the art musicRoot. The bash suite
    // asserts the other side of this string.
    assert.equal(DEFAULT_STATE_PATH, '/run/musicbox/bluetooth.json');
});

/** A fake reader, so change detection is asserted by counting rather than timing. */
function fakeDeps(script: Array<string | null>): BluetoothDeps & { reads: number } {
    const state = { reads: 0 };
    return {
        get reads() {
            return state.reads;
        },
        readText: async () => {
            const i = Math.min(state.reads, script.length - 1);
            state.reads += 1;
            return script[i];
        },
    };
}

test('onChange fires only when the value actually changes', async () => {
    /*
     * The watcher polls and also wakes on every write in the directory, so it
     * re-reads far more often than the value changes. Emitting each time would
     * republish a snapshot to every SSE client — and on the panel every repaint
     * is a vc4 atomic commit, the path implicated in the clock deadlock.
     */
    const seen: Array<string | null> = [];
    const deps = fakeDeps([null, VALID, VALID, VALID, '{}']);
    const w = createBluetoothWatcher({
        path: '/nonexistent-dir-for-this-test/bluetooth.json',
        pollMs: 60_000,
        deps,
        onChange: (i) => seen.push(i?.device.name ?? null),
    });
    try {
        for (let n = 0; n < 5; n += 1) await w.poll();
        assert.deepEqual(seen, ["Luke's iPhone", null], 'one emit per real change, no repeats');
    } finally {
        w.stop();
    }
});

test('stop() silences the watcher even if a poll is already queued', async () => {
    const seen: unknown[] = [];
    const deps = fakeDeps([VALID]);
    const w = createBluetoothWatcher({
        path: '/nonexistent-dir-for-this-test/bluetooth.json',
        pollMs: 60_000,
        deps,
        onChange: (i) => seen.push(i),
    });
    w.stop();
    await w.poll();
    assert.deepEqual(seen, [], 'nothing may be published after stop()');
});

test('a missing directory does not throw at construction', async () => {
    /*
     * The normal state on a dev machine and on a box where setup-bluetooth.sh has
     * not been run: /run/musicbox does not exist. Constructing the watcher must
     * not throw, and the poll must pick the file up once it does appear — which is
     * exactly what happens the first time the arbiter starts.
     */
    const base = await mkdtemp(join(tmpdir(), 'musicbox-bt-'));
    try {
        const missing = join(base, 'not-created-yet', 'bluetooth.json');
        const seen: Array<string | null> = [];
        const w = createBluetoothWatcher({
            path: missing,
            pollMs: 60_000,
            onChange: (i) => seen.push(i?.device.name ?? null),
        });
        try {
            await w.poll();
            assert.deepEqual(seen, [], 'an absent file is not a change from the initial null');
            assert.equal(w.current(), null);
        } finally {
            w.stop();
        }
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

/**
 * Await a promise, or fail with a useful message instead of hanging.
 *
 * Without this a broken watch makes the test sit until the backstop poll rescues
 * it and then PASS — which is exactly how the first version of the rename test
 * below managed to survive the mutation it was written to catch.
 */
async function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const bomb = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
    });
    try {
        return await Promise.race([p, bomb]);
    } finally {
        clearTimeout(timer!);
    }
}

test('THE BOOT ORDER: the watch is established once the directory appears', async () => {
    /*
     * This is the normal startup path, not an edge case, and getting it wrong is
     * invisible.
     *
     * /run/musicbox is created by the arbiter's RuntimeDirectory, and the web
     * server is deliberately NOT ordered after the arbiter — so at boot the
     * directory reliably does not exist yet and the first fs.watch fails with
     * ENOENT. Observed on the device: the watch was never retried, so the feature
     * ran on 10-second polling forever and just looked sluggish.
     *
     * The poll must therefore re-arm the watch, and once armed the inotify path
     * must actually work — which the final replacement here proves, because no
     * further poll is issued.
     */
    const base = await mkdtemp(join(tmpdir(), 'musicbox-bt-'));
    try {
        const dir = join(base, 'created-later');
        const target = join(dir, 'bluetooth.json');

        const changes: Array<string | null> = [];
        let announce: () => void = () => {};
        const nextChange = () =>
            new Promise<void>((r) => {
                announce = r;
            });

        const w = createBluetoothWatcher({
            path: target,
            pollMs: 3_600_000, // unreachable: every arrival below must come from a poll we make, or inotify
            onChange: (i) => {
                changes.push(i?.device.name ?? null);
                announce();
            },
        });
        try {
            assert.equal(w.watching(), false, 'nothing to watch yet');
            await w.poll();
            assert.equal(w.watching(), false, 'still nothing to watch');
            assert.deepEqual(changes, []);

            // The arbiter starts: directory appears, then a file in it.
            await mkdir(dir, { recursive: true });
            await writeFile(target, '{}');
            await w.poll();
            assert.equal(w.watching(), true, 'the poll must re-arm the watch once the directory exists');

            // From here on inotify alone has to carry it. No further poll.
            const arrived = nextChange();
            const tmp = join(dir, 'bluetooth.json.tmp');
            await writeFile(tmp, VALID);
            await rename(tmp, target);
            await within(5_000, 'an event from the re-armed watch', arrived);
            assert.deepEqual(changes, ["Luke's iPhone"]);
        } finally {
            w.stop();
        }
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('THE RENAME: repeated rename-replacement keeps being noticed', async () => {
    /*
     * The assertion this file exists for, and it needs TWO replacements to have
     * any teeth.
     *
     * The arbiter writes a temp file and renames it over the target, so a reader
     * never sees a partial document. inotify watches an INODE: a rename over the
     * target unlinks the watched inode, and Node still reports that first event —
     * so a one-replacement test passes happily against watch(path) and proves
     * nothing. It is the SECOND replacement that is lost, because the watch is by
     * then pointed at a dead inode. Watching the directory survives both.
     *
     * Two writes is also the real sequence: the arbiter publishes the device as
     * soon as it connects, then publishes again once BlueALSA reports the
     * negotiated codec. Losing the second write leaves "codec pending" on screen
     * permanently.
     */
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-bt-'));
    try {
        const target = join(dir, 'bluetooth.json');
        await writeFile(target, '{}');

        const changes: Array<string | null> = [];
        let announce: () => void = () => {};
        const nextChange = () =>
            new Promise<void>((r) => {
                announce = r;
            });

        const w = createBluetoothWatcher({
            path: target,
            // An hour: the backstop poll must be UNREACHABLE here, or it quietly
            // does inotify's job and the test proves nothing. The first version of
            // this test used 60s and passed against a dead watch by waiting for it.
            pollMs: 3_600_000,
            onChange: (i) => {
                changes.push(i?.device.codec ?? null);
                announce();
            },
        });

        /** Replace by rename, exactly as the arbiter does. */
        const publish = async (body: string) => {
            const tmp = join(dir, 'bluetooth.json.tmp');
            await writeFile(tmp, body);
            await rename(tmp, target);
        };

        try {
            await w.poll();
            assert.deepEqual(changes, [], 'an empty document is no device');

            // First replacement: the phone connects, codec not yet negotiated.
            let arrived = nextChange();
            await publish('{"name":"Luke\'s iPhone","address":"AA:BB:CC:DD:EE:FF"}');
            await within(5_000, 'the connect event', arrived);
            assert.deepEqual(changes, [null], 'the connect must arrive');

            /*
             * Settle before the second write, and do NOT remove this.
             *
             * One replacement produces several inotify events, so several reads are
             * in flight. Without this pause one of them lands after the second
             * rename and reports its content — which makes this test pass against a
             * watch(path) that is already dead. Verified: with the settle removed,
             * the mutation survives.
             */
            await new Promise((r) => setTimeout(r, 250));

            // Second replacement: the codec is now known. THIS is the one a
            // file-path watch loses, because its inode was unlinked by the first.
            arrived = nextChange();
            await publish(VALID);
            await within(5_000, 'the SECOND rename event (is the watch on the directory?)', arrived);
            assert.deepEqual(changes, [null, 'aptX HD'], 'the second write must arrive too');
            assert.equal(w.current()?.device.codec, 'aptX HD');
        } finally {
            w.stop();
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a deleted state file reads as disconnected', async () => {
    // The arbiter truncates rather than deletes, but a --revert or a tmpfs wipe
    // deletes. Both must mean "no phone", not "keep the last phone forever".
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-bt-'));
    try {
        const target = join(dir, 'bluetooth.json');
        await writeFile(target, VALID);
        const seen: Array<string | null> = [];
        const w = createBluetoothWatcher({
            path: target,
            pollMs: 60_000,
            onChange: (i) => seen.push(i?.device.name ?? null),
        });
        try {
            await w.poll();
            await unlink(target);
            await w.poll();
            assert.deepEqual(seen, ["Luke's iPhone", null]);
        } finally {
            w.stop();
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the poll interval is a backstop, not a UI latency budget', () => {
    // If this ever shrinks to something that looks like a refresh rate, the
    // inotify path has probably stopped working and someone papered over it.
    assert.ok(DEFAULT_POLL_MS >= 5_000, `poll is ${DEFAULT_POLL_MS}ms — too eager to be a safety net`);
});

/*
 * ---------------------------------------------------------------------------
 * sendControl — the way out.
 *
 * The property that matters is that it NEVER BLOCKS. Opening a FIFO for writing
 * waits for a reader, so on a box with no arbiter running a plain open would hang
 * the HTTP request until the client gave up. The `within()` deadlines below are
 * the real assertions; the error type is secondary.
 * ---------------------------------------------------------------------------
 */

test('every control verb is one the arbiter handles', () => {
    // The arbiter's `handle_ctl` case arms are the other half of this list, and
    // tests/test-bluetooth-config.sh asserts that side. A verb added here without
    // a case arm there would be accepted by the API and silently do nothing.
    assert.deepEqual([...CONTROL_VERBS], ['play', 'pause', 'stop', 'next', 'previous', 'disconnect']);
});

test('a missing FIFO fails fast and says why', async () => {
    const err = await within(
        3_000,
        'sendControl to reject a missing FIFO',
        sendControl('play', '/nonexistent-dir/control').then(
            () => null,
            (e: unknown) => e,
        ),
    );
    assert.ok(err instanceof BluetoothUnavailableError, `got ${String(err)}`);
    assert.match((err as Error).message, /arbiter is not running/);
});

test('THE HANG: a FIFO with no reader fails fast instead of blocking', async () => {
    /*
     * The assertion this block exists for. A real FIFO that nobody is reading is
     * exactly the state of a box whose arbiter has stopped, and it is the case a
     * blocking open would wedge on — indefinitely, holding a request open.
     *
     * Remove the O_NONBLOCK from sendControl and this test hangs until its
     * deadline rather than passing.
     */
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-ctl-'));
    try {
        const fifo = join(dir, 'control');
        await new Promise<void>((resolve, reject) => {
            execFile('mkfifo', [fifo], (e) => (e ? reject(e) : resolve()));
        });
        const err = await within(
            3_000,
            'sendControl to reject a readerless FIFO',
            sendControl('pause', fifo).then(
                () => null,
                (e: unknown) => e,
            ),
        );
        assert.ok(err instanceof BluetoothUnavailableError, `got ${String(err)}`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a verb reaches a reader that is listening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-ctl-'));
    try {
        const fifo = join(dir, 'control');
        await new Promise<void>((resolve, reject) => {
            execFile('mkfifo', [fifo], (e) => (e ? reject(e) : resolve()));
        });

        // Hold it open for reading, exactly as the arbiter does with `exec 9<>`,
        // and collect what arrives.
        const reader = await openFileForTest(fifo);
        try {
            await within(3_000, 'the write to land', sendControl('next', fifo));
            const buf = Buffer.alloc(64);
            const { bytesRead } = await reader.read(buf, 0, buf.length, null);
            assert.equal(buf.subarray(0, bytesRead).toString('utf8'), 'next\n');
        } finally {
            await reader.close();
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('THE REPLACED DIRECTORY: the watch re-arms when the run dir is recreated', async () => {
    /*
     * systemd deletes and recreates a RuntimeDirectory on every restart of the
     * owning unit, so this happens whenever the arbiter is restarted — which a
     * deploy does. inotify watches an inode, so the watch survives the call but
     * points at a directory that no longer exists and never fires again.
     *
     * Observed on the device exactly this way: the arbiter was publishing a
     * correct, stable state file and /api/status reported nothing at all. The
     * slow poll was the only thing still working, which is precisely the kind of
     * "it's a bit laggy" symptom that hides a dead mechanism.
     *
     * Same trap as the rename test above, one level up the tree.
     */
    const base = await mkdtemp(join(tmpdir(), 'musicbox-bt-'));
    try {
        const dir = join(base, 'run');
        const target = join(dir, 'bluetooth.json');
        await mkdir(dir, { recursive: true });
        await writeFile(target, '{}');

        const changes: Array<string | null> = [];
        let announce: () => void = () => {};
        const nextChange = () =>
            new Promise<void>((r) => {
                announce = r;
            });

        const w = createBluetoothWatcher({
            path: target,
            // Unreachable: only inotify, or a poll we make ourselves, may satisfy this.
            pollMs: 3_600_000,
            onChange: (i) => {
                changes.push(i?.device.name ?? null);
                announce();
            },
        });
        try {
            await w.poll();
            assert.equal(w.watching(), true, 'armed on the original directory');

            // The arbiter restarts: systemd removes the directory and makes a new one.
            await rm(dir, { recursive: true, force: true });
            await mkdir(dir, { recursive: true });

            // One poll is what notices the inode changed and re-arms.
            await w.poll();
            assert.equal(w.watching(), true, 'the poll must re-arm on the new directory');

            // And inotify alone now has to carry a write. No further poll.
            const arrived = nextChange();
            const tmp = join(dir, 'bluetooth.json.tmp');
            await writeFile(tmp, VALID);
            await rename(tmp, target);
            await within(5_000, 'an event from the re-armed watch', arrived);
            assert.deepEqual(changes, ["Luke's iPhone"]);
        } finally {
            w.stop();
        }
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});
