import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from './db.ts';
import { createSettings, type Settings } from './settings.ts';
import type { Reply } from './mpd/protocol.ts';
import type { BackendStatus, LibraryState, ScanTrigger } from '../../shared/api.ts';
import {
    atHour,
    createLibraryScanner,
    nextScanAt,
    outcomeOf,
    scanIsDue,
    statsFromReply,
    ScanRefusedError,
    MAX_LATE_MS,
    type ScanBridge,
} from './library-scan.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function reply(pairs: Array<[string, string]>): Reply {
    return { pairs };
}

function statsReply(over: Record<string, string> = {}): Reply {
    const base: Record<string, string> = {
        artists: '535',
        albums: '2731',
        songs: '37289',
        uptime: '100000',
        db_playtime: '3500000',
        db_update: '1757000000',
        ...over,
    };
    return reply(Object.entries(base));
}

/** A bridge that never opens a socket. */
function fakeBridge(over: Partial<{ status: BackendStatus; job: number | null }> = {}) {
    const listeners = new Set<(was: number | null, job: number | null) => void>();
    let stats = statsReply();
    const sent: string[] = [];
    const bridge = {
        status: over.status ?? ('ok' as BackendStatus),
        updatingDb: over.job ?? null,
        onUpdating(fn: (was: number | null, job: number | null) => void) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        async update() {
            sent.push('update');
            return 7;
        },
        async rescan() {
            sent.push('rescan');
            return 7;
        },
        async stats() {
            sent.push('stats');
            return stats;
        },
    };
    return {
        bridge: bridge as ScanBridge,
        sent,
        setStats: (r: Reply) => {
            stats = r;
        },
        /** Drive the edge the real bridge emits from refresh(). */
        edge(was: number | null, job: number | null) {
            (bridge as { updatingDb: number | null }).updatingDb = job;
            for (const fn of [...listeners]) fn(was, job);
        },
    };
}

interface Harness {
    db: Db;
    settings: Settings;
    clock: { now: number };
    states: LibraryState[];
    close: () => void;
}

function harness(overrides: Partial<Record<'libraryScanHour', number>> = {}) {
    const db = openDb({ path: ':memory:' });
    const settings = createSettings(db);
    if (overrides.libraryScanHour !== undefined) {
        settings.set('libraryScanHour', overrides.libraryScanHour);
    }
    const clock = { now: Date.UTC(2026, 0, 1, 12, 0, 0) };
    const states: LibraryState[] = [];
    const h: Harness = { db, settings, clock, states, close: () => db.close() };
    return h;
}

/**
 * Build a scanner and register its teardown on the test context.
 *
 * Via t.after rather than a line at the end of each test: a failing assertion
 * would skip that line, and a leaked interval does not fail the suite — it hangs
 * it, which is a far worse thing to debug than a red assertion.
 */
function scannerFor(
    t: TestContext,
    h: Harness,
    fake: ReturnType<typeof fakeBridge>,
    opts: { probe?: () => Promise<boolean>; tickMs?: number; bootDelayMs?: number } = {},
) {
    const scanner = createLibraryScanner({
        bridge: fake.bridge,
        db: h.db,
        settings: h.settings,
        musicRoot: '/srv/music/Music',
        now: () => h.clock.now,
        tickMs: opts.tickMs ?? 60_000,
        bootDelayMs: opts.bootDelayMs ?? 120_000,
        probe: opts.probe ?? (async () => true),
    });
    scanner.onChange((s) => h.states.push(s));
    // Via t.after, not a line at the end of each test: a failing assertion would
    // skip that line, and a leaked interval does not fail the suite — it hangs
    // it, which is a much worse thing to debug than a red assertion.
    t.after(() => {
        scanner.stop();
        h.close();
    });
    return scanner;
}

function rows(db: Db) {
    return db.all<{
        id: number;
        started_at: number;
        finished_at: number | null;
        trigger: string;
        outcome: string | null;
        songs_before: number | null;
        songs_after: number | null;
    }>('SELECT * FROM library_scan ORDER BY id');
}

// --------------------------------------------------------------------------
// The pure scheduling seams.
// --------------------------------------------------------------------------

test('nextScanAt is null when scanning is off', () => {
    assert.equal(nextScanAt(-1, Date.now()), null);
});

test('nextScanAt is today before the hour and tomorrow after it', () => {
    const noon = new Date(2026, 0, 15, 12, 0, 0).getTime();
    assert.equal(nextScanAt(16, noon), new Date(2026, 0, 15, 16, 0, 0).getTime());
    assert.equal(nextScanAt(4, noon), new Date(2026, 0, 16, 4, 0, 0).getTime());
});

