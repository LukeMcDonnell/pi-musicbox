/**
 * The MPD bridge: keeps a live picture of MPD's state and tells listeners when
 * it changes.
 *
 * TWO CONNECTIONS, and this is not an optimisation — it is required. MPD's
 * `idle` blocks its connection until something changes, so a connection sitting
 * in idle cannot also carry commands. One connection idles and drives updates;
 * the other issues commands.
 *
 * MPD BEING DOWN IS A NORMAL STATE, not an error. The server starts in parallel
 * with mpd.service at boot and must not fail when MPD has not come up yet, nor
 * die when MPD restarts. Both connections reconnect with backoff, and the
 * snapshot reports status 'unavailable' in the meantime.
 */

import type { Snapshot, Track, PlaybackState, BackendStatus } from '../../../shared/api.ts';
import { API_VERSION } from '../../../shared/api.ts';
import { MpdConnection, firstValue, groupBy, quoteArg, type Reply } from './protocol.ts';
import { artUriFor } from '../art.ts';
import type { BluetoothState } from '../bluetooth.ts';

/** Subsystems worth waking up for. */
const IDLE_SUBSYSTEMS = 'player mixer playlist options update';

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

/**
 * MPD closes a connection that sends nothing for `connection_timeout` seconds,
 * which defaults to 60. The command connection is idle most of the time — it
 * only carries commands — so without a keepalive MPD hangs up on it about once a
 * minute. Measured on the device before this existed: reconnects at 62s, 62s,
 * 70s intervals, each one briefly flashing "MPD is not running" in the UI.
 *
 * The idle connection needs no keepalive: it is blocked in `idle`, which MPD
 * exempts from the timeout.
 */
const KEEPALIVE_MS = 20_000;

/**
 * How long a lost command connection may stay lost before the UI is told.
 *
 * Reconnecting takes ~500ms and `systemctl restart mpd` takes ~2s. Publishing
 * "unavailable" the instant a socket drops turns both of those into a visible
 * error for the user, which is worse than briefly showing slightly stale state.
 * A genuine outage still surfaces, just after this grace period.
 */
const UNAVAILABLE_GRACE_MS = 3_000;

export interface BridgeOptions {
    host: string;
    port: number;
    connectTimeoutMs: number;
    log: (level: 'info' | 'warn' | 'error', msg: string) => void;
    /** Overridable for tests, which cannot wait 20s. */
    keepaliveMs?: number;
    unavailableGraceMs?: number;
    /** Reply deadline per command; see DEFAULT_REPLY_TIMEOUT_MS. */
    replyTimeoutMs?: number;
}

