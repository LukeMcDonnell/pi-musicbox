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
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRoutes } from './routes.ts';
import type { LibraryState } from '../../shared/api.ts';
import { registerStatic } from './static.ts';
import { MpdBridge } from './mpd/bridge.ts';
import { SSE_SETTINGS_EVENT, SSE_SNAPSHOT_EVENT, type Snapshot } from '../../shared/api.ts';
import type { BluetoothState } from './bluetooth.ts';
import { isLoopback } from './routes.ts';
import type { Panel } from './panel.ts';
import { createSettings, SETTINGS_DEFAULTS, type Settings } from './settings.ts';
import { ScanRefusedError, type LibraryScanner } from './library-scan.ts';
import { openDb } from './db.ts';
import { createPower, type Power } from './power.ts';
import { BackupError, type Backups } from './backup.ts';
import { createFavourites, type Favourites } from './favourites.ts';
import type { LibrarySong } from './mpd/bridge.ts';

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
    opts: {
        forceCloseConnections?: boolean;
        musicRoot?: string;
        bluetoothControl?: string;
        panel?: Panel;
        settings?: Settings;
        power?: Power;
        scanner?: LibraryScanner;
        backups?: Backups;
        favourites?: Favourites;
    } = {},
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
        panel: opts.panel,
        settings: opts.settings,
        power: opts.power,
        scanner: opts.scanner,
        backups: opts.backups,
        favourites: opts.favourites,
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

