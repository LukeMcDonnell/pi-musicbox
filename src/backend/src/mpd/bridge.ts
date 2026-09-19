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
import {
    MpdConnection,
    firstOf,
    firstValue,
    groupBy,
    groupByMulti,
    quoteArg,
    type Reply,
} from './protocol.ts';
import { artUriFor } from '../art.ts';
import { releaseIdOf } from '../release.ts';
import type { BluetoothState } from '../bluetooth.ts';

/**
 * Subsystems worth waking up for.
 *
 * `database` joined this list for the library index: it is the subsystem MPD
 * announces when a scan has actually CHANGED the song database, where `update`
 * only says a scan started or stopped. Both are watched — `update` alone would
 * miss nothing in practice, but the index is cheap to rebuild and showing music
 * that is not there is not.
 */
const IDLE_SUBSYSTEMS = 'player mixer playlist options update database';

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

/**
 * Render filter pairs as MPD command arguments.
 *
 * Each half goes through `quoteArg` separately. This is the whole defence
 * against a tag value containing a quote or a backslash reaching the command
 * line as syntax — `Guns N' Roses` and friends are real entries here — and it is
 * why callers pass pairs rather than pre-built strings.
 *
 * Deliberately the LEGACY `find <tag> "<value>"` form rather than MPD 0.21's
 * filter expressions `"(base 'x')"`. A filter expression needs its own escaping
 * INSIDE the quoting this already does, and six of this library's top-level
 * directories contain an apostrophe. One escaping layer that is provably right
 * beats two that are nearly right.
 */
function filterArgs(pairs: Array<[string, string]>): string {
    return pairs.map(([k, v]) => `${quoteArg(k)} ${quoteArg(v)}`).join(' ');
}

