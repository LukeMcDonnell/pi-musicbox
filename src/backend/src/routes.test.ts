/**
 * Shutdown behaviour.
 *
 * This exists because of a real failure on the device: `/api/events` is a
 * long-lived SSE stream, Fastify's close() waits for open connections to finish,
 * and an SSE stream never finishes. The kiosk browser always holds one open, so
 * every deploy left the service stuck in `deactivating` until systemd's stop
 * timeout fired — a 90s hang on what should be a 2s restart.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { open as fsOpen, constants as fsConstants } from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRoutes } from './routes.ts';
import { registerStatic } from './static.ts';
import { MpdBridge } from './mpd/bridge.ts';
import { SSE_SNAPSHOT_EVENT, type Snapshot } from '../../shared/api.ts';
import type { BluetoothState } from './bluetooth.ts';

/** A phone that is connected and playing, as the arbiter would report it. */
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

/** A bridge pointed at a closed port: never connects, but is a real instance. */
function deadBridge(): MpdBridge {
    return new MpdBridge({
        host: '127.0.0.1',
        port: 1, // nothing listens here
        connectTimeoutMs: 50,
        log: () => {},
        unavailableGraceMs: 10_000, // never fires during these tests
    });
}

async function startServer(
    opts: { forceCloseConnections?: boolean; musicRoot?: string; bluetoothControl?: string } = {},
) {
    const app = Fastify({
        logger: false,
        forceCloseConnections: opts.forceCloseConnections ?? true,
    });
    const bridge = deadBridge();
    const routes = registerRoutes(app, {
        bridge,
        build: 'test',
        startedAt: Date.now(),
        musicRoot: opts.musicRoot ?? '/nonexistent-music-root',
        // A path that cannot exist, so control attempts fail fast and loudly
        // rather than reaching a real arbiter on a developer's machine.
        bluetoothControl: opts.bluetoothControl ?? '/nonexistent-run-dir/control',
    });
    // Composed as production composes it: the JSON 404 for /api/* lives here.
    registerStatic(app, '/nonexistent-web-root');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return { app, bridge, routes, port: address.port };
}

/** Open an SSE stream and resolve once headers have arrived. */
function openStream(port: number): Promise<{ destroy: () => void }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            { host: '127.0.0.1', port, path: '/api/events', method: 'GET' },
            (res) => {
                res.on('data', () => {}); // keep the stream flowing
                res.on('error', () => {});
                resolve({ destroy: () => req.destroy() });
            },
        );
        req.on('error', reject);
        req.end();
    });
}

test('an open SSE stream does not wedge shutdown', async () => {
    const { app, bridge, routes, port } = await startServer();
    const stream = await openStream(port);

    const started = Date.now();
    bridge.stop();
    routes.closeStreams();
    await Promise.race([
        app.close(),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('app.close() did not finish within 5s')), 5000),
        ),
    ]);
    const elapsed = Date.now() - started;

    stream.destroy();
    assert.ok(elapsed < 5000, `shutdown took ${elapsed}ms`);
});

test('closeStreams alone is enough, even without forceCloseConnections', async () => {
    // Two independent mechanisms now prevent the hang seen on the device:
    // forceCloseConnections destroys sockets, and closeStreams ends the SSE
    // responses. This pins the second one by switching the first off.
    const { app, bridge, routes, port } = await startServer({ forceCloseConnections: false });
    const stream = await openStream(port);

    bridge.stop();
    routes.closeStreams();
    const started = Date.now();
    await Promise.race([
        app.close(),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('close() hung despite closeStreams()')), 4000),
        ),
    ]);
    assert.ok(Date.now() - started < 4000);
    stream.destroy();
});

test('without either mechanism, close() really does hang — the original bug', async () => {
    // Documents the failure observed on the device: the service sat in
    // `deactivating` until systemd's stop timeout because the kiosk held an SSE
    // stream open. Deliberately calls neither closeStreams nor forceClose.
    const { app, bridge, port } = await startServer({ forceCloseConnections: false });
    const stream = await openStream(port);

    bridge.stop();
    let finished = false;
    void app.close().then(() => {
        finished = true;
    });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(finished, false, 'close() completed with an SSE stream still open');

    stream.destroy();
    await new Promise((r) => setTimeout(r, 300));
});