test('playing a queue track by id goes to MPD', async () => {
    /*
     * Same dead-bridge trick as the transport commands above: MPD's own error
     * proves the request reached the MPD path rather than being rejected by the
     * validation or swallowed somewhere else.
     */
    const { app, routes, port } = await startServer();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/queue/play/42`, { method: 'POST' });
        assert.equal(res.status, 503);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /MPD is not connected/);
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

test('playing a queue track is refused during a Bluetooth session', async () => {
    // A phone exposes no addressable track list, so there is no id to honour —
    // the same reason GET /api/queue is a 409 rather than an empty listing.
    const { app, bridge, routes, port } = await startServer();
    try {
        await bridge.setBluetooth(PHONE);
        const res = await fetch(`http://127.0.0.1:${port}/api/queue/play/42`, { method: 'POST' });
        assert.equal(res.status, 409);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /phone owns the DAC/);
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

test('a song id that is not a non-negative integer never reaches MPD', async () => {
    /*
     * 400, not 503. The distinction is the whole point: 503 would mean the id was
     * accepted and MPD was asked, and this value is interpolated into an MPD
     * command line.
     */
    const { app, routes, port } = await startServer();
    try {
        // '' is in the list because Number('') is 0: before the check was a
        // string test, POST /api/queue/play/ played song id 0.
        for (const id of ['abc', '-1', '1.5', '1e2', '0x10', 'a%20b', '']) {
            const res = await fetch(`http://127.0.0.1:${port}/api/queue/play/${id}`, {
                method: 'POST',
            });
            // An empty segment is not this route at all; anything else must be a
            // rejection, and never MPD's.
            assert.notEqual(res.status, 503, id);
            if (res.status === 400) {
                const body = (await res.json()) as { error: string };
                assert.match(body.error, /invalid song id/, id);
            }
        }
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

test('the queue jump is sent as playid, not play', async () => {
    // `play <n>` addresses a POSITION, which shifts under a reorder. Asserted on
    // the source because a dead bridge cannot show what was sent on the wire.
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    const handler = src.slice(
        src.indexOf("app.post('/api/queue/play/:id'"),
        src.indexOf("app.post('/api/playback/:command'"),
    );
    assert.match(handler, /bridge\.command\(`playid \$\{Number\(id\)\}`\)/);
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

/*
 * LIBRARY BROWSE
 *
 * Listing and grouping logic lives in library.test.ts against a fake bridge;
 * these are the HTTP contract — what each route does with a bad parameter, with
 * a phone on the DAC, and with MPD unreachable. The dead bridge is what makes
 * the last one honest: a 503 saying "MPD is not connected" proves the request
 * reached MPD's side rather than being rejected on the way.
 */

test('library listings reject a missing or empty parameter before reaching MPD', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        const cases: Array<[string, RegExp]> = [
            ['/api/library/albums', /missing 'artist'/],
            ['/api/library/albums?artist=', /missing 'artist'/],
            ['/api/library/album?album=Kid%20A', /missing 'artist'/],
            ['/api/library/album?artist=Radiohead', /missing 'album'/],
            ['/api/library/album?artist=Radiohead&album=', /missing 'album'/],
        ];
        for (const [path, expected] of cases) {
            const res = await fetch(`http://127.0.0.1:${port}${path}`);
            // 400, never 503: a missing parameter is the caller's mistake, and
            // answering with MPD's status would blame the wrong thing.
            assert.equal(res.status, 400, path);
            const body = (await res.json()) as { error: string };
            assert.match(body.error, expected, path);
        }
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('library listings answer 503 when MPD is unreachable', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        for (const path of [
            '/api/library/artists',
            '/api/library/albums?artist=Radiohead',
            '/api/library/album?artist=Radiohead&album=Kid%20A',
        ]) {
            const res = await fetch(`http://127.0.0.1:${port}${path}`);
            assert.equal(res.status, 503, path);
            const body = (await res.json()) as { error: string };
            assert.match(body.error, /MPD is not connected/, path);
        }
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('a failed artists build is not cached as an empty library', async () => {
    // MPD restarting must not leave the library permanently empty. Asserted over
    // HTTP as well as in library.test.ts because the route holds the one
    // long-lived index in the process.
    const { app, bridge, routes, port } = await startServer();
    try {
        for (let i = 0; i < 3; i += 1) {
            const res = await fetch(`http://127.0.0.1:${port}/api/library/artists`);
            assert.equal(res.status, 503, `attempt ${i}`);
        }
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('queueing and playing an album are refused while a phone owns the DAC', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        await bridge.setBluetooth(PHONE);
        for (const path of ['/api/library/queue', '/api/library/play']) {
            const res = await fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ albumArtist: 'Radiohead', album: 'Kid A' }),
            });
            // 409 for the same reason GET /api/queue is one: MPD's queue is not
            // what anyone is listening to during a Bluetooth session, so adding
            // to it silently would be a button that appears to do nothing.
            assert.equal(res.status, 409, path);
            const body = (await res.json()) as { error: string };
            assert.match(body.error, /phone owns the DAC/, path);
        }
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('an album reference is validated as strings before it can reach a command line', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        const bodies: unknown[] = [
            {},
            { albumArtist: 'Radiohead' },
            { album: 'Kid A' },
            { albumArtist: '', album: 'Kid A' },
            { albumArtist: 'Radiohead', album: '' },
            // The reason the check is `typeof === 'string'` and not truthiness:
            // these reach quoteArg as "[object Object]" or "1" and quietly match
            // nothing, which looks to a user like a broken button.
            { albumArtist: { toString: () => 'x' }, album: 'Kid A' },
            { albumArtist: 1, album: 2 },
            { albumArtist: ['Radiohead'], album: 'Kid A' },
            // `disc` is optional, but held to the same standard once supplied.
            // `1` would reach quoteArg as "1" and happen to work; `{}` as
            // "[object Object]" and silently match nothing.
            { albumArtist: 'Radiohead', album: 'Kid A', disc: 1 },
            { albumArtist: 'Radiohead', album: 'Kid A', disc: '' },
            { albumArtist: 'Radiohead', album: 'Kid A', disc: {} },
            { albumArtist: 'Radiohead', album: 'Kid A', disc: null },
        ];
        for (const body of bodies) {
            for (const path of ['/api/library/queue', '/api/library/play']) {
                const res = await fetch(`http://127.0.0.1:${port}${path}`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                });
                const label = `${path} ${JSON.stringify(body)}`;
                assert.equal(res.status, 400, label);
                // Never MPD's error: rejection must happen before the bridge.
                assert.notEqual(res.status, 503, label);
            }
        }
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('playing an album clears the queue first, and queueing does not', async () => {
    // Asserted on the source: a dead bridge cannot show what was sent on the
    // wire, and the difference between these two routes IS the `clear`.
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');

    const play = src.slice(
        src.indexOf("app.post('/api/library/play'"),
        src.indexOf("app.get('/api/events'"),
    );
    assert.match(
        play,
        /runAll\(\['clear', findaddFor\(ref\), 'play'\]\)/,
        'play must clear, add, then play — in that order',
    );

    const queue = src.slice(
        src.indexOf("app.post('/api/library/queue'"),
        src.indexOf("app.post('/api/library/play'"),
    );
    assert.ok(
        !queue.includes("'clear'"),
        'queueing an album must APPEND — it must never clear the queue',
    );
});

test('a valid disc is accepted, and reaches MPD rather than being rejected', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        for (const path of ['/api/library/queue', '/api/library/play']) {
            const res = await fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    albumArtist: 'Alice in Chains',
                    album: 'Music Bank',
                    disc: '2',
                }),
            });
            // 503 because this bridge has no MPD, which is the point: the ref
            // passed validation and got as far as the wire. A 400 would mean
            // `disc` was rejected before it ever reached MPD.
            assert.equal(res.status, 503, path);
        }
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('a disc narrows the findadd with one more quoted pair', async () => {
    // Measured on the real library: `disc "1"` + `"2"` + `"3"` is 17 + 17 + 14
    // against 48 for the whole album. Asserted on the source for the same reason
    // the test below is — a dead bridge shows nothing of what was sent.
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    const helper = src.slice(src.indexOf('function findaddFor('));
    assert.match(helper, /\$\{quoteArg\('disc'\)\} \$\{quoteArg\(ref\.disc\)\}/);
    // And it must stay OPTIONAL: a whole album carries no disc filter at all.
    assert.match(helper, /ref\.disc === undefined/);
});

test('an album is added with one findadd, not a track at a time', async () => {
    // A song-at-a-time add bumps queueVersion once per track, so a client
    // watching that version refetches the whole listing a dozen times for one
    // button press. Both fields go through quoteArg separately.
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    const helper = src.slice(src.indexOf('function findaddFor('));
    assert.match(helper, /findadd \$\{quoteArg\('albumartist'\)\} \$\{quoteArg\(ref\.albumArtist\)\}/);
    assert.match(helper, /\$\{quoteArg\('album'\)\} \$\{quoteArg\(ref\.album\)\}/);
});

test('the library index is invalidated by MPD, not by a timer', async () => {
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    const hook = src.slice(src.indexOf('bridge.onIdle('), src.indexOf("app.get('/api/library/artists'"));
    // Via onIdle, not onSnapshot: a snapshot deliberately says nothing about the
    // library, so a database change has nowhere else to travel.
    assert.match(hook, /subsystems\.includes\('database'\)/);
    assert.match(hook, /subsystems\.includes\('update'\)/);
    assert.match(hook, /library\.invalidate\(\)/);
});

// ---------------------------------------------------------------------------
// The panel and the box's settings.
// ---------------------------------------------------------------------------

/** A backlight with no hardware behind it. */
function fakePanel(supported = true): Panel & { calls: boolean[] } {
    let on = true;
    const calls: boolean[] = [];
    return {
        supported,
        calls,
        isOn: () => on,
        set(next: boolean) {
            if (!supported) return false;
            calls.push(next);
            on = next;
            return true;
        },
    };
}

function memorySettings(): Settings {
    return createSettings(openDb({ path: ':memory:' }));
}

async function api(
    port: number,
    path: string,
    init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: init?.method ?? 'GET',
        headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

/** Open an SSE stream and collect the raw text as it arrives. */
function collectStream(port: number): Promise<{ text: () => string; destroy: () => void }> {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const req = httpRequest(
            { host: '127.0.0.1', port, path: '/api/events', method: 'GET' },
            (res) => {
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    buffer += chunk;
                });
                res.on('error', () => {});
                resolve({ text: () => buffer, destroy: () => req.destroy() });
            },
        );
        req.on('error', reject);
        req.end();
    });
}

const settle = () => new Promise((r) => setTimeout(r, 60));

/**
 * startServer, with teardown registered up front.
 *
 * The tests below assert before they clean up, and an assertion throws — so
 * cleanup written at the end of a test never runs when that test fails, leaving
 * a listening server and a live bridge that keep the runner's event loop open.
 * One failure then looks like a hung suite, which is a miserable way to find out
 * something broke.
 */
async function serverFor(t: { after: (fn: () => unknown) => void }, opts: Parameters<typeof startServer>[0] = {}) {
    const started = await startServer(opts);
    t.after(async () => {
        started.bridge.stop();
        started.routes.closeStreams();
        await started.app.close();
    });
    return started;
}

async function streamFor(t: { after: (fn: () => unknown) => void }, port: number) {
    const stream = await collectStream(port);
    t.after(() => stream.destroy());
    await settle();
    return stream;
}

test('isLoopback is what tells the panel apart from a phone', () => {
    // The kiosk loads http://localhost/, so its stream is the loopback one.
    assert.equal(isLoopback('127.0.0.1'), true);
    assert.equal(isLoopback('::1'), true);
    assert.equal(isLoopback('::ffff:127.0.0.1'), true);
    assert.equal(isLoopback('192.168.1.42'), false);
    assert.equal(isLoopback(undefined), false);
    assert.equal(isLoopback(''), false);
});

test('a box with no backlight says so instead of pretending', async (t) => {
    const { port } = await serverFor(t);
    const state = await api(port, '/api/panel');
    assert.equal(state.status, 200);
    assert.deepEqual(state.body, { supported: false, on: true });

    const off = await api(port, '/api/panel/backlight', { method: 'POST', body: { on: false } });
    assert.equal(off.status, 503);
});

test('the panel may sleep itself while its own stream is open', async (t) => {
    const panel = fakePanel();
    const { port } = await serverFor(t, { panel });
    await streamFor(t, port);

    const off = await api(port, '/api/panel/backlight', { method: 'POST', body: { on: false } });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body, { supported: true, on: false });
    assert.equal(panel.isOn(), false);

    const on = await api(port, '/api/panel/backlight', { method: 'POST', body: { on: true } });
    assert.equal(on.status, 200);
    assert.equal(panel.isOn(), true);
});

test('with no panel client connected, sleeping is refused', async (t) => {
    // Nothing would be able to wake it: this is the "box looks dead" case.
    const panel = fakePanel();
    const { port } = await serverFor(t, { panel });

    const off = await api(port, '/api/panel/backlight', { method: 'POST', body: { on: false } });
    assert.equal(off.status, 409);
    assert.equal(panel.isOn(), true, 'the backlight must be untouched');
});

test('the backlight comes back when the panel stream dies — a crashed renderer', async (t) => {
    // The renderer crash is an open issue (roadmap.md). A crash with the screen
    // dark would leave a box nobody can tell is running.
    const panel = fakePanel();
    const { port } = await serverFor(t, { panel });
    const stream = await streamFor(t, port);

    await api(port, '/api/panel/backlight', { method: 'POST', body: { on: false } });
    assert.equal(panel.isOn(), false);

    stream.destroy();
    await settle();
    assert.equal(panel.isOn(), true, 'the last panel stream closing must restore it');
});

test('a malformed backlight request is refused before anything is written', async (t) => {
    const panel = fakePanel();
    const { port } = await serverFor(t, { panel });
    for (const body of [{}, { on: 'yes' }, { on: 1 }, { on: null }]) {
        const res = await api(port, '/api/panel/backlight', { method: 'POST', body });
        assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(panel.calls, []);
});

test('GET /api/settings answers the defaults on a fresh box', async (t) => {
    const { port } = await serverFor(t, { settings: memorySettings() });
    const res = await api(port, '/api/settings');
    assert.equal(res.status, 200);
    // Against the constant, not a literal, so a new setting is no churn here.
    assert.deepEqual(res.body, SETTINGS_DEFAULTS);
});

test('PATCH /api/settings writes, and the next GET agrees', async (t) => {
    const { port } = await serverFor(t, { settings: memorySettings() });
    const patched = await api(port, '/api/settings', {
        method: 'PATCH',
        body: { panelSleepAfterMinutes: 5 },
    });
    const expected = { ...SETTINGS_DEFAULTS, panelSleepAfterMinutes: 5 };
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body, expected);
    assert.deepEqual((await api(port, '/api/settings')).body, expected);
});

test('a PATCH the guard rejects changes nothing at all', async (t) => {
    const settings = memorySettings();
    const { port } = await serverFor(t, { settings });
    settings.set('panelSleepAfterMinutes', 10);

    for (const body of [
        { panelSleepAfterMinutes: 12 },   // not on the list the UI offers
        { panelSleepAfterMinutes: '7.5' },
        { panelSleepAfterMinutes: null },
        { somethingElse: 1 },             // not a setting
        {},                               // nothing to do
        [1, 2],                           // not even an object
    ]) {
        const res = await api(port, '/api/settings', { method: 'PATCH', body });
        assert.equal(res.status, 400, JSON.stringify(body));
    }
    // Still what it was: a rejected patch must not half-apply.
    assert.equal(settings.all().panelSleepAfterMinutes, 10);
});

test('settings arrive on the stream, at connect and again on every change', async (t) => {
    // A phone changes it; the panel is the thing that has to act on it. Polling
    // would mean the panel obeying a stale answer until the next poll.
    const settings = memorySettings();
    const { port } = await serverFor(t, { settings });
    const stream = await streamFor(t, port);

    assert.match(stream.text(), new RegExp(`event: ${SSE_SETTINGS_EVENT}`));
    assert.match(stream.text(), /"panelSleepAfterMinutes":0/);

    await api(port, '/api/settings', { method: 'PATCH', body: { panelSleepAfterMinutes: 15 } });
    await settle();
    assert.match(stream.text(), /"panelSleepAfterMinutes":15/);
});

test('POST /api/power/<action> writes the request and answers 202', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-power-routes-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const { port } = await serverFor(t, { power: createPower(dir) });

    const res = await api(port, '/api/power/shutdown', { method: 'POST' });
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { accepted: 'shutdown' });
    // Root acts on the file; there is nothing else to report, and this process
    // is about to be killed by systemd if it worked.
    assert.deepEqual(await readdir(dir), ['shutdown']);
});

