/**
 * Bluetooth state, observed.
 *
 * WHY THIS FILE ONLY READS
 *   The DAC handoff — pause MPD, wait for it to let go of hw:0,0, start
 *   bluealsa-aplay, and the reverse — is owned by /usr/local/bin/musicbox-bt,
 *   a root service installed by install/setup-bluetooth.sh. It is NOT owned here,
 *   deliberately:
 *
 *     - It must keep working when this server is down or being redeployed, and
 *       when someone drives MPD with `mpc` directly. Playback correctness must
 *       not depend on the web UI being alive.
 *     - Starting units and calling org.bluez.Device1.Disconnect need privilege
 *       this service does not have and should not be given. Granting it would
 *       mean a D-Bus policy file and the first child_process call in the backend.
 *
 *   So the arbiter publishes a file and this reads it. That keeps the backend at
 *   exactly one runtime dependency and zero subprocesses, and it means a bug here
 *   can make the UI wrong but can never make the audio wrong.
 *
 * WHY CONTROL GOES OUT THROUGH A FIFO AND NOT A SUBPROCESS
 *   Transport control is a UI action, so the backend does have to originate it.
 *   Its own user is in fact allowed to call org.bluez methods — BlueZ ships
 *   `<policy context="default"><allow send_destination="org.bluez"/>` — so
 *   spawning `busctl` would work. It is still not done that way:
 *
 *     - it would be the first child_process in this backend, and
 *       tests/test-bluetooth-config.sh asserts there is none, precisely so a bug
 *       here cannot reach the audio path;
 *     - `disconnect` has to be the arbiter's decision regardless, because it
 *       triggers the DAC handoff. So a channel is needed either way;
 *     - the arbiter already knows which device is connected, so the backend never
 *       has to learn D-Bus object paths.
 *
 *   sendControl() therefore writes one word to a FIFO the arbiter reads. It is
 *   fire-and-forget: the result arrives as the next snapshot, the same contract
 *   MPD commands already have. Honest here too — AVRCP status takes seconds to
 *   settle, so a synchronous answer would be a guess.
 *
 * The watch-and-poll machinery lives in state-file.ts, shared with the CD helper.
 */

import type { BluetoothInfo, PlaybackState } from '../../shared/api.ts';
import {
    DEFAULT_POLL_MS,
    FifoUnavailableError,
    createStateFileWatcher,
    writeFifoLine,
} from './state-file.ts';
import type { StateFileDeps } from './state-file.ts';

export { DEFAULT_POLL_MS };

/** Where install/setup-bluetooth.sh puts the state file. See config.bluetoothState. */
export const DEFAULT_STATE_PATH = '/run/musicbox/bluetooth.json';

/** The FIFO the arbiter reads commands from. See config.bluetoothControl. */
export const DEFAULT_CONTROL_PATH = '/run/musicbox/control';

/**
 * What the arbiter knows: the device, plus whatever AVRCP is reporting.
 *
 * `device` is the identity that goes on the wire as `Snapshot.bluetooth`. The
 * playback half feeds the top-level snapshot fields instead, because those
 * describe the active source — see src/shared/api.ts.
 *
 * Every playback field is optional. AVRCP arrives after the transport does, some
 * players report almost nothing, and `Title: "Not Provided"` is a real value
 * observed from a phone with nothing playing. Absent must always be survivable.
 */
export interface BluetoothState {
    device: BluetoothInfo;
    /** AVRCP Status mapped onto our own vocabulary, or null if not reported yet. */
    state: PlaybackState | null;
    title: string | null;
    artist: string | null;
    album: string | null;
    /** Seconds, converted from AVRCP's milliseconds. Null when unknown or zero. */
    duration: number | null;
    elapsed: number | null;
    /** 0-based, converted from AVRCP's 1-based TrackNumber. */
    queuePosition: number | null;
    queueLength: number | null;
    repeat: boolean;
    random: boolean;
    single: boolean;
}

/** AVRCP Status strings, mapped onto PlaybackState. */
function playbackState(value: unknown): PlaybackState | null {
    switch (value) {
        case 'playing':
            return 'play';
        case 'paused':
            return 'pause';
        case 'stopped':
            return 'stop';
        // AVRCP also defines forward-seek, reverse-seek and error. Seeking is
        // still playing as far as a listener is concerned; error is not.
        case 'forward-seek':
        case 'reverse-seek':
            return 'play';
        case 'error':
            return 'stop';
        default:
            return null;
    }
}