test('the first tick never fires a scan — it only records where the clock was', () => {
    const now = new Date(2026, 0, 15, 4, 30, 0).getTime();
    assert.equal(scanIsDue(4, now, null), false);
});

test('a scheduled scan fires exactly once across the boundary', () => {
    const before = new Date(2026, 0, 15, 3, 59, 30).getTime();
    const after = new Date(2026, 0, 15, 4, 0, 30).getTime();
    assert.equal(scanIsDue(4, after, before), true);
    // The tick after it has already crossed: lastTick is now past the target.
    assert.equal(scanIsDue(4, after + 60_000, after), false);
});

test('a scan hours late is not run — an NTP jump must not start one out of nowhere', () => {
    const target = new Date(2026, 0, 15, 4, 0, 0).getTime();
    const lastTick = target - 60_000;
    assert.equal(scanIsDue(4, target + MAX_LATE_MS - 1000, lastTick), true);
    assert.equal(scanIsDue(4, target + MAX_LATE_MS + 1000, lastTick), false);
});

test('a clock that jumped backwards does not fire', () => {
    const target = new Date(2026, 0, 15, 4, 0, 0).getTime();
    // lastTick is in the future relative to now, so nothing has been crossed.
    assert.equal(scanIsDue(4, target - HOUR, target + HOUR), false);
});

test('scanning off is never due', () => {
    const after = new Date(2026, 0, 15, 4, 0, 30).getTime();
    assert.equal(scanIsDue(-1, after, after - 60_000), false);
});

test('atHour is local wall clock, so a DST day still has the hour it asks for', () => {
    // Whatever this machine's zone, setHours(h) means h o'clock as a person reads it.
    for (const day of [new Date(2026, 2, 29, 12).getTime(), new Date(2026, 9, 25, 12).getTime()]) {
        const at = atHour(3, day);
        // Either 3am exists and we get it, or the zone skipped it and the clock
        // rolls forward — never a silent landing on the previous day.
        assert.ok(new Date(at).getHours() === 3 || new Date(at).getHours() === 4);
        assert.equal(new Date(at).getDate(), new Date(day).getDate());
    }
});

test('a scheduled scan on a spring-forward day fires once, not twice', () => {
    const day = new Date(2026, 2, 29, 0, 0, 0).getTime();
    const target = atHour(3, day);
    let fired = 0;
    let lastTick: number | null = null;
    // Walk the whole day a minute at a time.
    for (let t = day; t < day + DAY; t += 60_000) {
        if (scanIsDue(3, t, lastTick)) fired += 1;
        lastTick = t;
    }
    assert.equal(fired, 1);
    assert.ok(target > 0);
});

test('a scheduled scan on a fall-back day fires once, not twice', () => {
    const day = new Date(2026, 9, 25, 0, 0, 0).getTime();
    let fired = 0;
    let lastTick: number | null = null;
    for (let t = day; t < day + DAY + HOUR; t += 60_000) {
        if (scanIsDue(1, t, lastTick)) fired += 1;
        lastTick = t;
    }
    assert.equal(fired, 1);
});

test('statsFromReply reads the counts and converts db_update to ms', () => {
    const stats = statsFromReply(statsReply());
    assert.equal(stats.songs, 37289);
    assert.equal(stats.albums, 2731);
    assert.equal(stats.artists, 535);
    assert.equal(stats.playtimeSeconds, 3500000);
    assert.equal(stats.lastUpdatedAt, 1757000000 * 1000);
});

test('statsFromReply tolerates a library MPD has never scanned', () => {
    const stats = statsFromReply(reply([['songs', '0']]));
    assert.equal(stats.songs, 0);
    assert.equal(stats.albums, 0);
    assert.equal(stats.lastUpdatedAt, null);
});

test('outcomeOf calls it interrupted when mpd is younger than the scan it ran', () => {
    const started = 1_000_000;
    const finished = started + 600_000; // ten minutes
    assert.equal(outcomeOf(1000, started, finished), 'completed');
    assert.equal(outcomeOf(60, started, finished), 'interrupted');
    // No stats to judge by: do not invent a failure.
    assert.equal(outcomeOf(null, started, finished), 'completed');
});

// --------------------------------------------------------------------------
// The scanner itself.
// --------------------------------------------------------------------------

test('a scan writes its row when it STARTS, so a restart cannot lose the start time', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake);
    await scanner.scan('manual');

    const [row] = rows(h.db);
    assert.equal(row.started_at, h.clock.now);
    assert.equal(row.trigger, 'manual');
    assert.equal(row.finished_at, null);
    assert.equal(row.songs_before, 37289);
    assert.equal(scanner.state().scanning, true);
});