test('an action that is not restart or shutdown is a 400, and writes nothing', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-power-routes-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const { port } = await serverFor(t, { power: createPower(dir) });

    for (const action of ['poweroff', 'halt', 'reboot', '..%2Fshutdown', 'shutdown%20now']) {
        const res = await api(port, `/api/power/${action}`, { method: 'POST' });
        assert.equal(res.status, 400, action);
    }
    assert.deepEqual(await readdir(dir), []);
});

test('a box with no power helper answers 503, not 500', async (t) => {
    const { port } = await serverFor(t, { power: createPower('/nonexistent-power-dir') });
    const res = await api(port, '/api/power/restart', { method: 'POST' });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /setup-server\.sh/);
});

// ---------------------------------------------------------------------------
// Scanning the library.
// ---------------------------------------------------------------------------

/** A scanner with no MPD and no filesystem behind it. */
function fakeScanner(
    over: { scanning?: boolean; refuse?: ScanRefusedError } = {},
): LibraryScanner & { asked: string[] } {
    const asked: string[] = [];
    const state = (): LibraryState => ({
        scanning: over.scanning ?? false,
        scanStartedAt: over.scanning ? 1000 : null,
        scanTrigger: over.scanning ? 'manual' : null,
        lastScan: null,
        stats: { songs: 37289, albums: 2731, artists: 535, playtimeSeconds: 10, lastUpdatedAt: 5 },
        musicRoot: '/srv/music/Music',
        musicRootReadable: true,
        nextScanAt: null,
    });
    return {
        asked,
        state,
        refresh: async () => state(),
        scan: async (trigger) => {
            asked.push(trigger);
            if (over.refuse) throw over.refuse;
        },
        start: () => {},
        stop: () => {},
        onChange: () => () => {},
    };
}