function num(v: string | undefined): number | undefined {
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

/**
 * The container, from the file extension: `FLAC`, `MP3`, `APE`.
 *
 * MPD REPORTS NO CODEC — not on `find`, not on `currentsong` — and the extension
 * is the only signal that does not need the NFS share, which is routinely not
 * mounted. Nothing is inferred from it beyond upper-casing: `.m4a` answers
 * `M4A`, not `AAC`, because that container holds ALAC just as happily.
 *
 * Absent for a stream, and for anything whose last segment has no plausible
 * extension.
 */
function encodingOf(file: string): string | undefined {
    const name = file.slice(file.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return undefined;
    const ext = name.slice(dot + 1);
    return /^[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toUpperCase() : undefined;
}

/** Build a Track from an MPD tag map, dropping absent fields rather than nulling them. */
export function trackFromTags(tags: Map<string, string>): Track | null {
    const file = tags.get('file');
    if (!file) return null;
    // Derived from the path alone — no I/O here. This is the one chokepoint for
    // every Track the backend produces (snapshot, queue and find all call it),
    // so setting `image` here is what guarantees it is never missing.
    const track: Track = { file, image: artUriFor(file) };
    const encoding = encodingOf(file);
    if (encoding !== undefined) track.encoding = encoding;
    const id = num(tags.get('Id'));
    const pos = num(tags.get('Pos'));
    if (id !== undefined) track.id = id;
    if (pos !== undefined) track.position = pos;
    if (tags.get('Title')) track.title = tags.get('Title');
    if (tags.get('Artist')) track.artist = tags.get('Artist');
    if (tags.get('Album')) track.album = tags.get('Album');
    if (tags.get('AlbumArtist')) track.albumArtist = tags.get('AlbumArtist');
    // The one album fact a Track carries. Derived from the tags and the path, so
    // it costs nothing here — the play log and the now-playing link both need it.
    const release = releaseIdOf(tags.get('MUSICBRAINZ_ALBUMID'), file);
    if (release !== null) track.release = release;
    if (tags.get('Track')) track.track = tags.get('Track');
    if (tags.get('Disc')) track.disc = tags.get('Disc');
    if (tags.get('Date')) track.date = tags.get('Date');
    if (tags.get('OriginalDate')) track.originalDate = tags.get('OriginalDate');
    if (tags.get('Format')) track.format = tags.get('Format');
    if (tags.get('Added')) track.addedAt = tags.get('Added');
    const dur = num(tags.get('duration') ?? tags.get('Time'));
    if (dur !== undefined) track.duration = dur;
    return track;
}

/**
 * A library song: a Track plus the tags a Track deliberately does not carry.
 *
 * THESE ARE ALBUM FACTS, and putting them on every Track would repeat them once
 * per row for no gain — a UUID on each of the Beatles' 495 songs, and ten genre
 * strings on each of Pink Floyd's 309. `albumsFromSongs` folds them up to the
 * AlbumSummary, which is where the contract exposes them. (`Track.release` is
 * the deliberate exception; see the note on it in api.ts.)
 *
 * Only the library browse path builds these. `queue()` and `currentsong` have no
 * use for them and go on using `trackFromTags` directly.
 */
export interface LibrarySong {
    track: Track;
    /** Every `Genre` value, in order. Empty when untagged. */
    genres: string[];
    label?: string;
    mbAlbumId?: string;
    mbReleaseGroupId?: string;
    mbArtistId?: string;
}

/**
 * Tidy the `Genre` values MPD hands back.
 *
 * Two kinds of mess, both measured on this library and neither worth pushing out
 * to every client: 39 values are a `;`-joined run-on inside ONE tag — the worst
 * is 146 characters — and three albums carry bare ID3v1 genre indices as text,
 * so a genre reads "17". Split, trim, drop the empties and drop the numbers.
 *
 * Only `;`. One album uses ", " the same way, and splitting on a comma would
 * break every genuine genre name that contains one.
 */
function cleanGenres(values: string[]): string[] {
    const out: string[] = [];
    for (const value of values) {
        for (const part of value.split(';')) {
            const genre = part.trim();
            if (genre !== '' && !/^\d+$/.test(genre)) out.push(genre);
        }
    }
    return out;
}

/** Build a LibrarySong from a multi-value tag map. Track still comes from the one chokepoint. */
export function songFromTags(tags: Map<string, string[]>): LibrarySong | null {
    const track = trackFromTags(firstOf(tags));
    if (track === null) return null;
    const song: LibrarySong = { track, genres: cleanGenres(tags.get('Genre') ?? []) };
    const first = (key: string): string | undefined => tags.get(key)?.[0];
    const label = first('Label');
    const albumId = first('MUSICBRAINZ_ALBUMID');
    const groupId = first('MUSICBRAINZ_RELEASEGROUPID');
    const artistId = first('MUSICBRAINZ_ALBUMARTISTID');
    if (label) song.label = label;
    if (albumId) song.mbAlbumId = albumId;
    if (groupId) song.mbReleaseGroupId = groupId;
    if (artistId) song.mbArtistId = artistId;
    return song;
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

/** Told which MPD subsystems changed, for callers that care about more than playback. */
type IdleListener = (subsystems: readonly string[]) => void;

/** Told when MPD's update job id changes. `null` means no scan is running. */
type UpdatingListener = (was: number | null, job: number | null) => void;

export class MpdBridge {
    private commands: MpdConnection;
    private idler: MpdConnection;
    private listeners = new Set<Listener>();
    private idleListeners = new Set<IdleListener>();
    private updatingListeners = new Set<UpdatingListener>();

    /** MPD's `updating_db`, as of the last refresh. Null when nothing is scanning. */
    private updating: number | null = null;
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

    /**
     * Told which subsystems MPD reported on each idle wake.
     *
     * SEPARATE FROM onSnapshot because a snapshot deliberately says nothing
     * about the library — it is about what is playing, and the snapshot rule
     * keeps it that way. The library index needs to know the song database
     * changed, and that fact has nowhere else to travel.
     */
    onIdle(fn: IdleListener): () => void {
        this.idleListeners.add(fn);
        return () => this.idleListeners.delete(fn);
    }

    /** MPD's current update job id, or null when it is not scanning. */
    get updatingDb(): number | null {
        return this.updating;
    }

    /**
     * Told when a scan starts or ends.
     *
     * NOT onIdle: that is announced BEFORE the refresh that reads the new
     * status, so a listener there sees the previous job id and never sees a
     * scan end at all. This fires from refresh(), where the value is parsed.
     *
     * The listener must not call refresh(), command() or runAll() — it is
     * already inside one.
     */
    onUpdating(fn: UpdatingListener): () => void {
        this.updatingListeners.add(fn);
        return () => this.updatingListeners.delete(fn);
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
                    const woke = await this.idler.send(`idle ${IDLE_SUBSYSTEMS}`, {
                        timeoutMs: null,
                    });
                    if (this.stopped) break;
                    // MPD answers idle with one `changed: <subsystem>` line per
                    // subsystem. Announce them before refreshing, so a listener
                    // that invalidates a cache has done so by the time anything
                    // reacts to the new snapshot.
                    this.announceIdle(woke.pairs.filter(([k]) => k === 'changed').map(([, v]) => v));
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
            // After publish, so a listener reacting to a scan sees a current
            // snapshot. Deliberately not on the Snapshot itself — see shared/api.ts.
            const job = num(firstValue(status, 'updating_db')) ?? null;
            if (job !== this.updating) {
                const was = this.updating;
                this.updating = job;
                this.announceUpdating(was, job);
            }
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

    private announceUpdating(was: number | null, job: number | null): void {
        for (const fn of this.updatingListeners) {
            try {
                fn(was, job);
            } catch (err) {
                this.opts.log('error', `updating listener threw: ${(err as Error).message}`);
            }
        }
    }

    private announceIdle(subsystems: string[]): void {
        if (subsystems.length === 0) return;
        for (const fn of this.idleListeners) {
            try {
                fn(subsystems);
            } catch (err) {
                this.opts.log('error', `idle listener threw: ${(err as Error).message}`);
            }
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

    /**
     * `find`, the exact-match search, as Tracks.
     *
     * VARIADIC PAIRS because the library screens need two filters at once
     * (`albumartist X album Y`) and MPD takes them as consecutive arguments. It
     * took a single pair when it was written as a seam for this work and had no
     * callers, so widening it cost nothing.
     *
     * EXACT AND CASE SENSITIVE, unlike `search`. That is not a limitation here,
     * it is the point: every value passed in came out of MPD's own tag database
     * in the first place. It is also dramatically cheaper — measured on this
     * library, `search` takes 100ms where `find` takes 11ms, because `search`
     * is a substring scan.
     */
    async find(...pairs: Array<[string, string]>): Promise<Track[]> {
        const reply = await this.send(`find ${filterArgs(pairs)}`);
        return groupBy(reply, 'file')
            .map(trackFromTags)
            .filter((t): t is Track => t !== null);
    }

    /**
     * The first match only, via `window 0:1`.
     *
     * The cheap way to ask "what is one song that satisfies this?", which is how
     * the library index turns a directory into the tag name filed under it. MPD
     * applies the window after filtering, so this saves the transfer, not the
     * scan — which is why library.ts asks with `base` (an indexed path prefix,
     * 0.23ms) rather than a tag (a full scan, 11ms).
     */
    async findFirst(...pairs: Array<[string, string]>): Promise<Track | null> {
        const reply = await this.send(`find ${filterArgs(pairs)} window 0:1`);
        const groups = groupBy(reply, 'file');
        return groups.length > 0 ? trackFromTags(groups[0]) : null;
    }

    /**
     * `find`, keeping the album tags a Track drops. Same command, same cost —
     * MPD was already sending the genres and the MusicBrainz ids.
     */
    async findSongs(...pairs: Array<[string, string]>): Promise<LibrarySong[]> {
        const reply = await this.send(`find ${filterArgs(pairs)}`);
        return groupByMulti(reply, 'file')
            .map(songFromTags)
            .filter((s): s is LibrarySong => s !== null);
    }

    /**
     * Songs newest first by the `Added` tag, one window of them.
     *
     * The filter is the whole library and is constant — nothing here is built
     * from anything a client sent. Measured on this library: 1000 songs in
     * 372ms, which is 80 albums once grouped. See library.recentlyAdded.
     */
    async songsByAdded(offset: number, count: number): Promise<LibrarySong[]> {
        const window = `${Math.max(0, Math.trunc(offset))}:${Math.max(0, Math.trunc(offset + count))}`;
        const reply = await this.send(`find "(base \\"\\")" sort -Added window ${window}`);
        return groupByMulti(reply, 'file')
            .map(songFromTags)
            .filter((s): s is LibrarySong => s !== null);
    }

    /** `findFirst`, keeping the album tags. See findSongs. */
    async findFirstSong(...pairs: Array<[string, string]>): Promise<LibrarySong | null> {
        const reply = await this.send(`find ${filterArgs(pairs)} window 0:1`);
        const groups = groupByMulti(reply, 'file');
        return groups.length > 0 ? songFromTags(groups[0]) : null;
    }

    /**
     * `count group <tag>` — song count and playtime for every value of a tag.
     *
     * One command for the whole library: `count group albumartist` answers for
     * all 488 artists in 35ms, measured. The alternative is a `find` per artist
     * at 11.4ms each. Raw Reply, for the reason `list` gives above.
     */
    async count(group: string): Promise<Reply> {
        return this.send(`count group ${quoteArg(group)}`);
    }

    /**
     * `list <tag> [group <tag>]` — distinct tag values, optionally grouped.
     *
     * Returns the raw Reply rather than something parsed: a grouped reply is a
     * flat stream of alternating keys whose structure depends on what was asked
     * for, and `groupBy` at the call site says what the caller expects far more
     * clearly than a general-purpose shape would.
     */
    async list(tag: string, group?: string): Promise<Reply> {
        const cmd = group === undefined
            ? `list ${quoteArg(tag)}`
            : `list ${quoteArg(tag)} group ${quoteArg(group)}`;
        return this.send(cmd);
    }

    /** `lsinfo <path>` — one level of MPD's directory tree. '' is the root. */
    async lsinfo(path: string): Promise<Reply> {
        return this.send(`lsinfo ${quoteArg(path)}`);
    }

    /**
     * Ask MPD to scan the library, returning its job id.
     *
     * RETURNS IMMEDIATELY, which is the only reason this is safe: a scan on this
     * library runs for the better part of an hour, and a reply timeout would
     * destroy the connection. MPD answers `updating_db: <job>` and gets on with it.
     */
    async update(uri?: string): Promise<number | null> {
        return this.startScan('update', uri);
    }

    /** As `update`, but re-reads every tag rather than only what changed. */
    async rescan(uri?: string): Promise<number | null> {
        return this.startScan('rescan', uri);
    }

    private async startScan(verb: 'update' | 'rescan', uri?: string): Promise<number | null> {
        const reply = await this.send(uri === undefined ? verb : `${verb} ${quoteArg(uri)}`);
        return num(firstValue(reply, 'updating_db')) ?? null;
    }

    /** MPD's `stats`: the library's counts, and its own uptime. */
    async stats(): Promise<Reply> {
        return this.send('stats');
    }

    /** Shared guard-and-send for the read-only queries above. */
    private async send(command: string): Promise<Reply> {
        if (!this.commands.connected) throw new Error('MPD is not connected');
        return this.commands.send(command);
    }

    /**
     * Run several commands, then refresh ONCE.
     *
     * Replacing the queue is `clear`, `findadd`, `play` — three commands that are
     * one action. Sending them through `command()` would query `status` and
     * `currentsong` after each, so a caller would pay for three snapshots and the
     * first would describe an empty queue that existed for a millisecond.
     *
     * Not atomic: MPD's idle connection can still wake between them. That is
     * harmless here precisely because of the snapshot rule — a client that sees
     * the intermediate state is corrected by the next frame a millisecond later,
     * having merged nothing.
     *
     * Named `runAll` rather than `commands` because `this.commands` is already
     * the command CONNECTION — the two cannot share a name on one class.
     */
    async runAll(cmds: string[]): Promise<void> {
        if (!this.commands.connected) throw new Error('MPD is not connected');
        for (const cmd of cmds) await this.commands.send(cmd);
        await this.refresh();
    }
}