/** A non-empty string, or null. Rejects rather than coerces anything else. */
function str(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * A positive finite number, or null.
 *
 * Zero counts as absent throughout: AVRCP reports `Duration: 0` for a player
 * that has nothing loaded, and a zero duration would make the progress bar
 * divide by zero rather than mean anything.
 */
function positive(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Parse the arbiter's state document.
 *
 * Returns null for every flavour of "no device": the file missing, empty, `{}`,
 * truncated mid-write, or containing something unexpected. A malformed file must
 * degrade to "no Bluetooth" and never throw — this runs on every change of a
 * file written by another process, and a parse error taking out the snapshot
 * pipeline would be a far worse failure than a stale pill in the UI.
 *
 * `name` and `address` are required because a device with neither is not
 * something a UI can say anything useful about. Everything else is optional and
 * degrades to null individually, so a phone that reports only a title still
 * produces a usable snapshot.
 */
export function parseBluetoothState(text: string | null): BluetoothState | null {
    if (text === null) return null;
    const trimmed = text.trim();
    if (trimmed === '') return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        // Truncated mid-write, or not JSON at all.
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const raw = parsed as Record<string, unknown>;
    const name = str(raw.name);
    const address = str(raw.address);
    if (name === null || address === null) return null;

    const durationMs = positive(raw.durationMs);
    const positionMs = positive(raw.positionMs);
    const trackNumber = positive(raw.trackNumber);
    const repeat = str(raw.repeat);
    const shuffle = str(raw.shuffle);

    return {
        device: { name, address, codec: str(raw.codec) },
        state: playbackState(raw.status),
        // "Not Provided" is what a phone with nothing loaded actually sends, and
        // showing it on the panel would look like a bug rather than like silence.
        title: str(raw.title) === 'Not Provided' ? null : str(raw.title),
        artist: str(raw.artist),
        album: str(raw.album),
        duration: durationMs === null ? null : durationMs / 1000,
        // positionMs of 0 is legitimate — the start of a track — but `positive`
        // rejects it, so read it directly and only reject a non-number.
        elapsed: typeof raw.positionMs === 'number' && Number.isFinite(raw.positionMs) && raw.positionMs >= 0
            ? raw.positionMs / 1000
            : positionMs === null
              ? null
              : positionMs / 1000,
        // AVRCP counts from 1; the snapshot counts from 0, like MPD's `song`.
        queuePosition: trackNumber === null ? null : trackNumber - 1,
        queueLength: positive(raw.numberOfTracks),
        // AVRCP's Repeat is off | singletrack | alltracks | group, and Shuffle is
        // off | alltracks | group. Read-only for now; see roadmap.md.
        repeat: repeat !== null && repeat !== 'off',
        random: shuffle !== null && shuffle !== 'off',
        single: repeat === 'singletrack',
    };
}

/** Injected in tests so the watcher can be driven without a real filesystem. */
export type BluetoothDeps = StateFileDeps;

export interface BluetoothWatcherOptions {
    path?: string;
    pollMs?: number;
    deps?: BluetoothDeps;
    /** Called only when the value actually changes, never on every re-read. */
    onChange: (state: BluetoothState | null) => void;
    log?: (level: 'warn' | 'info', message: string) => void;
}

export interface BluetoothWatcher {
    poll: () => Promise<void>;
    /** Last value emitted. */
    current: () => BluetoothState | null;
    watching: () => boolean;
    /** Must be called from the server's shutdown path. */
    stop: () => void;
}

/**
 * Whether two states are the same for snapshot purposes.
 *
 * A deliberate field-by-field comparison rather than a JSON round trip, so that
 * adding a field to BluetoothState without adding it here is a visible omission
 * rather than a silent one.
 *
 * `elapsed` is INTENTIONALLY EXCLUDED. The arbiter only rewrites the state file
 * when something real changes, but its position poll can still land a few
 * milliseconds out; comparing it would make every poll a change, republish a
 * snapshot to every SSE client, and repaint the panel at 1Hz. Repaints here go
 * through the vc4 commit path that has hard-locked this board. A genuine seek
 * changes `state` or arrives as a fresh file the arbiter decided to write, so it
 * is not missed.
 */
function same(a: BluetoothState | null, b: BluetoothState | null): boolean {
    if (a === null || b === null) return a === b;
    return (
        a.device.name === b.device.name &&
        a.device.address === b.device.address &&
        a.device.codec === b.device.codec &&
        a.state === b.state &&
        a.title === b.title &&
        a.artist === b.artist &&
        a.album === b.album &&
        a.duration === b.duration &&
        a.queuePosition === b.queuePosition &&
        a.queueLength === b.queueLength &&
        a.repeat === b.repeat &&
        a.random === b.random &&
        a.single === b.single
    );
}

export function createBluetoothWatcher(opts: BluetoothWatcherOptions): BluetoothWatcher {
    return createStateFileWatcher<BluetoothState | null>({
        path: opts.path ?? DEFAULT_STATE_PATH,
        parse: parseBluetoothState,
        same,
        initial: null,
        label: 'bluetooth',
        pollMs: opts.pollMs,
        deps: opts.deps,
        onChange: (state) => opts.onChange(state),
        log: opts.log,
    });
}

/**
 * The verbs the arbiter's control FIFO understands.
 *
 * Deliberately a closed set rather than a free string: this is a line written
 * into a shell script's read loop, and "whatever the client sent" has no place
 * there. install/setup-bluetooth.sh's `handle_ctl` has the matching case arms,
 * and tests/test-bluetooth-config.sh asserts the two agree.
 */
export const CONTROL_VERBS = ['play', 'pause', 'stop', 'next', 'previous', 'disconnect'] as const;
export type ControlVerb = (typeof CONTROL_VERBS)[number];

export class BluetoothUnavailableError extends Error {}

/**
 * Send one verb to the arbiter.
 *
 * Fire-and-forget by design: the result arrives as the next snapshot, the same
 * contract MPD commands already have. A synchronous answer would be a guess —
 * AVRCP Status was measured taking about four seconds to settle.
 */
export async function sendControl(
    verb: ControlVerb,
    path: string = DEFAULT_CONTROL_PATH,
): Promise<void> {
    try {
        await writeFifoLine(path, verb);
    } catch (err) {
        if (err instanceof FifoUnavailableError) {
            throw new BluetoothUnavailableError(
                'the Bluetooth arbiter is not running (musicbox-bt-monitor)',
            );
        }
        throw err;
    }
}