/** Read an SSE stream until `breaks` frames have arrived. */
async function sseFrames(port: number, breaks: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const req = httpRequest(
            { host: '127.0.0.1', port, path: '/api/events', method: 'GET' },
            (res) => {
                let buf = '';
                res.on('data', (chunk) => {
                    buf += chunk.toString('utf8');
                    if (buf.split('\n\n').length > breaks) {
                        req.destroy();
                        resolve(buf);
                    }
                });
                res.on('error', () => {});
                res.on('close', () => resolve(buf));
            },
        );
        req.on('error', (err) => reject(err));
        req.end();
    }).catch(() => '');
}

test('the library routes answer 503 on a box with no scanner wired up', async (t) => {
    const { port } = await serverFor(t);
    assert.equal((await api(port, '/api/library/state')).status, 503);
    assert.equal((await api(port, '/api/library/scan', { method: 'POST' })).status, 503);
    assert.equal((await api(port, '/api/library/rescan', { method: 'POST' })).status, 503);
});

test('GET /api/library/state answers the complete state', async (t) => {
    const { port } = await serverFor(t, { scanner: fakeScanner() });
    const res = await api(port, '/api/library/state');
    assert.equal(res.status, 200);
    assert.equal(res.body.scanning, false);
    assert.equal(res.body.stats.songs, 37289);
    assert.equal(res.body.musicRoot, '/srv/music/Music');
    // Every key present, null being the empty value — as everywhere else here.
    for (const key of [
        'scanning',
        'scanStartedAt',
        'scanTrigger',
        'lastScan',
        'stats',
        'musicRoot',
        'musicRootReadable',
        'nextScanAt',
    ]) {
        assert.ok(key in res.body, `missing ${key}`);
    }
});