test('health answers even with MPD unreachable', async () => {
    const { app, bridge, routes, port } = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = (await response.json()) as { ok: boolean; mpd: string };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.mpd, 'unavailable');

    bridge.stop();
    routes.closeStreams();
    await app.close();
});

test('an unknown API route is a JSON 404, never the SPA page', async () => {
    const { app, bridge, routes, port } = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/api/nope`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not found' });

    bridge.stop();
    routes.closeStreams();
    await app.close();
});

test('an unknown playback command is rejected, not passed to MPD', async () => {
    const { app, bridge, routes, port } = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/api/playback/selfdestruct`, {
        method: 'POST',
    });
    assert.equal(response.status, 400);

    bridge.stop();
    routes.closeStreams();
    await app.close();
});

test('POST /api/volume no longer exists', async () => {
    // Volume is handled downstream; the endpoint was removed rather than left to
    // fail, so there is nothing pretending to work.
    const { app, bridge, routes, port } = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/api/volume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 50 }),
    });
    assert.equal(response.status, 404);

    bridge.stop();
    routes.closeStreams();
    await app.close();
});

test('a new SSE client is sent a FRESH frame, not the cached snapshot', async () => {
    // Guards the reported bug: reload after pause/resume showed the resume
    // position as current. The handler must refresh before its first frame.
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    const eventsHandler = src.slice(src.indexOf("app.get('/api/events'"));
    const refreshAt = eventsHandler.indexOf('bridge.refresh()');
    const sendAt = eventsHandler.indexOf('send(bridge.current)');
    assert.ok(refreshAt !== -1, '/api/events must refresh before sending');
    assert.ok(
        refreshAt < sendAt,
        'refresh() must come BEFORE the first send(), or the first frame is stale',
    );
});

test('/api/status refreshes rather than returning a cached snapshot', async () => {
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    const handler = src.slice(src.indexOf("app.get('/api/status'"), src.indexOf("app.get('/api/queue'"));
    assert.ok(handler.includes('bridge.refresh()'), '/api/status must refresh first');
});

/*
 * GET /api/art — the route wiring, end to end over real HTTP.
 *
 * Resolution logic itself is covered in art.test.ts; these assert the HTTP
 * contract, and in particular the 304 path, which is what stops a ~540KB cover
 * being re-sent on every page load over an unreliable wifi link.
 */

test('/api/art without an album parameter is a 400, not a 500', async () => {
    const { app, port } = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/api/art`);
    const body = (await response.json()) as { error?: string };
    await app.close();

    assert.equal(response.status, 400);
    assert.match(body.error ?? '', /album/);
});

test('/api/art for an album with no art is a 404 with the standard error shape', async () => {
    const { app, port } = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/api/art?album=Nobody/Nothing`);
    const body = (await response.json()) as { error?: string };
    await app.close();

    assert.equal(response.status, 404);
    assert.equal(typeof body.error, 'string');
});

