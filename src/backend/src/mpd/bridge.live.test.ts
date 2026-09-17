/**
 * Bridge behaviour against a fake MPD server.
 *
 * These exist because of a real bug seen on the device: MPD closes a connection
 * that sends nothing for `connection_timeout` (default 60s). The command
 * connection only carries commands, so MPD hung up on it roughly once a minute —
 * observed reconnecting at 62s, 62s and 70s intervals — and each reconnect
 * briefly published an "unavailable" snapshot, flashing "MPD is not running" on
 * the panel and on phones.
 *
 * Two fixes, one test file: the bridge must keep the connection alive, and a
 * momentary loss must not reach the UI at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { MpdBridge } from './bridge.ts';
import { MpdConnection } from './protocol.ts';
import type { Snapshot } from '../../../shared/api.ts';

const STATUS_REPLY = 'volume: 50\nstate: play\nplaylist: 7\nplaylistlength: 3\nelapsed: 1.0\nduration: 100.0\nOK\n';
/** Elapsed advances on each `status`, so a cached snapshot is distinguishable. */
let statusCalls = 0;
function movingStatus(): string {
    statusCalls += 1;
    return `volume: 50\nstate: play\nplaylist: 7\nplaylistlength: 3\nelapsed: ${statusCalls * 10}.0\nduration: 300.0\nOK\n`;
}
const SONG_REPLY = 'file: a/b.flac\nTitle: Test\nArtist: Tester\nOK\n';

const STATS_REPLY =
    'artists: 535\nalbums: 2731\nsongs: 37289\nuptime: 100000\ndb_playtime: 3500000\ndb_update: 1757000000\nOK\n';

interface Fake {
    server: Server;
    port: number;
    /** Every command line received, across all connections. */
    commands: string[];
    sockets: Set<Socket>;
    /** Drop every current connection, as MPD does on connection_timeout. */
    hangUpOnAll: () => void;
    /** Set what `status` reports for `updating_db`; null removes the line. */
    setUpdating: (job: number | null) => void;
    /** Wake every blocked `idle` with one subsystem, as a real scan does. */
    wake: (subsystem: string) => void;
    close: () => Promise<void>;
}

/** A minimal MPD good enough to exercise the bridge's connection handling. */
async function startFakeMpd(
    opts: {
        idleForever?: boolean;
        movingElapsed?: boolean;
        deaf?: boolean;
        updating?: number | null;
    } = {},
): Promise<Fake> {
    const commands: string[] = [];
    const sockets = new Set<Socket>();
    let updating: number | null = opts.updating ?? null;
    /** The sockets currently parked in `idle`, so a wake can answer them. */
    const idling = new Set<Socket>();

    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => sockets.delete(socket));
        socket.write('OK MPD 0.24.0\n');

        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let nl: number;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                commands.push(line);
                if (opts.deaf) {
                    // The wedge: the command is read and NEVER answered. This is
                    // what MPD looks like from outside when its main thread is
                    // stuck in uninterruptible sleep — process alive, socket
                    // accepted by the kernel, no reply, ever.
                    continue;
                }
                if (line.startsWith('idle')) {
                    // A real idle blocks until something changes.
                    idling.add(socket);
                    if (!opts.idleForever) socket.write('changed: player\nOK\n');
                } else if (line === 'status') {
                    const base = opts.movingElapsed ? movingStatus() : STATUS_REPLY;
                    socket.write(
                        updating === null
                            ? base
                            : base.replace('OK\n', `updating_db: ${updating}\nOK\n`),
                    );
                } else if (line === 'stats') {
                    socket.write(STATS_REPLY);
                } else if (line === 'update' || line === 'rescan') {
                    // MPD answers at once and gets on with it; it does not wait.
                    socket.write('updating_db: 7\nOK\n');
                } else if (line === 'currentsong') {
                    socket.write(SONG_REPLY);
                } else {
                    socket.write('OK\n');
                }
            }
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    return {
        server,
        port: address.port,
        commands,
        sockets,
        hangUpOnAll: () => {
            for (const s of sockets) s.destroy();
            sockets.clear();
        },
        setUpdating: (job) => {
            updating = job;
        },
        wake: (subsystem) => {
            for (const s of idling) s.write(`changed: ${subsystem}\nOK\n`);
            idling.clear();
        },
        close: () =>
            new Promise<void>((resolve) => {
                for (const s of sockets) s.destroy();
                server.close(() => resolve());
            }),
    };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeBridge(
    fake: Fake,
    over: Partial<{ keepaliveMs: number; unavailableGraceMs: number; replyTimeoutMs: number }> = {},
) {
    const seen: Snapshot[] = [];
    const bridge = new MpdBridge({
        host: '127.0.0.1',
        port: fake.port,
        connectTimeoutMs: 1000,
        log: () => {},
        keepaliveMs: over.keepaliveMs ?? 60,
        unavailableGraceMs: over.unavailableGraceMs ?? 200,
        replyTimeoutMs: over.replyTimeoutMs ?? 300,
    });
    bridge.onSnapshot((s) => seen.push(s));
    return { bridge, seen };
}