test('POST /api/library/scan is accepted with a 202, because a scan takes an hour', async (t) => {
    const scanner = fakeScanner();
    const { port } = await serverFor(t, { scanner });
    const res = await api(port, '/api/library/scan', { method: 'POST' });
    assert.equal(res.status, 202);
    assert.deepEqual(scanner.asked, ['manual']);
});

test('POST /api/library/rescan asks for a rescan, not an update', async (t) => {
    const scanner = fakeScanner();
    const { port } = await serverFor(t, { scanner });
    const res = await api(port, '/api/library/rescan', { method: 'POST' });
    assert.equal(res.status, 202);
    // Two routes rather than one with a flag: the expensive one should not be
    // the easy thing to reach by accident.
    assert.deepEqual(scanner.asked, ['rescan']);
});

test('a second scan is refused with 409 while one is running', async (t) => {
    const scanner = fakeScanner({
        scanning: true,
        refuse: new ScanRefusedError('a scan is already running', 409),
    });
    const { port } = await serverFor(t, { scanner });
    const res = await api(port, '/api/library/scan', { method: 'POST' });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already running/);
});

test('a scan is refused with 503 when the share cannot be read, and says so', async (t) => {
    const scanner = fakeScanner({
        refuse: new ScanRefusedError('the music share is not reachable', 503),
    });
    const { port } = await serverFor(t, { scanner });
    const res = await api(port, '/api/library/scan', { method: 'POST' });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /not reachable/);
});

