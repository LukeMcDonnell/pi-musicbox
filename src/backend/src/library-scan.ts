/**
 * Scanning the library: when it happens, and what happened last time.
 *
 * `auto_update` is off, a full scan takes 48m40s, and MPD cannot cancel one.
 * Why the schedule is a tick and not a timer, and why the history row opens at
 * the start, are in .claude/docs/decisions.md.
 */

import { stat } from 'node:fs/promises';
import type {
    LibraryScan,
    LibraryState,
    LibraryStats,
    ScanOutcome,
    ScanTrigger,
    BackendStatus,
} from '../../shared/api.ts';
import type { Db } from './db.ts';
import type { Settings } from './settings.ts';
import { firstValue, type Reply } from './mpd/protocol.ts';

/** How often the scheduler looks at the clock. */
export const TICK_MS = 60_000;

/** How long after startup a boot scan waits, so it is not racing the automount. */
export const BOOT_DELAY_MS = 120_000;

/** How long to keep waiting for MPD before giving up on the boot scan. */
const BOOT_RETRY_MS = 30_000;
const BOOT_RETRIES = 5;

/** How late a scan may be and still run: past this, a clock jump caused it. */
export const MAX_LATE_MS = 60 * 60 * 1000;

/** How many finished scans to keep. Nothing reads them but a person over ssh. */
const HISTORY_LIMIT = 20;

/** How long to wait on the music share before calling it unreachable. */
const PROBE_TIMEOUT_MS = 4_000;

/** Structural, not MpdBridge itself, so the tests never open a socket. */
export interface ScanBridge {
    readonly status: BackendStatus;
    readonly updatingDb: number | null;
    onUpdating(fn: (was: number | null, job: number | null) => void): () => void;
    update(uri?: string): Promise<number | null>;
    rescan(uri?: string): Promise<number | null>;
    stats(): Promise<Reply>;
}

/** A scan this box will not start, and why the route should say so. */
export class ScanRefusedError extends Error {
    code: 409 | 503;
    constructor(message: string, code: 409 | 503) {
        super(message);
        this.code = code;
    }
}

export interface LibraryScanner {
    /** The last published state. Cheap — no probe, no MPD round trip. */
    state(): LibraryState;
    /** Re-probe the music share, then return the state. For the GET. */
    refresh(): Promise<LibraryState>;
    scan(trigger: ScanTrigger): Promise<void>;
    start(): void;
    stop(): void;
    onChange(fn: (state: LibraryState) => void): () => void;
}

export interface LibraryScannerOptions {
    bridge: ScanBridge;
    db: Db;
    settings: Settings;
    musicRoot: string;
    log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
    now?: () => number;
    tickMs?: number;
    bootDelayMs?: number;
    /** Test seam: whether the music share can be read. */
    probe?: (root: string) => Promise<boolean>;
    /**
     * Called after a scan that ran to completion, while the share is still warm.
     *
     * An explicit hook rather than an edge inferred from onChange: a listener
     * watching `scanning` go true-then-false cannot tell a finished scan from an
     * interrupted one, and re-reading the share after a scan that died half way
     * is how a partial harvest would get written. It may take a while — the
     * `.nfo` harvest is about a minute — so it is awaited off the tick, and
     * anything it throws is logged rather than allowed to escape.
     */
    onScanComplete?: () => Promise<void>;
}

/** Midnight-relative wall clock: the given hour today, in local time. */
export function atHour(hour: number, now: number): number {
    const d = new Date(now);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
}

/** When the next scheduled scan falls due, or null when scheduling is off. */
export function nextScanAt(hour: number, now: number): number | null {
    if (hour < 0) return null;
    const today = atHour(hour, now);
    if (today > now) return today;
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
}

/**
 * Whether a scheduled scan is due on this tick.
 *
 * An edge, not an alarm: the target is recomputed from the wall clock every
 * tick, so a clock that jumps cannot leave a timer aimed at the wrong moment.
 * DST and the no-catch-up rule fall out of this — see decisions.md.
 */