test('the command connection is kept alive so MPD does not hang up', async () => {
    // The regression: with no keepalive the bridge sent nothing between commands
    // and MPD closed the socket after connection_timeout.
    const fake = await startFakeMpd({ idleForever: true });
    const { bridge } = makeBridge(fake, { keepaliveMs: 40 });
    bridge.start();
    await wait(400);
    bridge.stop();
    await fake.close();

    const pings = fake.commands.filter((c) => c === 'ping').length;
    assert.ok(pings >= 3, `expected repeated keepalives, saw ${pings} ping(s)`);
});

test('a brief connection loss never reaches the UI', async () => {
    const fake = await startFakeMpd({ idleForever: true });
    const { bridge, seen } = makeBridge(fake, { keepaliveMs: 40, unavailableGraceMs: 500 });
    bridge.start();
    await wait(300);

    const before = seen.length;
    fake.hangUpOnAll(); // exactly what MPD's connection_timeout does
    await wait(300); // long enough to reconnect, shorter than the grace period
    bridge.stop();
    await fake.close();

    const after = seen.slice(before);
    assert.equal(
        after.some((s) => s.status === 'unavailable'),
        false,
        'a reconnect inside the grace period must not publish "unavailable"',
    );
});

test('a sustained outage IS reported', async () => {
    // The grace period must not swallow a real failure.
    const fake = await startFakeMpd({ idleForever: true });
    const { bridge, seen } = makeBridge(fake, { keepaliveMs: 40, unavailableGraceMs: 150 });
    bridge.start();
    await wait(300);

    await fake.close(); // MPD is gone for good
    await wait(700); // comfortably past the grace period
    bridge.stop();

    assert.ok(
        seen.some((s) => s.status === 'unavailable'),
        'a real outage must surface as unavailable',
    );
});

test('normal operation reports ok and real state', async () => {
    const fake = await startFakeMpd({ idleForever: true });
    const { bridge, seen } = makeBridge(fake);
    bridge.start();
    await wait(300);
    bridge.stop();
    await fake.close();

    const live = seen.filter((s) => s.status === 'ok');
    assert.ok(live.length > 0, 'expected at least one ok snapshot');
    assert.equal(live[live.length - 1].state, 'play');
    assert.equal(live[live.length - 1].track?.title, 'Test');
    assert.equal(live[live.length - 1].queueVersion, 7);
});

test('the idle connection subscribes to the subsystems that matter', async () => {
    const fake = await startFakeMpd({ idleForever: true });
    const { bridge } = makeBridge(fake);
    bridge.start();
    await wait(250);
    bridge.stop();
    await fake.close();

    const idle = fake.commands.find((c) => c.startsWith('idle'));
    assert.ok(idle, 'expected an idle command');
    for (const subsystem of ['player', 'mixer', 'playlist', 'options']) {
        assert.ok(idle.includes(subsystem), `idle should cover ${subsystem}`);
    }
});