test('/api/events sends the library event after the settings and before the snapshot', async (t) => {
    const { port } = await serverFor(t, {
        settings: memorySettings(),
        scanner: fakeScanner(),
    });
    const frames = await sseFrames(port, 3);

    const buildAt = frames.indexOf('event: build');
    const settingsAt = frames.indexOf('event: settings');
    const libraryAt = frames.indexOf('event: library');
    assert.ok(buildAt !== -1 && settingsAt !== -1 && libraryAt !== -1, frames);
    assert.ok(buildAt < settingsAt, 'build first');
    assert.ok(settingsAt < libraryAt, 'then the settings');
    assert.match(frames, /"musicRoot":"\/srv\/music\/Music"/);
});

test('the library frame on a new stream does NOT probe the music share', async (t) => {
    // The probe stats an NFS automount and can block for as long as the mount
    // timeout. Doing it here would hold up the first frame for every client.
    const scanner = fakeScanner();
    let refreshed = 0;
    const counting: LibraryScanner = {
        ...scanner,
        refresh: async () => {
            refreshed += 1;
            return scanner.state();
        },
    };
    const { port } = await serverFor(t, { scanner: counting });
    await sseFrames(port, 2);
    assert.equal(refreshed, 0, 'the stream must use the cached state');
});

test('a library sink is removed when its stream closes', async (t) => {
    const scanner = fakeScanner();
    let sink: ((state: LibraryState) => void) | null = null;
    const capturing: LibraryScanner = {
        ...scanner,
        onChange: (fn) => {
            sink = fn;
            return () => {};
        },
    };
    const { port } = await serverFor(t, { scanner: capturing });
    await sseFrames(port, 2);
    await new Promise((r) => setTimeout(r, 50));
    // The sink fans out to per-stream writers; with every stream gone it must
    // write to nothing rather than to a destroyed socket.
    assert.doesNotThrow(() => sink?.(scanner.state()));
});

test('the scanner is wired up outside routes.ts, so this file still has one onIdle', () => {
    // Insurance for the assertion above, which finds the invalidation hook with
    // indexOf and would silently read a different hook if a second one appeared.
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    assert.equal(src.split('bridge.onIdle(').length - 1, 1);
});

test('the library scan routes are the last routes in the file', () => {
    // The panel comment says why: three tests here slice this file between route
    // literals, so a route inserted higher up changes what they assert.
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    assert.ok(src.indexOf("app.post('/api/power/:action'") < src.indexOf("app.get('/api/library/state'"));
    assert.ok(src.indexOf("app.get('/api/events'") < src.indexOf("app.post('/api/library/scan'"));
});

// ---------------------------------------------------------------------------
// Backup and restore.
// ---------------------------------------------------------------------------