export function scanIsDue(hour: number, now: number, lastTick: number | null): boolean {
    if (hour < 0 || lastTick === null) return false;
    const target = atHour(hour, now);
    return lastTick < target && now >= target && now - target < MAX_LATE_MS;
}

export function statsFromReply(reply: Reply): LibraryStats {
    const n = (key: string): number => {
        const v = Number(firstValue(reply, key));
        return Number.isFinite(v) ? v : 0;
    };
    const updated = Number(firstValue(reply, 'db_update'));
    return {
        songs: n('songs'),
        albums: n('albums'),
        artists: n('artists'),
        playtimeSeconds: n('db_playtime'),
        lastUpdatedAt: Number.isFinite(updated) && updated > 0 ? updated * 1000 : null,
    };
}

/**
 * Whether the scan finished or was cut short.
 *
 * An uptime shorter than the scan we timed means mpd restarted under it, which
 * abandons the scan and leaves a partial database.
 */
export function outcomeOf(
    uptimeSeconds: number | null,
    startedAt: number,
    finishedAt: number,
): ScanOutcome {
    if (uptimeSeconds === null) return 'completed';
    return uptimeSeconds * 1000 < finishedAt - startedAt ? 'interrupted' : 'completed';
}

/** The real probe: a stat, raced against a timeout so a dead NAS cannot hang us. */
async function probeRoot(root: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
        const timeout = new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
        });
        return await Promise.race([
            stat(root).then(
                (s) => s.isDirectory(),
                () => false,
            ),
            timeout,
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

interface ScanRow {
    id: number;
    started_at: number;
    finished_at: number | null;
    trigger: string;
    outcome: string | null;
    songs_before: number | null;
    songs_after: number | null;
}

function scanFromRow(row: ScanRow): LibraryScan {
    return {
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        trigger: row.trigger as ScanTrigger,
        outcome: row.outcome as ScanOutcome | null,
        songsBefore: row.songs_before,
        songsAfter: row.songs_after,
    };
}

export function createLibraryScanner(opts: LibraryScannerOptions): LibraryScanner {
    const { bridge, db, settings, musicRoot } = opts;
    const log = opts.log ?? (() => {});
    const now = opts.now ?? Date.now;
    const tickMs = opts.tickMs ?? TICK_MS;
    const bootDelayMs = opts.bootDelayMs ?? BOOT_DELAY_MS;
    const probe = opts.probe ?? probeRoot;

    const listeners = new Set<(state: LibraryState) => void>();
    const timers = new Set<NodeJS.Timeout>();
    const unsubscribes: Array<() => void> = [];

    let stopped = false;
    let scanning = false;
    let rowId: number | null = null;
    let startedAt: number | null = null;
    let trigger: ScanTrigger | null = null;
    let lastTick: number | null = null;
    let stats: LibraryStats | null = null;
    let lastScan: LibraryScan | null = null;
    let rootReadable: boolean | null = null;
    /** Shared so two clients opening the tab at once produce one probe. */
    let probing: Promise<boolean> | null = null;

    const state = (): LibraryState => ({
        scanning,
        scanStartedAt: startedAt,
        scanTrigger: trigger,
        lastScan,
        stats,
        musicRoot,
        musicRootReadable: rootReadable,
        nextScanAt: nextScanAt(settings.all().libraryScanHour, now()),
    });

    const emit = (): void => {
        if (stopped) return;
        const value = state();
        for (const fn of [...listeners]) {
            try {
                fn(value);
            } catch (err) {
                log('error', `library listener threw: ${(err as Error).message}`);
            }
        }
    };

    const checkRoot = async (): Promise<boolean> => {
        if (probing === null) {
            probing = probe(musicRoot).finally(() => {
                probing = null;
            });
        }
        const ok = await probing;
        rootReadable = ok;
        return ok;
    };

    const readStats = async (): Promise<Reply | null> => {
        try {
            return await bridge.stats();
        } catch (err) {
            log('warn', `library stats failed: ${(err as Error).message}`);
            return null;
        }
    };

    const loadLastScan = (): void => {
        const row = db.get<ScanRow>('SELECT * FROM library_scan ORDER BY started_at DESC, id DESC LIMIT 1');
        lastScan = row === undefined ? null : scanFromRow(row);
    };

    const openScan = (at: number, why: ScanTrigger, songsBefore: number | null): void => {
        db.transaction(() => {
            db.run(
                'INSERT INTO library_scan (started_at, trigger, songs_before) VALUES (?, ?, ?)',
                at,
                why,
                songsBefore,
            );
            db.run(
                'DELETE FROM library_scan WHERE id NOT IN ' +
                    '(SELECT id FROM library_scan ORDER BY started_at DESC, id DESC LIMIT ?)',
                HISTORY_LIMIT,
            );
        });
        const row = db.get<{ id: number }>('SELECT MAX(id) AS id FROM library_scan');
        rowId = row?.id ?? null;
        startedAt = at;
        trigger = why;
        loadLastScan();
    };

    /** Close the open row. `finishedAt` null means we never saw it end. */
    const closeScan = (finishedAt: number | null, outcome: ScanOutcome | null, songsAfter: number | null): void => {
        if (rowId !== null) {
            db.run(
                'UPDATE library_scan SET finished_at = ?, outcome = ?, songs_after = ? WHERE id = ?',
                finishedAt,
                outcome,
                songsAfter,
                rowId,
            );
        }
        rowId = null;
        startedAt = null;
        trigger = null;
        scanning = false;
        loadLastScan();
    };

    /** A scan we were timing has ended. Record how it went. */
    const finish = async (): Promise<void> => {
        const at = now();
        const began = startedAt;
        const reply = await readStats();
        if (reply !== null) stats = statsFromReply(reply);
        const uptime = reply === null ? null : Number(firstValue(reply, 'uptime'));
        const outcome =
            began === null
                ? 'completed'
                : outcomeOf(Number.isFinite(uptime) ? uptime : null, began, at);
        closeScan(at, outcome, stats?.songs ?? null);
        void checkRoot().then(emit, () => emit());
        log('info', `library scan ${outcome} in ${began === null ? '?' : Math.round((at - began) / 1000)}s`);
        if (outcome === 'completed' && opts.onScanComplete !== undefined) {
            void opts.onScanComplete().catch((err: Error) => {
                log('warn', `after-scan work failed: ${err.message}`);
            });
        }
    };

    const adopt = (why: ScanTrigger): void => {
        openScan(now(), why, stats?.songs ?? null);
        scanning = true;
    };

    unsubscribes.push(
        bridge.onUpdating((was, job) => {
            if (stopped) return;
            // "The previous scan ended" is `job !== was`, not `job === null`:
            // MPD is reachable from any phone on the LAN, so a second scan can
            // begin in the same breath and the ids simply step on.
            if (was !== null && job !== was) {
                void finish().then(() => {
                    if (job !== null) adopt('external');
                    emit();
                });
                return;
            }
            // A scan we did not start. Ours already set `scanning` itself.
            if (was === null && job !== null && !scanning) {
                adopt('external');
                emit();
            }
        }),
    );
    unsubscribes.push(settings.onChange(() => emit()));

    const canScan = async (): Promise<void> => {
        if (scanning) throw new ScanRefusedError('a scan is already running', 409);
        if (bridge.status !== 'ok') throw new ScanRefusedError('MPD is unavailable', 503);
        // Gated on EVERY scan, not just the boot one: MPD's update prunes songs
        // it cannot see, and a soft NFS mount returns EIO part way through a walk.
        // Losing the tag cache costs 48 minutes to rebuild; this costs one stat.
        if (!(await checkRoot())) {
            throw new ScanRefusedError('the music share is not reachable', 503);
        }
    };

    const scan = async (why: ScanTrigger): Promise<void> => {
        await canScan();
        const reply = await readStats();
        if (reply !== null) stats = statsFromReply(reply);
        try {
            if (why === 'rescan') await bridge.rescan();
            else await bridge.update();
        } catch (err) {
            throw new ScanRefusedError((err as Error).message, 503);
        }
        // MPD accepted the command, so the scan is running: there is no need to
        // wait for a refresh to confirm it, and waiting is how this gets stuck.
        openScan(now(), why, stats?.songs ?? null);
        scanning = true;
        log('info', `library scan started (${why})`);
        emit();
    };

    /** Work out what a scan that outlived this process is doing now. */
    const reconcile = (): void => {
        const open = db.get<ScanRow>('SELECT * FROM library_scan WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1');
        const job = bridge.updatingDb;
        if (open !== undefined) {
            rowId = open.id;
            startedAt = open.started_at;
            trigger = open.trigger as ScanTrigger;
            if (job !== null) {
                scanning = true;
                log('info', 'adopted a library scan that was already running');
            } else {
                // It ended while nothing was watching. No duration to invent.
                closeScan(null, 'interrupted', null);
                log('warn', 'a library scan ended unobserved; recorded as interrupted');
            }
        } else if (job !== null) {
            adopt('external');
        }
        loadLastScan();
    };

    const armBoot = (attempt: number): void => {
        const timer = setTimeout(
            () => {
                timers.delete(timer);
                if (stopped) return;
                void (async () => {
                    if (!settings.all().libraryScanOnBoot) return;
                    if (scanning) return;
                    if (bridge.status !== 'ok') {
                        if (attempt >= BOOT_RETRIES) {
                            log('warn', 'boot scan skipped: MPD never became available');
                            return;
                        }
                        armBoot(attempt + 1);
                        return;
                    }
                    try {
                        await scan('boot');
                    } catch (err) {
                        log('warn', `boot scan skipped: ${(err as Error).message}`);
                    }
                })();
            },
            attempt === 0 ? bootDelayMs : BOOT_RETRY_MS,
        );
        timers.add(timer);
    };

    return {
        state,

        async refresh(): Promise<LibraryState> {
            await checkRoot();
            if (bridge.status === 'ok') {
                const reply = await readStats();
                if (reply !== null) stats = statsFromReply(reply);
            }
            return state();
        },

        scan,

        start(): void {
            reconcile();

            const tick = setInterval(() => {
                if (stopped) return;
                const at = now();
                const hour = settings.all().libraryScanHour;
                const due = scanIsDue(hour, at, lastTick);
                lastTick = at;
                // A scan whose ending edge never arrived — MPD finished between
                // two refreshes, or the connection dropped across the end of it.
                // Without this the box would believe it was scanning forever.
                if (scanning && bridge.status === 'ok' && bridge.updatingDb === null) {
                    if (startedAt !== null && at - startedAt > tickMs) void finish().then(emit);
                    return;
                }
                if (!due || scanning) return;
                void scan('scheduled').catch((err: Error) => {
                    log('warn', `scheduled scan skipped: ${err.message}`);
                });
            }, tickMs);
            timers.add(tick);

            if (settings.all().libraryScanOnBoot) armBoot(0);

            // Stats and the share's reachability, once, without blocking startup.
            void (async () => {
                if (bridge.status === 'ok') {
                    const reply = await readStats();
                    if (reply !== null) stats = statsFromReply(reply);
                }
                await checkRoot();
                emit();
            })();

            emit();
        },

        stop(): void {
            stopped = true;
            for (const t of timers) {
                clearTimeout(t);
                clearInterval(t);
            }
            timers.clear();
            for (const off of unsubscribes) off();
            unsubscribes.length = 0;
            listeners.clear();
        },

        onChange(fn): () => void {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