test('refresh() re-queries MPD rather than reusing the cached snapshot', async () => {
    /*
     * The bug this guards against, seen in the real UI: MPD's `idle` never fires
     * merely because elapsed time advanced, so bridge.current keeps the elapsed
     * value from the last real event — a resume, a seek, a track change. A client
     * interpolates from when it received the frame, so being handed that stale
     * snapshot makes it count up from the OLD position. Reloading the page after
     * pausing and resuming showed the resume position as though it were now.
     *
     * The fix is server-side: /api/events refreshes before its first frame, and
     * /api/status refreshes before responding. Both rely on refresh() actually
     * hitting MPD every time.
     */
    statusCalls = 0;
    const fake = await startFakeMpd({ idleForever: true, movingElapsed: true });
    const { bridge } = makeBridge(fake, { keepaliveMs: 10_000 });
    bridge.start();
    await wait(300);

    const first = bridge.current.elapsed;
    await bridge.refresh();
    const second = bridge.current.elapsed;
    await bridge.refresh();
    const third = bridge.current.elapsed;

    bridge.stop();
    await fake.close();

    assert.notEqual(first, second, 'refresh() must re-query, not return the cache');
    assert.notEqual(second, third, 'every refresh() must re-query');
    assert.ok(
        (third ?? 0) > (first ?? 0),
        `elapsed should advance across refreshes, got ${first} -> ${second} -> ${third}`,
    );
});

/*
 * A WEDGED MPD, which is different from a dead one and much nastier.
 *
 * On the real device a firmware/clock deadlock left MPD's process `active
 * (running)` with its listening socket still accepting, but its main thread
 * blocked forever in uninterruptible sleep. It read commands and answered none.
 *
 * Because `send()` originally had only a CONNECT timeout and no REPLY timeout,
 * every await hung for eternity: refresh() never returned, so /api/status never
 * responded, so the web UI died along with MPD instead of reporting it
 * unavailable. Measured on the device: ~2 hours of a completely dead HTTP
 * endpoint. These tests are the regression guard.
 */

test('a command that is never answered rejects instead of hanging forever', async () => {
    const fake = await startFakeMpd({ deaf: true });
    const conn = new MpdConnection({ replyTimeoutMs: 150 });
    await conn.connect('127.0.0.1', fake.port, 1000);

    const started = Date.now();
    await assert.rejects(() => conn.send('status'), /did not answer/);
    const waited = Date.now() - started;

    assert.ok(waited < 2000, `should give up promptly, waited ${waited}ms`);
    assert.equal(conn.connected, false, 'a reply timeout must tear the connection down');
    conn.close();
    await fake.close();
});

test('a reply timeout rejects every queued command, not just the first', async () => {
    // Replies are matched to commands by ORDER, so a stream that has lost sync
    // cannot be recovered — everything in flight has to fail.
    const fake = await startFakeMpd({ deaf: true });
    const conn = new MpdConnection({ replyTimeoutMs: 150 });
    await conn.connect('127.0.0.1', fake.port, 1000);

    const first = conn.send('status');
    const second = conn.send('currentsong');
    await assert.rejects(() => first);
    await assert.rejects(() => second, 'the second queued command must fail too');

    conn.close();
    await fake.close();
});

test('refresh() against a wedged MPD returns rather than hanging', async () => {
    const fake = await startFakeMpd({ deaf: true });
    const { bridge } = makeBridge(fake, { replyTimeoutMs: 150 });
    bridge.start();
    await wait(100);

    // This is the call that used to hang /api/status forever.
    const started = Date.now();
    await bridge.refresh();
    const waited = Date.now() - started;
    assert.ok(waited < 2000, `refresh must be bounded, took ${waited}ms`);

    bridge.stop();
    await fake.close();
});

test('a wedged MPD is reported unavailable, like a dead one', async () => {
    const fake = await startFakeMpd({ deaf: true });
    const { bridge, seen } = makeBridge(fake, { replyTimeoutMs: 150, unavailableGraceMs: 150 });
    bridge.start();
    await wait(1500); // past the reply timeout, the grace period and a reconnect
    bridge.stop();
    await fake.close();

    assert.ok(
        seen.some((s) => s.status === 'unavailable'),
        'MPD that accepts connections but never answers must still surface as unavailable',
    );
});