/** Backups with no filesystem behind them; records what restore was handed. */
function fakeBackups(over: { refuse?: BackupError } = {}): Backups & { restored: Buffer[] } {
    const restored: Buffer[] = [];
    return {
        restored,
        create: async () => ({ filename: 'musicbox-backup-20260917-0905.tar.gz', archive: Buffer.from([0x1f, 0x8b, 1, 2]) }),
        pending: async () => false,
        restore: async (archive) => {
            if (over.refuse) throw over.refuse;
            restored.push(archive);
        },
    };
}

function upload(port: number, body: Buffer | string, contentType = 'application/gzip') {
    return fetch(`http://127.0.0.1:${port}/api/restore`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
    });
}

test('GET /api/backup downloads the archive as an attachment', async (t) => {
    const { port } = await serverFor(t, { backups: fakeBackups() });
    const res = await fetch(`http://127.0.0.1:${port}/api/backup`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/gzip');
    assert.equal(
        res.headers.get('content-disposition'),
        'attachment; filename="musicbox-backup-20260917-0905.tar.gz"',
    );
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from([0x1f, 0x8b, 1, 2]));
});

test('POST /api/restore hands the raw bytes over and answers 202', async (t) => {
    const backups = fakeBackups();
    const { port } = await serverFor(t, { backups });
    const res = await upload(port, Buffer.from([0x1f, 0x8b, 9, 9]));
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 'restore' });
    assert.deepEqual(backups.restored, [Buffer.from([0x1f, 0x8b, 9, 9])]);
});

test('a restore that is not a gzip body never reaches the backups', async (t) => {
    const backups = fakeBackups();
    const { port } = await serverFor(t, { backups });
    assert.equal((await upload(port, '{"a":1}', 'application/json')).status, 400);
    assert.equal((await upload(port, 'hello', 'text/plain')).status, 400);
    assert.equal((await upload(port, 'hello', 'application/x-tar')).status, 415);
    assert.deepEqual(backups.restored, []);
});

test('an archive the backups refuse is reported with its own status', async (t) => {
    const { port } = await serverFor(t, { backups: fakeBackups({ refuse: new BackupError('backup is missing mpd/state', 400) }) });
    const res = await upload(port, Buffer.from('x'));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /mpd\/state/);
});

test('restore is refused while a library scan runs', async (t) => {
    const backups = fakeBackups();
    const { port } = await serverFor(t, { backups, scanner: fakeScanner({ scanning: true }) });
    assert.equal((await upload(port, Buffer.from('x'))).status, 409);
    assert.deepEqual(backups.restored, []);
});

test('restore is refused while a phone is playing', async (t) => {
    const backups = fakeBackups();
    const { port, bridge } = await serverFor(t, { backups });
    await bridge.setBluetooth(PHONE);
    assert.equal((await upload(port, Buffer.from('x'))).status, 409);
    assert.deepEqual(backups.restored, []);
});

