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
import type { Snapshot } from '../../../shared/api.ts';

const STATUS_REPLY = 'volume: 50\nstate: play\nplaylist: 7\nplaylistlength: 3\nelapsed: 1.0\nduration: 100.0\nOK\n';
/** Elapsed advances on each `status`, so a cached snapshot is distinguishable. */
let statusCalls = 0;
function movingStatus(): string {
    statusCalls += 1;
    return `volume: 50\nstate: play\nplaylist: 7\nplaylistlength: 3\nelapsed: ${statusCalls * 10}.0\nduration: 300.0\nOK\n`;
}
const SONG_REPLY = 'file: a/b.flac\nTitle: Test\nArtist: Tester\nOK\n';

interface Fake {
    server: Server;
    port: number;
    /** Every command line received, across all connections. */
    commands: string[];
    sockets: Set<Socket>;
    /** Drop every current connection, as MPD does on connection_timeout. */
    hangUpOnAll: () => void;
    close: () => Promise<void>;
}

/** A minimal MPD good enough to exercise the bridge's connection handling. */
async function startFakeMpd(opts: { idleForever?: boolean; movingElapsed?: boolean } = {}): Promise<Fake> {
    const commands: string[] = [];
    const sockets = new Set<Socket>();

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
                if (line.startsWith('idle')) {
                    // A real idle blocks until something changes.
                    if (!opts.idleForever) socket.write('changed: player\nOK\n');
                } else if (line === 'status') {
                    socket.write(opts.movingElapsed ? movingStatus() : STATUS_REPLY);
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
        close: () =>
            new Promise<void>((resolve) => {
                for (const s of sockets) s.destroy();
                server.close(() => resolve());
            }),
    };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeBridge(fake: Fake, over: Partial<{ keepaliveMs: number; unavailableGraceMs: number }> = {}) {
    const seen: Snapshot[] = [];
    const bridge = new MpdBridge({
        host: '127.0.0.1',
        port: fake.port,
        connectTimeoutMs: 1000,
        log: () => {},
        keepaliveMs: over.keepaliveMs ?? 60,
        unavailableGraceMs: over.unavailableGraceMs ?? 200,
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