test('/api/art serves the cover, then answers 304 to a conditional request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'musicbox-routes-art-'));
    try {
        const album = join(root, 'Artist', 'Album (1999)');
        await mkdir(album, { recursive: true });
        await writeFile(join(album, 'discart.jpg'), 'decoy disc image');
        await writeFile(join(album, 'folder.jpg'), 'PRETEND JPEG BYTES');

        const { app, port } = await startServer({ musicRoot: root });
        const url = `http://127.0.0.1:${port}/api/art?album=${encodeURIComponent('Artist/Album (1999)')}`;

        const first = await fetch(url);
        const bytes = await first.text();
        const etag = first.headers.get('etag');

        // Same URL again, this time conditional — as a browser would.
        const second = await fetch(url, { headers: { 'if-none-match': etag ?? '' } });
        const secondBody = await second.text();
        await app.close();

        assert.equal(first.status, 200);
        assert.equal(bytes, 'PRETEND JPEG BYTES', 'must serve folder.jpg, not the discart');
        assert.equal(first.headers.get('content-type'), 'image/jpeg');
        assert.equal(first.headers.get('content-length'), String('PRETEND JPEG BYTES'.length));
        assert.match(first.headers.get('cache-control') ?? '', /max-age=\d{5,}/);
        assert.ok(etag, 'an ETag is required for the 304 to be possible');

        assert.equal(second.status, 304, 'a matching ETag must produce 304');
        assert.equal(secondBody, '', '304 must carry no body');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('/api/art cannot be used to read files outside the music root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'musicbox-routes-esc-'));
    try {
        const root = join(base, 'library');
        await mkdir(root, { recursive: true });
        await mkdir(join(base, 'secrets'), { recursive: true });
        await writeFile(join(base, 'secrets', 'folder.jpg'), 'MUST NOT BE SERVED');

        const { app, port } = await startServer({ musicRoot: root });
        const response = await fetch(
            `http://127.0.0.1:${port}/api/art?album=${encodeURIComponent('../secrets')}`,
        );
        const body = await response.text();
        await app.close();

        assert.equal(response.status, 404);
        assert.equal(body.includes('MUST NOT BE SERVED'), false);
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

/*
 * The SSE build announcement.
 *
 * This exists because of a real failure: the kiosk loads the page once at boot
 * and never navigates again, so a deployed frontend never reached it. The panel
 * was found running a 14-hour-old bundle while the correct files sat on disk
 * being served perfectly. The server must state its build on every connection so
 * a client can notice it changed and reload.
 */

test('/api/events announces the build BEFORE the first snapshot', async () => {
    const { app, port } = await startServer();

    const frames = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
            { host: '127.0.0.1', port, path: '/api/events', method: 'GET' },
            (res) => {
                let buf = '';
                res.on('data', (chunk) => {
                    buf += chunk.toString('utf8');
                    // Both frames have arrived once we have two blank-line breaks.
                    if (buf.split('\n\n').length > 2) {
                        req.destroy();
                        resolve(buf);
                    }
                });
                res.on('error', () => {});
                res.on('close', () => resolve(buf));
            },
        );
        req.on('error', (err) => {
            // destroy() after resolving surfaces here; ignore once we have data.
            reject(err);
        });
        req.end();
    }).catch(() => '');

    await app.close();

    assert.match(frames, /event: build/, 'a build event must be sent');
    const buildAt = frames.indexOf('event: build');
    const snapshotAt = frames.indexOf('event: snapshot');
    assert.ok(buildAt !== -1 && snapshotAt !== -1, `got frames: ${JSON.stringify(frames)}`);
    assert.ok(buildAt < snapshotAt, 'the build must be stated before the first snapshot');
    assert.match(frames, /"build":"test"/, 'the build id itself must be in the payload');
});

test('a connected Bluetooth device reaches the client over SSE', async () => {
    /*
     * The end of the wire. The arbiter publishes a file, the watcher reads it,
     * the bridge republishes, and this is where it has to come out — on the same
     * snapshot frame as everything else, because a separate bluetooth event would
     * break the "every message is a complete snapshot" rule.
     *
     * Note the bridge here is pointed at a closed port, so this also pins down
     * that MPD being unreachable does not suppress the device: the two halves are
     * independent services and a phone can be playing while MPD is dead.
     */
    const { app, bridge, routes, port } = await startServer();
    try {
        await bridge.setBluetooth(PHONE);

        const frame = await new Promise<string>((resolve, reject) => {
            const req = httpRequest(
                { host: '127.0.0.1', port, path: '/api/events', method: 'GET' },
                (res) => {
                    let buf = '';
                    res.on('data', (chunk: Buffer) => {
                        buf += chunk.toString('utf8');
                        // The build frame is written first, so wait for the snapshot.
                        if (buf.includes(`event: ${SSE_SNAPSHOT_EVENT}`) && buf.includes('\n\n')) {
                            req.destroy();
                            resolve(buf);
                        }
                    });
                    res.on('error', () => {});
                },
            );
            req.on('error', (err) => reject(err));
            req.end();
            setTimeout(() => {
                req.destroy();
                reject(new Error('no snapshot frame within 5s'));
            }, 5_000);
        });

        const line = frame
            .split('\n')
            .find((l) => l.startsWith('data: ') && l.includes('"bluetooth"'));
        assert.ok(line, `no snapshot frame carrying bluetooth:\n${frame}`);
        const snapshot = JSON.parse(line.slice('data: '.length)) as Snapshot;
        assert.equal(snapshot.source, 'bluetooth');
        assert.equal(snapshot.bluetooth?.name, "Luke's iPhone");
        assert.equal(snapshot.bluetooth?.codec, 'aptX-HD');
        // The now-playing fields describe the phone, which is the whole point.
        assert.equal(snapshot.state, 'play');
        assert.equal(snapshot.track?.title, 'A National Acrobat');
        assert.equal(snapshot.track?.image, null, 'no cover art over Bluetooth');
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

test('with nothing connected the field is present and null', async () => {
    // Never an absent key — see the snapshot rule in src/shared/api.ts.
    const { app, routes, port } = await startServer();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`);
        const snapshot = (await res.json()) as Snapshot;
        assert.ok('bluetooth' in snapshot, 'bluetooth must always be a key');
        assert.equal(snapshot.bluetooth, null);
        assert.equal(snapshot.source, 'mpd');
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

/*
 * ---------------------------------------------------------------------------
 * Routing by source. The buttons mean "control what I am hearing", so every one
 * of them has to go to whichever source owns the DAC.
 * ---------------------------------------------------------------------------
 */

test('playback commands go to Bluetooth while a phone owns the DAC', async () => {
    /*
     * The bridge here is pointed at a closed port, so if the command reached MPD
     * it would come back 503 "MPD is not connected". A 503 naming the arbiter
     * instead proves it took the Bluetooth path — the control FIFO does not exist
     * in this test, which is exactly the failure that should be reported.
     */
    const { app, bridge, routes, port } = await startServer();
    try {
        await bridge.setBluetooth(PHONE);
        for (const command of ['play', 'pause', 'stop', 'next', 'previous']) {
            const res = await fetch(`http://127.0.0.1:${port}/api/playback/${command}`, {
                method: 'POST',
            });
            assert.equal(res.status, 503, command);
            const body = (await res.json()) as { error: string };
            assert.match(body.error, /arbiter is not running/, command);
        }
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

test('playback commands go to MPD when it owns the DAC', async () => {
    // The same requests against the same dead bridge, with no phone: now the
    // error must be MPD's, proving the branch is on `source` and not on luck.
    const { app, routes, port } = await startServer();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/playback/play`, { method: 'POST' });
        assert.equal(res.status, 503);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /MPD is not connected/);
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

test('the queue is refused, not emptied, during a Bluetooth session', async () => {
    /*
     * 409 rather than an empty array. A phone exposes no track list at all, and an
     * empty list is indistinguishable from "nothing queued" — a different and
     * answerable state.
     */
    const { app, bridge, routes, port } = await startServer();
    try {
        await bridge.setBluetooth(PHONE);
        const res = await fetch(`http://127.0.0.1:${port}/api/queue`);
        assert.equal(res.status, 409);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /no queue for the bluetooth source/);
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

test('disconnect is refused when there is nothing connected', async () => {
    const { app, routes, port } = await startServer();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/bluetooth/disconnect`, {
            method: 'POST',
        });
        assert.equal(res.status, 409);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /no bluetooth device is connected/);
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

test('disconnect reaches the arbiter, and reports honestly when it cannot', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        await bridge.setBluetooth(PHONE);
        const res = await fetch(`http://127.0.0.1:${port}/api/bluetooth/disconnect`, {
            method: 'POST',
        });
        assert.equal(res.status, 503);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /arbiter is not running/);
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

test('a Bluetooth command is accepted, not answered with a stale snapshot', async () => {
    /*
     * With a real FIFO behind it the response is 202 and carries no snapshot.
     * Returning `bridge.current` here would state the pre-command value as though
     * it were the result, and AVRCP takes seconds to settle — measured at about
     * four on the device. The truth arrives over SSE instead.
     */
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-routes-'));
    try {
        const fifo = join(dir, 'control');
        await new Promise<void>((resolve, reject) => {
            execFile('mkfifo', [fifo], (e) => (e ? reject(e) : resolve()));
        });
        const reader = await fsOpen(fifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
        const { app, bridge, routes, port } = await startServer({ bluetoothControl: fifo });
        try {
            await bridge.setBluetooth(PHONE);
            const res = await fetch(`http://127.0.0.1:${port}/api/playback/next`, {
                method: 'POST',
            });
            assert.equal(res.status, 202);
            assert.deepEqual(await res.json(), { accepted: 'next' });

            const buf = Buffer.alloc(32);
            const { bytesRead } = await reader.read(buf, 0, buf.length, null);
            assert.equal(buf.subarray(0, bytesRead).toString('utf8'), 'next\n');
        } finally {
            routes.closeStreams();
            await app.close();
            await reader.close();
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