test('idle is exempt from the reply deadline', async () => {
    // idle is MEANT to block, possibly for hours. If the deadline applied to it
    // the bridge would tear down a healthy connection every few seconds.
    const fake = await startFakeMpd({ idleForever: true });
    const conn = new MpdConnection({ replyTimeoutMs: 100 });
    await conn.connect('127.0.0.1', fake.port, 1000);

    let settled = false;
    void conn.send('idle player', { timeoutMs: null }).then(
        () => (settled = true),
        () => (settled = true),
    );
    await wait(500); // five times the deadline

    assert.equal(settled, false, 'idle must not be timed out');
    assert.equal(conn.connected, true, 'and the connection must survive');
    conn.close();
    await fake.close();
});

test('a running scan is reported by updatingDb, and never on the snapshot', async () => {
    const fake = await startFakeMpd({ idleForever: true, updating: 7 });
    const { bridge, seen } = makeBridge(fake);
    bridge.start();
    await wait(150);

    assert.equal(bridge.updatingDb, 7);
    // The snapshot rule: a scan is not what the music is doing.
    assert.ok(seen.length > 0);
    assert.ok(!('updatingDb' in seen[seen.length - 1]));
    assert.ok(!('scanning' in seen[seen.length - 1]));

    bridge.stop();
    await fake.close();
});

test('the end of a scan is announced from refresh, not from the idle wake', async () => {
    // THE REGRESSION THIS GUARDS. runIdleLoop calls announceIdle BEFORE
    // refresh(), so an onIdle listener reading updatingDb sees the PREVIOUS
    // refresh's value — and the last wake of a scan has no successor, so the
    // scan's end would never be observed at all.
    const fake = await startFakeMpd({ idleForever: true, updating: 7 });
    const { bridge } = makeBridge(fake);
    const edges: Array<[number | null, number | null]> = [];
    bridge.onUpdating((was, job) => edges.push([was, job]));
    bridge.start();
    await wait(150);
    assert.deepEqual(edges, [[null, 7]], 'the start of the scan');

    fake.setUpdating(null);
    fake.wake('update');
    await wait(150);

    assert.deepEqual(edges, [
        [null, 7],
        [7, null],
    ]);
    bridge.stop();
    await fake.close();
});

test('an updating listener that throws does not take the refresh down', async () => {
    const fake = await startFakeMpd({ idleForever: true, updating: 4 });
    const { bridge, seen } = makeBridge(fake);
    bridge.onUpdating(() => {
        throw new Error('listener is broken');
    });
    bridge.start();
    await wait(150);

    assert.equal(bridge.updatingDb, 4);
    assert.ok(seen.length > 0, 'snapshots kept being published');
    bridge.stop();
    await fake.close();
});

test('update and rescan return the job id without waiting for the scan', async () => {
    const fake = await startFakeMpd({ idleForever: true });
    const { bridge } = makeBridge(fake, { replyTimeoutMs: 300 });
    bridge.start();
    await wait(120);

    // A real scan runs for the better part of an hour; a reply timeout destroys
    // the connection, so this MUST come back immediately.
    const began = Date.now();
    assert.equal(await bridge.update(), 7);
    assert.equal(await bridge.rescan(), 7);
    assert.ok(Date.now() - began < 250, 'returned well inside the reply timeout');
    assert.ok(fake.commands.includes('update'));
    assert.ok(fake.commands.includes('rescan'));

    bridge.stop();
    await fake.close();
});

test('stats comes back parsed by the caller, counts and uptime included', async () => {
    const fake = await startFakeMpd({ idleForever: true });
    const { bridge } = makeBridge(fake);
    bridge.start();
    await wait(120);

    const reply = await bridge.stats();
    const pairs = new Map(reply.pairs);
    assert.equal(pairs.get('songs'), '37289');
    assert.equal(pairs.get('uptime'), '100000');

    bridge.stop();
    await fake.close();
});