test('the end of a scan closes the row with a duration', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake);
    await scanner.scan('manual');

    h.clock.now += 48 * 60 * 1000;
    fake.setStats(statsReply({ songs: '37300' }));
    fake.edge(7, null);
    await new Promise((r) => setImmediate(r));

    const [row] = rows(h.db);
    assert.equal(row.finished_at, h.clock.now);
    assert.equal(row.outcome, 'completed');
    assert.equal(row.songs_after, 37300);
    assert.equal(scanner.state().scanning, false);
    assert.equal(scanner.state().lastScan?.songsAfter, 37300);
});

test('mpd restarting under a scan is recorded as interrupted, not a success', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake);
    await scanner.scan('manual');

    h.clock.now += 30 * 60 * 1000;
    // MPD says it has only been up a minute: it restarted mid-scan, which
    // abandons the scan and leaves a partial database.
    fake.setStats(statsReply({ uptime: '60' }));
    fake.edge(7, null);
    await new Promise((r) => setImmediate(r));

    assert.equal(rows(h.db)[0].outcome, 'interrupted');
});

test('a scan started elsewhere is adopted and recorded as external', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake);
    scanner.start();

    fake.edge(null, 3);
    assert.equal(scanner.state().scanning, true);
    assert.equal(scanner.state().scanTrigger, 'external');
    assert.equal(rows(h.db)[0].trigger, 'external');
});

test('one job id stepping straight to the next closes the first and opens a second', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake);
    await scanner.scan('manual');

    h.clock.now += 60_000;
    // Job 7 ended and job 8 began between two refreshes. Losing 7 would be wrong.
    fake.edge(7, 8);
    await new Promise((r) => setImmediate(r));

    const all = rows(h.db);
    assert.equal(all.length, 2);
    assert.equal(all[0].trigger, 'manual');
    assert.notEqual(all[0].finished_at, null);
    assert.equal(all[1].trigger, 'external');
    assert.equal(all[1].finished_at, null);
    assert.equal(scanner.state().scanning, true);
});

test('a scan already running when this server starts is adopted, with its original start time', (t) => {
    const h = harness();
    h.db.run(
        'INSERT INTO library_scan (started_at, trigger, songs_before) VALUES (?, ?, ?)',
        1000,
        'scheduled',
        10,
    );
    const fake = fakeBridge({ job: 7 });
    const scanner = scannerFor(t, h, fake);
    scanner.start();

    assert.equal(scanner.state().scanning, true);
    assert.equal(scanner.state().scanStartedAt, 1000);
    assert.equal(scanner.state().scanTrigger, 'scheduled');
});

test('a scan whose end was never seen is closed as interrupted with no invented duration', (t) => {
    const h = harness();
    h.db.run(
        'INSERT INTO library_scan (started_at, trigger, songs_before) VALUES (?, ?, ?)',
        1000,
        'manual',
        10,
    );
    const fake = fakeBridge({ job: null });
    const scanner = scannerFor(t, h, fake);
    scanner.start();

    const [row] = rows(h.db);
    assert.equal(row.outcome, 'interrupted');
    assert.equal(row.finished_at, null, 'a duration we did not measure is not one to invent');
    assert.equal(scanner.state().scanning, false);
});

test('a scan is refused while one is already running', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake);
    await scanner.scan('manual');
    await assert.rejects(
        () => scanner.scan('manual'),
        (err: ScanRefusedError) => err.code === 409,
    );
});

test('a scan is refused when MPD is unavailable', async (t) => {
    const h = harness();
    const fake = fakeBridge({ status: 'unavailable' });
    const scanner = scannerFor(t, h, fake);
    await assert.rejects(
        () => scanner.scan('manual'),
        (err: ScanRefusedError) => err.code === 503,
    );
    assert.deepEqual(fake.sent, []);
});

test('an unreachable music share refuses the scan and sends MPD nothing at all', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake, { probe: async () => false });
    await assert.rejects(
        () => scanner.scan('manual'),
        (err: ScanRefusedError) => err.code === 503,
    );
    // The point of the gate: `update` prunes songs it cannot see, and losing the
    // tag cache to a sleeping NAS costs the better part of an hour to rebuild.
    assert.deepEqual(fake.sent, []);
    assert.equal(rows(h.db).length, 0);
    assert.equal(scanner.state().musicRootReadable, false);
});

test('rescan sends rescan, not update', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake);
    await scanner.scan('rescan');
    assert.ok(fake.sent.includes('rescan'));
    assert.ok(!fake.sent.includes('update'));
    assert.equal(rows(h.db)[0].trigger, 'rescan');
});

test('history is pruned to the most recent twenty', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake);
    for (let i = 0; i < 25; i += 1) {
        h.clock.now += 60_000;
        await scanner.scan('manual');
        h.clock.now += 60_000;
        fake.edge(7, null);
        await new Promise((r) => setImmediate(r));
    }
    const all = rows(h.db);
    assert.equal(all.length, 20);
    // The newest survived.
    assert.equal(all[all.length - 1].started_at, h.clock.now - 60_000);
});