test('backup routes answer 503 on a box with none wired up', async (t) => {
    const { port } = await serverFor(t);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/backup`)).status, 503);
    assert.equal((await upload(port, Buffer.from('x'))).status, 503);
});

// ---------------------------------------------------------------------------
// Favourites.
// ---------------------------------------------------------------------------

function memoryFavourites(): Favourites {
    let clock = 1000;
    return createFavourites(openDb({ path: ':memory:' }), () => clock++);
}

function song(albumArtist: string, album: string, track: string, date = '1997'): LibrarySong {
    const file = `${albumArtist}/${album}/${track}.flac`;
    return {
        track: { file, albumArtist, album, track, date, title: `Track ${track}`, duration: 200, image: '/api/art?album=x' },
        genres: ['Rock'],
    };
}

/** Answer every album lookup from a fixed list, as MPD's tag database would. */
function stockLibrary(bridge: MpdBridge, songs: LibrarySong[]): void {
    bridge.findSongs = async (...pairs) => {
        const want = new Map(pairs);
        return songs.filter(
            (s) => s.track.albumArtist === want.get('albumartist') && s.track.album === want.get('album'),
        );
    };
}

test('PUT favourites an album the library has, keyed by artist and album', async (t) => {
    const { port, bridge } = await serverFor(t, { favourites: memoryFavourites() });
    stockLibrary(bridge, [song('Eagles', 'Greatest Hits', '1'), song('Queen', 'Greatest Hits', '1'), song('Queen', 'Greatest Hits', '2')]);
    const put = await api(port, '/api/favourites/album?artist=Queen&album=Greatest%20Hits', { method: 'PUT' });
    assert.equal(put.status, 200);
    assert.equal(put.body.albums.length, 1);
    assert.equal(put.body.albums[0].albumArtist, 'Queen');
    assert.equal(put.body.albums[0].trackCount, 2);
    assert.equal(put.body.albums[0].addedAt, 1000);
    assert.deepEqual((await api(port, '/api/favourites')).body, put.body);
});

test('PUT for an album the library does not have is a 404 and stores nothing', async (t) => {
    const { port, bridge } = await serverFor(t, { favourites: memoryFavourites() });
    stockLibrary(bridge, []);
    const put = await api(port, '/api/favourites/album?artist=Nobody&album=Nothing', { method: 'PUT' });
    assert.equal(put.status, 404);
    assert.deepEqual((await api(port, '/api/favourites')).body, { albums: [] });
});

test('PUT answers 503 when MPD cannot be asked', async (t) => {
    const { port } = await serverFor(t, { favourites: memoryFavourites() });
    const put = await api(port, '/api/favourites/album?artist=A&album=B', { method: 'PUT' });
    assert.equal(put.status, 503);
});

test('favourite routes refuse a missing artist or album with 400', async (t) => {
    const { port } = await serverFor(t, { favourites: memoryFavourites() });
    for (const method of ['PUT', 'DELETE']) {
        for (const [query, message] of [
            ['?album=B', /missing 'artist'/],
            ['?artist=&album=B', /missing 'artist'/],
            ['?artist=A', /missing 'album'/],
        ] as const) {
            const res = await api(port, `/api/favourites/album${query}`, { method });
            assert.equal(res.status, 400, `${method} ${query}`);
            assert.match(res.body.error, message);
        }
    }
});

test('DELETE removes a favourite without asking MPD, so a vanished album can go', async (t) => {
    const favourites = memoryFavourites();
    favourites.add({ album: 'Gone', albumArtist: 'A', date: null, trackCount: 1, genres: [], discCount: 1, duration: null, image: null });
    const { port } = await serverFor(t, { favourites }); // dead bridge: MPD is unreachable
    const del = await api(port, '/api/favourites/album?artist=A&album=Gone', { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { albums: [] });
    assert.equal((await api(port, '/api/favourites/album?artist=A&album=Gone', { method: 'DELETE' })).status, 200);
});

test('opening a favourite album refreshes its stored summary', async (t) => {
    const favourites = memoryFavourites();
    const { port, bridge } = await serverFor(t, { favourites });
    stockLibrary(bridge, [song('A', 'One', '1', '1997')]);
    await api(port, '/api/favourites/album?artist=A&album=One', { method: 'PUT' });
    stockLibrary(bridge, [song('A', 'One', '1', '1980'), song('A', 'One', '2', '1980')]);
    assert.equal((await api(port, '/api/library/album?artist=A&album=One')).status, 200);
    const [stored] = favourites.all();
    assert.equal(stored?.date, '1980');
    assert.equal(stored?.trackCount, 2);
});

test('favourites arrive on the stream at connect and again on every change', async (t) => {
    const favourites = memoryFavourites();
    const { port, bridge } = await serverFor(t, { favourites, settings: memorySettings(), scanner: fakeScanner() });
    stockLibrary(bridge, [song('A', 'One', '1')]);
    const stream = await streamFor(t, port);
    const first = stream.text();
    assert.match(first, /event: favourites\ndata: \{"albums":\[\]\}/);
    assert.ok(first.indexOf('event: library') < first.indexOf('event: favourites'), 'after the library');

    await api(port, '/api/favourites/album?artist=A&album=One', { method: 'PUT' });
    await settle();
    const frames = stream.text().split('event: favourites').length - 1;
    assert.equal(frames, 2);
    assert.match(stream.text(), /"albumArtist":"A"/);
});

test('favourite routes answer 503 on a box with none wired up', async (t) => {
    const { port } = await serverFor(t);
    assert.equal((await api(port, '/api/favourites')).status, 503);
    assert.equal((await api(port, '/api/favourites/album?artist=A&album=B', { method: 'PUT' })).status, 503);
    assert.equal((await api(port, '/api/favourites/album?artist=A&album=B', { method: 'DELETE' })).status, 503);
});