function num(v: string | undefined): number | undefined {
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

/** Build a Track from an MPD tag map, dropping absent fields rather than nulling them. */
export function trackFromTags(tags: Map<string, string>): Track | null {
    const file = tags.get('file');
    if (!file) return null;
    // Derived from the path alone — no I/O here. This is the one chokepoint for
    // every Track the backend produces (snapshot, queue and find all call it),
    // so setting `image` here is what guarantees it is never missing.
    const track: Track = { file, image: artUriFor(file) };
    const id = num(tags.get('Id'));
    const pos = num(tags.get('Pos'));
    if (id !== undefined) track.id = id;
    if (pos !== undefined) track.position = pos;
    if (tags.get('Title')) track.title = tags.get('Title');
    if (tags.get('Artist')) track.artist = tags.get('Artist');
    if (tags.get('Album')) track.album = tags.get('Album');
    if (tags.get('AlbumArtist')) track.albumArtist = tags.get('AlbumArtist');
    if (tags.get('Track')) track.track = tags.get('Track');
    if (tags.get('Date')) track.date = tags.get('Date');
    if (tags.get('Genre')) track.genre = tags.get('Genre');
    const dur = num(tags.get('duration') ?? tags.get('Time'));
    if (dur !== undefined) track.duration = dur;
    return track;
}

/**
 * Build a Track from what AVRCP told us about the phone.
 *
 * SEPARATE FROM trackFromTags ON PURPOSE. That function refuses to build a Track
 * without a `file`, which is the right rule for the library and is asserted — a
 * tag map with no file is a parse error, not a song. A Bluetooth track has no
 * file and never will, so it gets its own constructor rather than weakening the
 * MPD invariant to accommodate it.
 *
 * `image` is null, not a URI. There is no cover art to be had: the phone offers
 * no AVRCP cover-art channel and BlueZ implements none, and deriving one by
 * matching artist and album against the local library was considered and
 * rejected — a near-miss would show a confidently wrong cover, which is worse
 * than none. See .claude/docs/bluetooth.md.
 *
 * Returns null when the phone has told us nothing at all, so the UI shows its
 * idle state rather than an empty row of blanks.
 */
export function trackFromBluetooth(bt: BluetoothState): Track | null {
    if (bt.title === null && bt.artist === null && bt.album === null) return null;
    const track: Track = { image: null };
    if (bt.title !== null) track.title = bt.title;
    if (bt.artist !== null) track.artist = bt.artist;
    if (bt.album !== null) track.album = bt.album;
    if (bt.duration !== null) track.duration = bt.duration;
    if (bt.queuePosition !== null) track.position = bt.queuePosition;
    return track;
}

/**
 * The snapshot used whenever MPD cannot be reached.
 *
 * It still carries `bt`, because the two halves are independent: the Bluetooth
 * arbiter is a root service that does not care whether this one is healthy, so a
 * phone can perfectly well be connected and playing while MPD is down. Reporting
 * "no Bluetooth" in that state would be a lie the UI acts on.
 */
export function unavailableSnapshot(now: number, bt: BluetoothState | null = null): Snapshot {
    if (bt !== null) {
        // MPD is unreachable but a phone is playing, so the snapshot describes the
        // phone. `state: 'stop'` was hardcoded here before and was simply wrong:
        // it claimed source 'bluetooth' and stopped in the same breath while audio
        // was coming out of the speakers.
        return {
            ...bluetoothSnapshot(bt, now),
            status: 'unavailable',
        };
    }
    return {
        apiVersion: API_VERSION,
        status: 'unavailable',
        source: 'mpd',
        state: 'stop',
        bluetooth: null,
        repeat: false,
        random: false,
        single: false,
        consume: false,
        track: null,
        elapsed: null,
        duration: null,
        queueVersion: -1,
        queueLength: 0,
        queuePosition: null,
        serverTime: now,
    };
}

/**
 * The snapshot for a Bluetooth session.
 *
 * Everything here describes the PHONE, because that is the active source. MPD's
 * own position is absent, not lost: it is paused rather than stopped, so
 * disconnecting brings it back on the very next snapshot.
 *
 * `queueVersion` is -1 — there is no version to watch and no listing to fetch,
 * which is exactly the signal a client needs. The counts beside it are real
 * though: AVRCP reports "track 1 of 8", so a client can say that much honestly.
 */
function bluetoothSnapshot(bt: BluetoothState, now: number): Snapshot {
    return {
        apiVersion: API_VERSION,
        status: 'ok',
        source: 'bluetooth',
        state: bt.state ?? 'stop',
        bluetooth: bt.device,
        repeat: bt.repeat,
        random: bt.random,
        single: bt.single,
        // MPD's consume mode has no AVRCP equivalent.
        consume: false,
        track: trackFromBluetooth(bt),
        elapsed: bt.elapsed,
        duration: bt.duration,
        queueVersion: -1,
        queueLength: bt.queueLength ?? 0,
        queuePosition: bt.queuePosition,
        serverTime: now,
    };
}

/**
 * Turn MPD's `status` + `currentsong` replies into a Snapshot.
 *
 * `bt` is a parameter rather than something stamped on afterwards so this stays a
 * pure function of its inputs — which is the only reason bridge.test.ts can be a
 * pile of plain assertions with no sockets. It defaults to null, so every
 * existing three-argument call site still means what it used to.
 *
 * A CONNECTED DEVICE SHORT-CIRCUITS EVERYTHING BELOW. The snapshot then describes
 * the phone, because the phone is what is playing; MPD's replies are ignored
 * rather than blended in. This is the reverse of how it worked when the sink
 * first landed, when there was no metadata for a phone and the top-level fields
 * meant MPD. AVRCP changed what is possible, so it changed what is right.
 */
export function buildSnapshot(
    status: Reply,
    currentSong: Reply,
    now: number,
    bt: BluetoothState | null = null,
): Snapshot {
    if (bt !== null) return bluetoothSnapshot(bt, now);

    const get = (k: string) => firstValue(status, k);
    const rawState = get('state');
    const state: PlaybackState =
        rawState === 'play' || rawState === 'pause' ? rawState : 'stop';

    const songGroups = groupBy(currentSong, 'file');
    const track = songGroups.length > 0 ? trackFromTags(songGroups[0]) : null;

    return {
        apiVersion: API_VERSION,
        status: 'ok',
        source: 'mpd',
        state,
        bluetooth: null,
        // No volume: MPD runs mixer_type "none" and reports -1. See shared/api.ts.
        repeat: get('repeat') === '1',
        random: get('random') === '1',
        single: get('single') === '1' || get('single') === 'oneshot',
        consume: get('consume') === '1',
        track,
        elapsed: num(get('elapsed')) ?? null,
        duration: num(get('duration')) ?? track?.duration ?? null,
        queueVersion: num(get('playlist')) ?? -1,
        queueLength: num(get('playlistlength')) ?? 0,
        // MPD's `song` is the 0-based queue position, absent when nothing is
        // selected. Taken from status rather than currentsong so it survives
        // currentsong returning nothing.
        queuePosition: num(get('song')) ?? null,
        serverTime: now,
    };
}

type Listener = (snapshot: Snapshot) => void;

export class MpdBridge {
    private commands: MpdConnection;
    private idler: MpdConnection;
    private listeners = new Set<Listener>();
    private snapshot: Snapshot;
    private stopped = false;
    private commandBackoff = BACKOFF_MIN_MS;
    private idleBackoff = BACKOFF_MIN_MS;
    private timers = new Set<NodeJS.Timeout>();
    private unavailableTimer: NodeJS.Timeout | null = null;

    /**
     * The connected Bluetooth device, as last reported by the arbiter.
     *
     * Held here rather than read per-snapshot because snapshots are built on
     * MPD's timeline (every idle wake) and this changes on its own. See
     * src/backend/src/bluetooth.ts for why this side only observes.
     */
    private bluetooth: BluetoothState | null = null;

    // Declared explicitly rather than as a constructor parameter property:
    // those emit code, so Node's type-stripping (used by `npm test`) rejects them.
    private opts: BridgeOptions;

    constructor(opts: BridgeOptions) {
        this.opts = opts;
        this.commands = new MpdConnection({ replyTimeoutMs: opts.replyTimeoutMs });
        this.idler = new MpdConnection({ replyTimeoutMs: opts.replyTimeoutMs });
        this.snapshot = unavailableSnapshot(Date.now(), this.bluetooth);
    }

    get current(): Snapshot {
        return this.snapshot;
    }

    get status(): BackendStatus {
        return this.snapshot.status;
    }

    onSnapshot(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    start(): void {
        void this.runCommandLoop();
        void this.runIdleLoop();
    }

    stop(): void {
        this.stopped = true;
        this.unavailableTimer = null;
        for (const t of this.timers) clearTimeout(t);
        this.timers.clear();
        this.commands.close();
        this.idler.close();
    }

    /**
     * Report MPD as unavailable, but only if it is still unavailable once the
     * grace period expires. A reconnect that beats the timer cancels it, so a
     * dropped socket or an `mpd` restart never reaches the UI as an error.
     */
    private scheduleUnavailable(): void {
        if (this.unavailableTimer) return;
        const grace = this.opts.unavailableGraceMs ?? UNAVAILABLE_GRACE_MS;
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            this.unavailableTimer = null;
            if (!this.commands.connected && !this.stopped) {
                this.opts.log('warn', 'MPD still unreachable — reporting unavailable');
                this.publish(unavailableSnapshot(Date.now(), this.bluetooth));
            }
        }, grace);
        this.timers.add(timer);
        this.unavailableTimer = timer;
    }

    private cancelUnavailable(): void {
        if (!this.unavailableTimer) return;
        clearTimeout(this.unavailableTimer);
        this.timers.delete(this.unavailableTimer);
        this.unavailableTimer = null;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const t = setTimeout(() => {
                this.timers.delete(t);
                resolve();
            }, ms);
            this.timers.add(t);
        });
    }

    /** Keeps the command connection alive, refreshing the snapshot on (re)connect. */
    private async runCommandLoop(): Promise<void> {
        while (!this.stopped) {
            try {
                await this.commands.connect(
                    this.opts.host,
                    this.opts.port,
                    this.opts.connectTimeoutMs,
                );
                this.opts.log('info', `MPD command connection up (${this.commands.version})`);
                this.commandBackoff = BACKOFF_MIN_MS;
                this.cancelUnavailable();
                await this.refresh();

                // Keep the connection alive. `ping` is MPD's no-op; sending it
                // well inside connection_timeout stops MPD hanging up, and it
                // doubles as the liveness check that used to be a bare poll.
                const keepalive = this.opts.keepaliveMs ?? KEEPALIVE_MS;
                while (!this.stopped && this.commands.connected) {
                    await this.sleep(keepalive);
                    if (this.stopped || !this.commands.connected) break;
                    await this.commands.send('ping');
                }
            } catch (err) {
                this.opts.log('warn', `MPD command connection: ${(err as Error).message}`);
            }
            if (this.stopped) break;
            this.commands.close();
            // Deliberately NOT immediate — see UNAVAILABLE_GRACE_MS.
            this.scheduleUnavailable();
            await this.sleep(this.commandBackoff);
            this.commandBackoff = Math.min(this.commandBackoff * 2, BACKOFF_MAX_MS);
        }
    }

    /** Keeps the idle connection alive; every change triggers a fresh snapshot. */
    private async runIdleLoop(): Promise<void> {
        while (!this.stopped) {
            try {
                await this.idler.connect(
                    this.opts.host,
                    this.opts.port,
                    this.opts.connectTimeoutMs,
                );
                this.opts.log('info', 'MPD idle connection up');
                this.idleBackoff = BACKOFF_MIN_MS;
                while (!this.stopped && this.idler.connected) {
                    // No reply deadline: idle is SUPPOSED to block until
                    // something changes. Every other command has one.
                    await this.idler.send(`idle ${IDLE_SUBSYSTEMS}`, { timeoutMs: null });
                    if (this.stopped) break;
                    await this.refresh();
                }
            } catch (err) {
                if (!this.stopped) {
                    this.opts.log('warn', `MPD idle connection: ${(err as Error).message}`);
                }
            }
            if (this.stopped) break;
            this.idler.close();
            await this.sleep(this.idleBackoff);
            this.idleBackoff = Math.min(this.idleBackoff * 2, BACKOFF_MAX_MS);
        }
    }

    /** Re-read state and publish a complete snapshot. */
    async refresh(): Promise<void> {
        if (!this.commands.connected) return;
        try {
            const status = await this.commands.send('status');
            const song = await this.commands.send('currentsong');
            this.publish(buildSnapshot(status, song, Date.now(), this.bluetooth));
        } catch (err) {
            this.opts.log('warn', `refresh failed: ${(err as Error).message}`);
        }
    }

    /**
     * Record the connected Bluetooth device and republish.
     *
     * Republishing is the point: a phone connecting is not an MPD event, so
     * nothing would otherwise wake the idle loop and the panel would keep showing
     * the old source until MPD happened to change something. It goes through
     * refresh() when MPD is reachable so the MPD half of the snapshot is fresh
     * too — the arbiter has just paused MPD, and a snapshot claiming `play`
     * alongside a connected phone would be wrong in a way a user would notice.
     */
    async setBluetooth(info: BluetoothState | null): Promise<void> {
        this.bluetooth = info;
        if (this.stopped) return;
        if (this.commands.connected) {
            await this.refresh();
        } else {
            this.publish(unavailableSnapshot(Date.now(), this.bluetooth));
        }
    }

    private publish(snapshot: Snapshot): void {
        this.snapshot = snapshot;
        for (const fn of this.listeners) {
            try {
                fn(snapshot);
            } catch (err) {
                this.opts.log('error', `listener threw: ${(err as Error).message}`);
            }
        }
    }

    /** Run a command, then refresh so callers see the result reflected. */
    async command(cmd: string): Promise<void> {
        if (!this.commands.connected) throw new Error('MPD is not connected');
        await this.commands.send(cmd);
        await this.refresh();
    }

    async queue(): Promise<{ version: number; tracks: Track[] }> {
        if (!this.commands.connected) throw new Error('MPD is not connected');
        const reply = await this.commands.send('playlistinfo');
        const tracks = groupBy(reply, 'file')
            .map(trackFromTags)
            .filter((t): t is Track => t !== null);
        return { version: this.snapshot.queueVersion, tracks };
    }

    async find(what: string, value: string): Promise<Track[]> {
        if (!this.commands.connected) throw new Error('MPD is not connected');
        const reply = await this.commands.send(`find ${quoteArg(what)} ${quoteArg(value)}`);
        return groupBy(reply, 'file')
            .map(trackFromTags)
            .filter((t): t is Track => t !== null);
    }
}