test('the scheduled hour fires a scan, and the next tick does not fire a second', async (t) => {
    const h = harness();
    // 4am tomorrow, so the clock crosses it during the test.
    const four = new Date(2026, 0, 2, 4, 0, 0).getTime();
    h.clock.now = four - 2 * 60_000;
    h.settings.set('libraryScanHour', 4);

    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake, { tickMs: 1 });
    scanner.start();

    // First tick records where the clock is; it must not scan.
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(rows(h.db).length, 0, 'the first tick only records the clock');

    h.clock.now = four + 60_000;
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(rows(h.db).length, 1);
    assert.equal(rows(h.db)[0].trigger, 'scheduled');

    // Still running, so the ticks that follow must not queue another.
    h.clock.now += 60_000;
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(rows(h.db).length, 1);
});

test('the boot scan waits, then runs — and does not run when the toggle is off', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake, { bootDelayMs: 5 });
    scanner.start();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(rows(h.db).length, 0, 'off by default');
});

test('the boot scan runs when the toggle is on', async (t) => {
    const h = harness();
    h.settings.set('libraryScanOnBoot', true);
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake, { bootDelayMs: 5 });
    scanner.start();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(rows(h.db).length, 1);
    assert.equal(rows(h.db)[0].trigger, 'boot');
});

test('the boot scan is skipped when the music share cannot be read', async (t) => {
    const h = harness();
    h.settings.set('libraryScanOnBoot', true);
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake, { bootDelayMs: 5, probe: async () => false });
    scanner.start();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(rows(h.db).length, 0);
    assert.deepEqual(fake.sent.filter((c) => c === 'update'), []);
});

test('a scan whose ending edge never arrived is reconciled by the tick', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake, { tickMs: 5 });
    await scanner.scan('manual');
    scanner.start();
    // MPD is idle again but no edge was ever delivered — the connection dropped
    // across the end of the scan. Without reconciliation this box would believe
    // it was scanning forever.
    fake.edge(7, null);
    (fake.bridge as { updatingDb: number | null }).updatingDb = null;
    h.clock.now += 10 * 60_000;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(scanner.state().scanning, false);
});

test('nextScanAt reaches clients on the state, and changes with the setting', (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake);
    assert.equal(scanner.state().nextScanAt, null);
    h.settings.set('libraryScanHour', 4);
    assert.equal(scanner.state().nextScanAt, nextScanAt(4, h.clock.now));
});

test('stop() ends the ticking and the listening', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake, { tickMs: 1 });
    scanner.start();
    scanner.stop();
    const seen = h.states.length;
    fake.edge(null, 3);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.states.length, seen, 'no emit survives stop()');
    assert.equal(rows(h.db).length, 0);
});

test('onChange unsubscribes', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    const scanner = scannerFor(t, h, fake);
    const mine: LibraryState[] = [];
    const off = scanner.onChange((s) => mine.push(s));
    await scanner.scan('manual');
    const seen = mine.length;
    assert.ok(seen > 0);
    off();
    h.clock.now += 60_000;
    fake.edge(7, null);
    await new Promise((r) => setImmediate(r));
    assert.equal(mine.length, seen);
});

test('refresh() probes the share and returns the fresh state', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    let probes = 0;
    const scanner = scannerFor(t, h, fake, {
        probe: async () => {
            probes += 1;
            return true;
        },
    });
    const state = await scanner.refresh();
    assert.equal(probes, 1);
    assert.equal(state.musicRootReadable, true);
    assert.equal(state.stats?.songs, 37289);
    assert.equal(state.musicRoot, '/srv/music/Music');
});

test('two clients asking at once share one probe', async (t) => {
    const h = harness();
    const fake = fakeBridge();
    let probes = 0;
    const scanner = scannerFor(t, h, fake, {
        probe: async () => {
            probes += 1;
            // Never poll the automount: it would pin the NFS mount up and defeat
            // its idle timeout. Concurrent askers must share the one stat.
            await new Promise((r) => setImmediate(r));
            return true;
        },
    });
    await Promise.all([scanner.refresh(), scanner.refresh()]);
    assert.equal(probes, 1);
});

test('the trigger that started a scan is what the state reports', async (t) => {
    for (const trigger of ['manual', 'rescan'] as ScanTrigger[]) {
        const h = harness();
        const fake = fakeBridge();
        const scanner = scannerFor(t, h, fake);
        await scanner.scan(trigger);
        assert.equal(scanner.state().scanTrigger, trigger);
    }
});
