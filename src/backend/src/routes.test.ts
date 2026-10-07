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
import { thumbName } from './thumbs.ts';
import { registerRoutes } from './routes.ts';
import { BACKUP_MAX_BYTES, MAX_TRACKS, type LibraryState } from '../../shared/api.ts';
import { registerStatic } from './static.ts';
import { MpdBridge } from './mpd/bridge.ts';
import {
    MOST_PLAYED_ARTISTS_MAX,
    RECENT_PLAYS_MAX,
    SSE_SETTINGS_EVENT,
    SSE_SNAPSHOT_EVENT,
    type SearchResponse,
    type Snapshot,
} from '../../shared/api.ts';
import type { BluetoothState } from './bluetooth.ts';
import { discFromState } from './cd.ts';
import { albumNextCommands, isLoopback, trackAddCommands } from './routes.ts';
import type { Panel } from './panel.ts';
import { createSettings, SETTINGS_DEFAULTS, type Settings } from './settings.ts';
import { ScanRefusedError, type LibraryScanner } from './library-scan.ts';
import { openDb } from './db.ts';
import { createPower, type Power } from './power.ts';
import { BackupError, type Backups } from './backup.ts';
import type { CdArtBackups } from './cd-art-backup.ts';
import { createFavourites, type Favourites } from './favourites.ts';
import { releaseFilter } from './release.ts';
import { createPlays, type Plays, type TrackPlay } from './plays.ts';
import type { InfoLookup } from './library.ts';
import type { LibrarySong } from './mpd/bridge.ts';
import type { SystemStatusReader } from './system-status.ts';

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
        cdControl?: string;
        cdArtDir?: string;
        thumbDir?: string;
        panel?: Panel;
        settings?: Settings;
        power?: Power;
        scanner?: LibraryScanner;
        backups?: Backups;
        cdArtBackups?: CdArtBackups;
        favourites?: Favourites;
        plays?: Plays;
        info?: InfoLookup;
        systemStatus?: SystemStatusReader;
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
        cdControl: opts.cdControl ?? '/nonexistent-run-dir/cd-control',
        cdArtDir: opts.cdArtDir,
        thumbDir: opts.thumbDir,
        panel: opts.panel,
        settings: opts.settings,
        power: opts.power,
        scanner: opts.scanner,
        backups: opts.backups,
        cdArtBackups: opts.cdArtBackups,
        favourites: opts.favourites,
        plays: opts.plays,
        info: opts.info,
        systemStatus: opts.systemStatus,
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
            ['/api/library/album?album=Kid%20A&release=mb:1', /missing 'artist'/],
            ['/api/library/album?artist=Radiohead&album=Kid%20A', /missing 'release'/],
            ['/api/library/album?artist=Radiohead&album=Kid%20A&release=', /missing 'release'/],
            ['/api/library/search', /'q' must be/],
            ['/api/library/search?q=', /'q' must be/],
            ['/api/library/search?q=%20a%20', /'q' must be/],
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
            '/api/library/album?artist=Radiohead&album=Kid%20A&release=mb:1',
            '/api/library/search?q=radio',
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
        for (const path of ['/api/library/queue', '/api/library/next', '/api/library/play']) {
            const res = await fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ albumArtist: 'Radiohead', album: 'Kid A', release: 'mb:kid-a' }),
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
            for (const path of ['/api/library/queue', '/api/library/next', '/api/library/play']) {
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
        for (const path of ['/api/library/queue', '/api/library/next', '/api/library/play']) {
            const res = await fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    albumArtist: 'Alice in Chains',
                    album: 'Music Bank',
                    release: 'mb:music-bank',
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
    // ONE filter pair, from the release — not the album tag, which matches every
    // record sharing a title. Both halves still go through quoteArg separately.
    assert.match(helper, /releaseFilter\(ref\.release\)/);
    assert.match(helper, /findadd \$\{quoteArg\(tag\)\} \$\{quoteArg\(value\)\}/);
    assert.doesNotMatch(helper, /quoteArg\('album'\)/);
    // The disc still APPENDS to that one command rather than forking it.
    assert.match(helper, /\$\{quoteArg\('disc'\)\} \$\{quoteArg\(ref\.disc\)\}/);
});

test('a release resolves to the one MPD filter pair that selects it', () => {
    // Legacy filter form both ways, so findadd needs no filter-expression syntax.
    assert.deepEqual(releaseFilter('mb:1e477f68-c407-4eae-ad01-518528cedc2c'), [
        'MUSICBRAINZ_ALBUMID',
        '1e477f68-c407-4eae-ad01-518528cedc2c',
    ]);
    assert.deepEqual(releaseFilter("dir:Don't Stop Me Now/EP"), ['base', "Don't Stop Me Now/EP"]);
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

/** Cover backups with no filesystem behind them. */
function fakeCdArtBackups(over: { refuse?: BackupError } = {}): CdArtBackups & { restored: Buffer[] } {
    const restored: Buffer[] = [];
    return {
        restored,
        create: async () => ({ filename: 'musicbox-cd-covers-20260917-0905.tar.gz', archive: Buffer.from([0x1f, 0x8b, 3]) }),
        restore: async (archive) => {
            if (over.refuse) throw over.refuse;
            restored.push(archive);
            return 7;
        },
    };
}

function uploadCovers(port: number, body: Buffer | string, contentType = 'application/gzip') {
    return fetch(`http://127.0.0.1:${port}/api/cd/art/restore`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
    });
}

test('GET /api/cd/art/backup downloads the covers as an attachment', async (t) => {
    const { port } = await serverFor(t, { cdArtBackups: fakeCdArtBackups() });
    const res = await fetch(`http://127.0.0.1:${port}/api/cd/art/backup`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/gzip');
    assert.equal(
        res.headers.get('content-disposition'),
        'attachment; filename="musicbox-cd-covers-20260917-0905.tar.gz"',
    );
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from([0x1f, 0x8b, 3]));
});

test('POST /api/cd/art/restore answers with the count, even mid-scan or with a phone playing', async (t) => {
    const cdArtBackups = fakeCdArtBackups();
    const { port, bridge } = await serverFor(t, { cdArtBackups, scanner: fakeScanner({ scanning: true }) });
    await bridge.setBluetooth(PHONE);
    const res = await uploadCovers(port, Buffer.from([0x1f, 0x8b, 9]));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { restored: 7 });
    assert.deepEqual(cdArtBackups.restored, [Buffer.from([0x1f, 0x8b, 9])]);
});

test('a cover restore takes a body larger than the main backup allows', async (t) => {
    const cdArtBackups = fakeCdArtBackups();
    const { port } = await serverFor(t, { cdArtBackups });
    const res = await uploadCovers(port, Buffer.alloc(BACKUP_MAX_BYTES + 1));
    assert.equal(res.status, 200);
    assert.equal(cdArtBackups.restored[0]!.length, BACKUP_MAX_BYTES + 1);
});

test('a cover archive the backups refuse is reported with its own status', async (t) => {
    const { port } = await serverFor(t, {
        cdArtBackups: fakeCdArtBackups({ refuse: new BackupError('not a CD cover backup', 400) }),
    });
    const res = await uploadCovers(port, Buffer.from('x'));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /not a CD cover backup/);
    assert.equal((await uploadCovers(port, '{"a":1}', 'application/json')).status, 400);
});

test('cover backup routes answer 503 on a box with none wired up', async (t) => {
    const { port } = await serverFor(t);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/cd/art/backup`)).status, 503);
    assert.equal((await uploadCovers(port, Buffer.from('x'))).status, 503);
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
        track: {
            file,
            albumArtist,
            album,
            track,
            date,
            title: `Track ${track}`,
            duration: 200,
            image: '/api/art?album=x',
            release: releaseFor(albumArtist, album),
        },
        genres: ['Rock'],
    };
}

/** The release a fixture album gets, so a test can name one in a URL. */
function releaseFor(albumArtist: string, album: string): string {
    return `mb:${albumArtist}/${album}`;
}

/** Answer every album lookup from a fixed list, as MPD's tag database would. */
function stockLibrary(bridge: MpdBridge, songs: LibrarySong[]): void {
    bridge.findSongs = async (...pairs) => {
        const want = new Map(pairs);
        const mb = want.get('MUSICBRAINZ_ALBUMID');
        // The album screen and the favourite routes narrow by release; the
        // artist screen still asks for every song an AlbumArtist has.
        if (mb !== undefined) return songs.filter((s) => s.track.release === `mb:${mb}`);
        return songs.filter((s) => s.track.albumArtist === want.get('albumartist'));
    };
}

test('PUT favourites an album the library has, keyed by artist and album', async (t) => {
    const { port, bridge } = await serverFor(t, { favourites: memoryFavourites() });
    stockLibrary(bridge, [song('Eagles', 'Greatest Hits', '1'), song('Queen', 'Greatest Hits', '1'), song('Queen', 'Greatest Hits', '2')]);
    const put = await api(port, '/api/favourites/album?artist=Queen&release=mb:Queen/Greatest Hits', { method: 'PUT' });
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
    const put = await api(port, '/api/favourites/album?artist=Nobody&release=mb:Nobody/Nothing', { method: 'PUT' });
    assert.equal(put.status, 404);
    assert.deepEqual((await api(port, '/api/favourites')).body, { albums: [] });
});

test('PUT answers 503 when MPD cannot be asked', async (t) => {
    const { port } = await serverFor(t, { favourites: memoryFavourites() });
    const put = await api(port, '/api/favourites/album?artist=A&release=mb:A/B', { method: 'PUT' });
    assert.equal(put.status, 503);
});

test('favourite routes refuse a missing artist or release with 400', async (t) => {
    const { port } = await serverFor(t, { favourites: memoryFavourites() });
    for (const method of ['PUT', 'DELETE']) {
        for (const [query, message] of [
            ['?release=mb:1', /missing 'artist'/],
            ['?artist=&release=mb:1', /missing 'artist'/],
            ['?artist=A', /missing 'release'/],
            ['?artist=A&release=', /missing 'release'/],
        ] as const) {
            const res = await api(port, `/api/favourites/album${query}`, { method });
            assert.equal(res.status, 400, `${method} ${query}`);
            assert.match(res.body.error, message);
        }
    }
});

test('DELETE removes a favourite without asking MPD, so a vanished album can go', async (t) => {
    const favourites = memoryFavourites();
    favourites.add({ album: 'Gone', albumArtist: 'A', release: 'mb:A/Gone', date: null, trackCount: 1, genres: [], discCount: 1, duration: null, image: null });
    const { port } = await serverFor(t, { favourites }); // dead bridge: MPD is unreachable
    const del = await api(port, '/api/favourites/album?artist=A&release=mb:A/Gone', { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { albums: [] });
    assert.equal((await api(port, '/api/favourites/album?artist=A&release=mb:A/Gone', { method: 'DELETE' })).status, 200);
});

test('opening a favourite album refreshes its stored summary', async (t) => {
    const favourites = memoryFavourites();
    const { port, bridge } = await serverFor(t, { favourites });
    stockLibrary(bridge, [song('A', 'One', '1', '1997')]);
    await api(port, '/api/favourites/album?artist=A&release=mb:A/One', { method: 'PUT' });
    stockLibrary(bridge, [song('A', 'One', '1', '1980'), song('A', 'One', '2', '1980')]);
    assert.equal((await api(port, '/api/library/album?artist=A&album=One&release=mb:A/One')).status, 200);
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

    await api(port, '/api/favourites/album?artist=A&release=mb:A/One', { method: 'PUT' });
    await settle();
    const frames = stream.text().split('event: favourites').length - 1;
    assert.equal(frames, 2);
    assert.match(stream.text(), /"albumArtist":"A"/);
});

test('favourite routes answer 503 on a box with none wired up', async (t) => {
    const { port } = await serverFor(t);
    assert.equal((await api(port, '/api/favourites')).status, 503);
    assert.equal((await api(port, '/api/favourites/album?artist=A&release=mb:A/B', { method: 'PUT' })).status, 503);
    assert.equal((await api(port, '/api/favourites/album?artist=A&release=mb:A/B', { method: 'DELETE' })).status, 503);
});

// ---------------------------------------------------------------------------
// Recently added.
// ---------------------------------------------------------------------------

/** A newest-first stream of `count` albums, one song each. */
function addedStream(bridge: MpdBridge, count: number): void {
    bridge.songsByAdded = async (offset, window) =>
        Array.from({ length: Math.max(0, Math.min(window, count - offset)) }, (_, i) =>
            song('Artist', `Album ${offset + i}`, '1', '1997'),
        );
}

test('GET /api/library/recent answers the newest albums first, 100 by default', async (t) => {
    const { port, bridge } = await serverFor(t);
    addedStream(bridge, 150);
    const res = await api(port, '/api/library/recent');
    assert.equal(res.status, 200);
    assert.equal(res.body.albums.length, 100);
    assert.equal(res.body.albums[0].album, 'Album 0');
    // Only what a window of songs honestly knows — no track count, no runtime.
    assert.deepEqual(Object.keys(res.body.albums[0]), ['album', 'albumArtist', 'release', 'date', 'image', 'addedAt']);
});

test('a limit narrows it, and the ceiling and the junk are refused', async (t) => {
    const { port, bridge } = await serverFor(t);
    addedStream(bridge, 150);
    assert.equal((await api(port, '/api/library/recent?limit=5')).body.albums.length, 5);
    // An absent or empty limit is the default, not an error.
    assert.equal((await api(port, '/api/library/recent?limit=')).body.albums.length, 100);
    for (const bad of ['0', '-1', '2.5', '5x', 'abc', '501']) {
        const res = await api(port, `/api/library/recent?limit=${bad}`);
        assert.equal(res.status, 400, `limit=${bad}`);
    }
});

test('a library with fewer albums than the limit answers with what there is', async (t) => {
    const { port, bridge } = await serverFor(t);
    addedStream(bridge, 3);
    assert.equal((await api(port, '/api/library/recent')).body.albums.length, 3);
});

test('recently added answers 503 when MPD cannot be asked', async (t) => {
    const { port } = await serverFor(t); // the dead bridge
    const res = await api(port, '/api/library/recent');
    assert.equal(res.status, 503);
});

// ---------------------------------------------------------------------------
// Recent plays.
// ---------------------------------------------------------------------------

function memoryPlays(): Plays {
    let clock = 1000;
    return createPlays(openDb({ path: ':memory:' }), () => clock++);
}

function played(albumArtist: string, album: string, track: string): TrackPlay {
    return {
        file: `${albumArtist}/${album}/${track}.flac`,
        title: `Track ${track}`,
        artist: albumArtist,
        album,
        albumArtist,
        release: releaseFor(albumArtist, album),
        image: '/api/art?album=x',
    };
}

test('recent plays are empty until something has been played', async (t) => {
    const { port } = await serverFor(t, { plays: memoryPlays() });
    const res = await api(port, '/api/plays/recent');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.albums, []);
});

test('an album that was played comes back, newest first', async (t) => {
    const plays = memoryPlays();
    const { port } = await serverFor(t, { plays });
    plays.record(played('Tool', 'Ænima', '01'));
    plays.record(played('Pixies', 'Doolittle', '01'));
    const res = await api(port, '/api/plays/recent');
    assert.deepEqual(
        res.body.albums.map((a: { album: string }) => a.album),
        ['Doolittle', 'Ænima'],
    );
});

test('recent plays honours limit, and refuses one that is not a whole number', async (t) => {
    const plays = memoryPlays();
    const { port } = await serverFor(t, { plays });
    for (let i = 0; i < 5; i++) plays.record(played('Artist', `Album ${i}`, '01'));
    assert.equal((await api(port, '/api/plays/recent?limit=2')).body.albums.length, 2);
    assert.equal((await api(port, '/api/plays/recent?limit=5x')).status, 400);
    assert.equal((await api(port, '/api/plays/recent?limit=2.5')).status, 400);
    assert.equal((await api(port, '/api/plays/recent?limit=0')).status, 400);
    assert.equal((await api(port, `/api/plays/recent?limit=${RECENT_PLAYS_MAX + 1}`)).status, 400);
    // Empty is "not given", as it is for recently added.
    assert.equal((await api(port, '/api/plays/recent?limit=')).status, 200);
});

test('recent plays answer 503 with no store behind them', async (t) => {
    const { port } = await serverFor(t);
    assert.equal((await api(port, '/api/plays/recent')).status, 503);
});

test('the stream carries recent plays on connect and again when one is recorded', async (t) => {
    const plays = memoryPlays();
    const { port } = await serverFor(t, { plays });
    plays.record(played('Tool', 'Ænima', '01'));
    const stream = await streamFor(t, port);
    assert.ok(stream.text().includes('event: plays'), 'no plays frame on connect');
    assert.ok(stream.text().includes('Ænima'));

    plays.record(played('Pixies', 'Doolittle', '01'));
    await settle();
    assert.equal(stream.text().split('event: plays').length - 1, 2);
    assert.ok(stream.text().includes('Doolittle'));
});

test('a closed stream stops being written to', async (t) => {
    const plays = memoryPlays();
    const { port } = await serverFor(t, { plays });
    const stream = await streamFor(t, port);
    const before = stream.text().length;
    stream.destroy();
    await settle();
    plays.record(played('Tool', 'Ænima', '01'));
    await settle();
    assert.equal(stream.text().length, before);
});

test('most played artists are empty until something has been played', async (t) => {
    const { port } = await serverFor(t, { plays: memoryPlays() });
    const res = await api(port, '/api/plays/artists');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.artists, []);
});

test('artists come back most played first, with their picture', async (t) => {
    const plays = memoryPlays();
    const { port } = await serverFor(t, { plays });
    plays.record(played('Tool', 'Ænima', '01'));
    plays.record(played('Pixies', 'Doolittle', '01'));
    plays.record(played('Pixies', 'Doolittle', '02'));
    const res = await api(port, '/api/plays/artists');
    assert.deepEqual(res.body.artists, [
        { name: 'Pixies', image: '/api/art?album=Pixies', plays: 2 },
        { name: 'Tool', image: '/api/art?album=Tool', plays: 1 },
    ]);
});

test('most played artists honours limit, and refuses one that is not a whole number', async (t) => {
    const plays = memoryPlays();
    const { port } = await serverFor(t, { plays });
    for (let i = 0; i < 5; i++) plays.record(played(`Artist ${i}`, 'Album', '01'));
    assert.equal((await api(port, '/api/plays/artists?limit=2')).body.artists.length, 2);
    assert.equal((await api(port, '/api/plays/artists?limit=5x')).status, 400);
    assert.equal((await api(port, '/api/plays/artists?limit=2.5')).status, 400);
    assert.equal((await api(port, '/api/plays/artists?limit=0')).status, 400);
    assert.equal(
        (await api(port, `/api/plays/artists?limit=${MOST_PLAYED_ARTISTS_MAX + 1}`)).status,
        400,
    );
    // Empty is "not given", as it is for recently added.
    assert.equal((await api(port, '/api/plays/artists?limit=')).status, 200);
});

test('most played artists answer 503 with no store behind them', async (t) => {
    const { port } = await serverFor(t);
    assert.equal((await api(port, '/api/plays/artists')).status, 503);
});

test('the artists list is fetched, never pushed on the stream', async (t) => {
    // An all-time count does not reorder on one play, so it is deliberately not
    // a frame. See api.ts.
    const plays = memoryPlays();
    const { port } = await serverFor(t, { plays });
    const stream = await streamFor(t, port);
    plays.record(played('Tool', 'Ænima', '01'));
    await settle();
    assert.ok(!stream.text().includes('event: artists'));
});

test('the most played artists route is the last route in the file', () => {
    // Same reason as the assertions above: three tests slice this file's source
    // between route literals, so new routes go at the end.
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    assert.ok(src.indexOf("app.post('/api/restore'") < src.indexOf("app.get('/api/library/recent'"));
    assert.ok(src.indexOf("app.get('/api/library/recent'") < src.indexOf("app.get('/api/plays/recent'"));
    assert.ok(src.indexOf("app.get('/api/plays/recent'") < src.indexOf("app.get('/api/plays/artists'"));
});

test('the CD routes refuse when there is no disc', async () => {
    const { app, routes, port } = await startServer();
    try {
        for (const verb of ['play', 'eject']) {
            const res = await fetch(`http://127.0.0.1:${port}/api/cd/${verb}`, { method: 'POST' });
            assert.equal(res.status, 409, verb);
            assert.match(((await res.json()) as { error: string }).error, /no audio CD/);
        }
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

test('playing a disc reaches MPD, and says so when MPD is down', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        await bridge.setCd(discFromState({ tracks: 4 }, false));
        const res = await fetch(`http://127.0.0.1:${port}/api/cd/play`, { method: 'POST' });
        assert.equal(res.status, 503);
        assert.match(((await res.json()) as { error: string }).error, /MPD is not connected/);
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

test('playing a disc is allowed while a phone owns the DAC', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        await bridge.setBluetooth(PHONE);
        await bridge.setCd(discFromState({ tracks: 4 }, false));
        const res = await fetch(`http://127.0.0.1:${port}/api/cd/play`, { method: 'POST' });
        // MPD's error, not a 409: the request got past the source check.
        assert.equal(res.status, 503);
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

test('eject reaches the helper, and reports honestly when it cannot', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        await bridge.setCd(discFromState({ tracks: 4 }, false));
        const res = await fetch(`http://127.0.0.1:${port}/api/cd/eject`, { method: 'POST' });
        assert.equal(res.status, 503);
        assert.match(((await res.json()) as { error: string }).error, /CD helper is not running/);
    } finally {
        routes.closeStreams();
        await app.close();
    }
});

test('eject writes one verb into the FIFO and answers 202', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-routes-'));
    try {
        const fifo = join(dir, 'control');
        await new Promise<void>((resolve, reject) => {
            execFile('mkfifo', [fifo], (e) => (e ? reject(e) : resolve()));
        });
        const reader = await fsOpen(fifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
        const { app, bridge, routes, port } = await startServer({ cdControl: fifo });
        try {
            await bridge.setCd(discFromState({ tracks: 4 }, false));
            const res = await fetch(`http://127.0.0.1:${port}/api/cd/eject`, { method: 'POST' });
            assert.equal(res.status, 202);
            assert.deepEqual(await res.json(), { accepted: 'eject' });
            const buf = Buffer.alloc(32);
            const { bytesRead } = await reader.read(buf, 0, buf.length, null);
            assert.equal(buf.subarray(0, bytesRead).toString('utf8'), 'eject\n');
        } finally {
            routes.closeStreams();
            await app.close();
            await reader.close();
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a CD cover is served from the cache, and only for a release ID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-cdart-'));
    const id = '8d0bc6d4-8700-44e8-90c8-b86c23e7ff14';
    try {
        const { app, routes, port } = await startServer({ cdArtDir: dir });
        try {
            const bad = await fetch(`http://127.0.0.1:${port}/api/cd/art?release=..%2F..%2Fetc%2Fpasswd`);
            assert.equal(bad.status, 400);
            assert.equal((await fetch(`http://127.0.0.1:${port}/api/cd/art?release=${id}`)).status, 404);
            await writeFile(join(dir, `${id}.jpg`), Buffer.from([0xff, 0xd8, 0xff]));
            const ok = await fetch(`http://127.0.0.1:${port}/api/cd/art?release=${id}`);
            assert.equal(ok.status, 200);
            assert.equal(ok.headers.get('content-type'), 'image/jpeg');
        } finally {
            routes.closeStreams();
            await app.close();
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a built thumbnail is served with an etag; an unbuilt one is a 404 nobody caches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-thumbs-'));
    const album = 'Radiohead/OK Computer (1997)';
    const id = '8d0bc6d4-8700-44e8-90c8-b86c23e7ff14';
    try {
        const { app, routes, port } = await startServer({ thumbDir: dir });
        const url = (path: string) => `http://127.0.0.1:${port}${path}`;
        try {
            assert.equal((await fetch(url('/api/art/thumb'))).status, 400);
            assert.equal((await fetch(url('/api/cd/art/thumb?release=..%2Fx'))).status, 400);

            const missing = await fetch(url(`/api/art/thumb?album=${encodeURIComponent(album)}`));
            assert.equal(missing.status, 404);
            assert.equal(missing.headers.get('cache-control'), 'no-store');
            assert.deepEqual(await missing.json(), { error: 'no thumbnail yet' });

            await writeFile(join(dir, `${thumbName('album', album)}.jpg`), 'SMALL JPEG');
            const ok = await fetch(url(`/api/art/thumb?album=${encodeURIComponent(album)}`));
            assert.equal(ok.status, 200);
            assert.equal(ok.headers.get('content-type'), 'image/jpeg');
            assert.match(ok.headers.get('cache-control') ?? '', /max-age=\d{5,}/);
            assert.equal(await ok.text(), 'SMALL JPEG');
            const etag = ok.headers.get('etag')!;
            const again = await fetch(url(`/api/art/thumb?album=${encodeURIComponent(album)}`), {
                headers: { 'if-none-match': etag },
            });
            assert.equal(again.status, 304);

            await writeFile(join(dir, `${thumbName('release', id)}.jpg`), 'CD JPEG');
            const cd = await fetch(url(`/api/cd/art/thumb?release=${id}`));
            assert.equal(cd.status, 200);
            assert.equal(await cd.text(), 'CD JPEG');
        } finally {
            routes.closeStreams();
            await app.close();
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('system status is 503 without a reader, and its answer with one', async () => {
    const status = {
        uptimeSeconds: 60, cpuPercent: 5, load: [0.1, 0.2, 0.3] as [number, number, number],
        memory: null, disk: null, temperatures: [], underVoltage: null,
        thumbnails: { state: 'never' as const, scope: null, progress: null, total: null,
            startedAt: null, finishedAt: null, built: null, failed: null },
        metadata: null,
    };
    for (const [reader, code] of [[undefined, 503], [{ read: async () => status }, 200]] as const) {
        const { app, routes, port } = await startServer({ systemStatus: reader });
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/system/status`);
            assert.equal(res.status, code);
            if (code === 200) assert.deepEqual(await res.json(), status);
        } finally {
            routes.closeStreams();
            await app.close();
        }
    }
});

test('a track is queued by plain add, or inserted after the current one', () => {
    const playing = { queueLength: 5, queuePosition: 2 };
    assert.deepEqual(trackAddCommands('a/1.flac', false, playing), ['add "a/1.flac"']);
    assert.deepEqual(trackAddCommands('a/1.flac', true, playing), ['add "a/1.flac" "+0"']);
    // Stopped with no current song: `play` would start from the top.
    const noSong = { queueLength: 5, queuePosition: null };
    assert.deepEqual(trackAddCommands('a/1.flac', true, noSong), ['add "a/1.flac" "0"']);
    assert.deepEqual(trackAddCommands('a/1.flac', false, noSong), ['add "a/1.flac"']);
});

test('a track added to an empty queue starts playing, whichever button', () => {
    const empty = { queueLength: 0, queuePosition: null };
    for (const next of [false, true]) {
        assert.deepEqual(trackAddCommands('a/"b".flac', next, empty), ['add "a/\\"b\\".flac"', 'play']);
    }
});

test('an album plays next by findadd at a position, and into an empty queue it plays', () => {
    const findadd = 'findadd "MUSICBRAINZ_ALBUMID" "x"';
    assert.deepEqual(albumNextCommands(findadd, { queueLength: 5, queuePosition: 2 }), [`${findadd} position "+0"`]);
    assert.deepEqual(albumNextCommands(findadd, { queueLength: 5, queuePosition: null }), [`${findadd} position "0"`]);
    assert.deepEqual(albumNextCommands(findadd, { queueLength: 0, queuePosition: null }), [findadd, 'play']);
});

test('queueing a track is refused while a phone owns the DAC', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        await bridge.setBluetooth(PHONE);
        for (const path of ['/api/library/track/queue', '/api/library/track/next']) {
            const res = await fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ file: 'Radiohead/Kid A/01.flac' }),
            });
            assert.equal(res.status, 409, path);
        }
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('a track reference must be a library path before it can reach a command line', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        const bodies: unknown[] = [
            {},
            { file: '' },
            { file: 1 },
            { file: ['a.flac'] },
            { file: { toString: () => 'a.flac' } },
            { file: 'http://example.com/stream.mp3' },
            { file: 'file:///etc/passwd' },
            { file: '/etc/passwd' },
        ];
        for (const body of bodies) {
            for (const path of ['/api/library/track/queue', '/api/library/track/next']) {
                const res = await fetch(`http://127.0.0.1:${port}${path}`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                });
                assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
            }
        }
        // A valid path passes validation and gets as far as the (absent) MPD.
        for (const path of ['/api/library/track/queue', '/api/library/track/next']) {
            const res = await fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ file: 'Radiohead/Kid A/01.flac' }),
            });
            assert.equal(res.status, 503, path);
        }
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('playlist names are validated before anything reaches MPD', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        const post = (path: string, body: unknown) =>
            fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        for (const name of [undefined, '', 1, 'a/b', '.x', 'a\nb', ['x']]) {
            const label = JSON.stringify(name);
            assert.equal((await post('/api/playlists', { name })).status, 400, `create ${label}`);
            assert.equal((await post('/api/playlist/play', { name })).status, 400, `play ${label}`);
            assert.equal((await post('/api/playlist/queue', { name })).status, 400, `queue ${label}`);
            assert.equal((await post('/api/playlist/rename', { from: 'ok', to: name })).status, 400, `rename ${label}`);
            assert.equal((await post('/api/playlist/rename', { from: name, to: 'ok' })).status, 400, `rename ${label}`);
        }
        for (const query of ['', '?name=', '?name=a%2Fb']) {
            assert.equal((await fetch(`http://127.0.0.1:${port}/api/playlist${query}`)).status, 400, query);
            const del = await fetch(`http://127.0.0.1:${port}/api/playlist${query}`, { method: 'DELETE' });
            assert.equal(del.status, 400, `delete ${query}`);
        }
        // A good name gets as far as the (absent) MPD.
        assert.equal((await post('/api/playlists', { name: 'Road trip' })).status, 503);
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/playlists`)).status, 503);
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('playing or queueing a playlist is refused while a phone owns the DAC', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        await bridge.setBluetooth(PHONE);
        for (const path of ['/api/playlist/play', '/api/playlist/queue']) {
            const res = await fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'Road trip' }),
            });
            assert.equal(res.status, 409, path);
        }
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('playing a playlist clears the queue first, and queueing one does not', () => {
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    const handler = src.slice(src.indexOf("['/api/playlist/play', true]"), src.indexOf('Append an album to the queue'));
    assert.match(handler, /replace \? \['clear', load, 'play'\] : \[load\]/);
});

test('adding a track to a playlist validates both fields, and is allowed under Bluetooth', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        const post = (body: unknown) =>
            fetch(`http://127.0.0.1:${port}/api/playlist/add`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        for (const body of [
            {},
            { name: 'Mix' },
            { file: 'a/1.flac' },
            { name: 'a/b', file: 'a/1.flac' },
            { name: 'Mix', file: 'http://x/y.mp3' },
            { name: 'Mix', file: '/etc/passwd' },
        ]) {
            assert.equal((await post(body)).status, 400, JSON.stringify(body));
        }
        await bridge.setBluetooth(PHONE);
        // Past validation and the source check, as far as the absent MPD.
        assert.equal((await post({ name: 'Mix', file: 'a/1.flac' })).status, 503);
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test("an album's start track is held to the same rule as any track", async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        const album = { albumArtist: 'Radiohead', album: 'Kid A', release: 'mb:kid-a' };
        for (const start of ['', 1, 'http://x/y.mp3', '/etc/passwd']) {
            const res = await fetch(`http://127.0.0.1:${port}/api/library/play`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ...album, start }),
            });
            assert.equal(res.status, 400, JSON.stringify(start));
        }
        const res = await fetch(`http://127.0.0.1:${port}/api/library/play`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...album, start: 'Radiohead/Kid A/03.flac' }),
        });
        assert.equal(res.status, 503);
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('playing an album from a track jumps to it by song id, not by position', () => {
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    const play = src.slice(src.indexOf("app.post('/api/library/play'"), src.indexOf("app.get('/api/events'"));
    assert.match(play, /runAll\(\['clear', findaddFor\(ref\)\]\);\s*const id = await bridge\.queueIdOf\(start\);/);
    assert.match(play, /playid \$\{id\}/);
});

test('saving the queue validates the name and is refused while a phone owns the DAC', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        const paths = ['/api/queue/save', '/api/queue/save/append', '/api/queue/save/replace'];
        const post = (path: string, body: unknown) =>
            fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        for (const path of paths) {
            for (const name of [undefined, '', 'a/b', 1]) {
                assert.equal((await post(path, { name })).status, 400, `${path} ${JSON.stringify(name)}`);
            }
            assert.equal((await post(path, { name: 'Mix' })).status, 503, `${path} reaches MPD`);
        }
        await bridge.setBluetooth(PHONE);
        for (const path of paths) assert.equal((await post(path, { name: 'Mix' })).status, 409, path);
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('saving the queue leaves out disc tracks', () => {
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    const save = src.slice(src.indexOf("['/api/queue/save', 'create']"), src.indexOf("['/api/playlist/play', true]"));
    assert.match(save, /tracks\.filter\(\(t\) => !isCdTrack\(t\)/);
});

test('adding an album to a playlist validates the name and the album, and is allowed under Bluetooth', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        const post = (body: unknown) =>
            fetch(`http://127.0.0.1:${port}/api/playlist/add-album`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        const album = { albumArtist: 'Radiohead', album: 'Kid A', release: 'mb:kid-a' };
        assert.equal((await post({ ...album, name: 'a/b' })).status, 400);
        assert.equal((await post({ name: 'Mix', albumArtist: 'Radiohead', album: 'Kid A' })).status, 400);
        assert.equal((await post({ ...album, name: 'Mix', disc: 2 })).status, 400);
        await bridge.setBluetooth(PHONE);
        assert.equal((await post({ ...album, name: 'Mix' })).status, 503, 'a good request reaches MPD');
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('moving and removing playlist tracks validate positions and the file', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        const post = (path: string, body: unknown) =>
            fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        const ok = { name: 'Mix', file: 'a/1.flac' };
        for (const bad of [-1, 1.5, '1', null]) {
            assert.equal((await post('/api/playlist/move', { ...ok, from: bad, to: 0 })).status, 400, `from ${bad}`);
            assert.equal((await post('/api/playlist/move', { ...ok, from: 0, to: bad })).status, 400, `to ${bad}`);
            assert.equal((await post('/api/playlist/remove', { ...ok, pos: bad })).status, 400, `pos ${bad}`);
            assert.equal((await post('/api/playlist/add', { ...ok, pos: bad })).status, 400, `add pos ${bad}`);
        }
        assert.equal((await post('/api/playlist/remove', { name: 'Mix', pos: 0, file: 'http://x' })).status, 400);
        assert.equal((await post('/api/playlist/move', { name: 'a/b', from: 0, to: 1, file: 'a' })).status, 400);
        assert.equal((await post('/api/playlist/shuffle', { name: 'a/b' })).status, 400);
        // Valid, and not refused under Bluetooth: they touch no queue.
        await bridge.setBluetooth(PHONE);
        assert.equal((await post('/api/playlist/move', { ...ok, from: 0, to: 1 })).status, 503);
        assert.equal((await post('/api/playlist/remove', { ...ok, pos: 0 })).status, 503);
        assert.equal((await post('/api/playlist/shuffle', { name: 'Mix' })).status, 503);
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('removing a queue track takes a song id, digits only, and is refused under Bluetooth', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        const post = (id: string) => fetch(`http://127.0.0.1:${port}/api/queue/remove/${id}`, { method: 'POST' });
        for (const bad of ['x', '1e2', '0x10', '-1', '1.5']) assert.equal((await post(bad)).status, 400, bad);
        assert.equal((await post('42')).status, 503, 'a good id reaches MPD');
        await bridge.setBluetooth(PHONE);
        assert.equal((await post('42')).status, 409);
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('removing a queue track deletes by id, never by position', () => {
    const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    const handler = src.slice(src.indexOf("app.post('/api/queue/remove/:id'"), src.indexOf("app.post('/api/playback/:command'"));
    assert.match(handler, /deleteid \$\{Number\(id\)\}/);
    assert.doesNotMatch(handler, /\bdelete \$/);
});

test('search answers with ranked groups from the indexes', async (t) => {
    const { port, bridge } = await serverFor(t);
    // Just enough of MPD for both indexes to build.
    bridge.list = async (tag: string) =>
        tag === 'title'
            ? { pairs: [['AlbumArtist', 'Radiohead'], ['Album', 'Kid A'], ['Title', 'Idioteque']] }
            : { pairs: [['MUSICBRAINZ_ALBUMID', 'kid-a'], ['AlbumArtist', 'Radiohead'], ['Album', 'Kid A']] };
    bridge.count = async () => ({ pairs: [] });
    bridge.lsinfo = async () => ({ pairs: [] });
    bridge.findFirstSong = async () => song('Radiohead', 'Kid A', '1');
    const res = await api(port, '/api/library/search?q=kid%20a');
    assert.equal(res.status, 200);
    const body = res.body as SearchResponse;
    assert.equal(body.query, 'kid a');
    assert.deepEqual(body.groups.map((g) => g.kind), ['album']);
    assert.equal(body.groups[0].items.length, 1);
});

test('an album carries its Wikipedia intro and its listen counts by file', async (t) => {
    const info: InfoLookup = {
        artist: () => null,
        album: (mbid) => (mbid === 'rg-one' ? { about: 'One is an album.', aboutUrl: 'https://en.wikipedia.org/wiki/One' } : null),
        listens: (ids) => new Map(ids.filter((id) => id === 'rec-1').map((id) => [id, 42])),
    };
    const { port, bridge } = await serverFor(t, { info });
    const tracks = [song('A', 'One', '1'), song('A', 'One', '2')];
    tracks[0]!.mbReleaseGroupId = 'rg-one';
    tracks[0]!.mbRecordingId = 'rec-1';
    tracks[1]!.mbRecordingId = 'rec-2';
    stockLibrary(bridge, tracks);
    const res = await api(port, '/api/library/album?artist=A&album=One&release=mb:A/One');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.about, { text: 'One is an album.', url: 'https://en.wikipedia.org/wiki/One' });
    assert.deepEqual(res.body.listens, { 'A/One/1.flac': 42 });
});

test('without a harvest an album still answers, with no intro and no counts', async (t) => {
    const { port, bridge } = await serverFor(t);
    stockLibrary(bridge, [song('A', 'One', '1')]);
    const res = await api(port, '/api/library/album?artist=A&album=One&release=mb:A/One');
    assert.equal(res.body.about, null);
    assert.deepEqual(res.body.listens, {});
});

test('a list of tracks plays or queues in one batch, and is validated like a single track', async () => {
    const { app, bridge, routes, port } = await startServer();
    try {
        const post = (path: string, body: unknown) =>
            fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        const ran: string[][] = [];
        bridge.runAll = async (commands: string[]) => {
            ran.push(commands);
        };
        const files = ['Tool/Lateralus/02.flac', 'Tool/Ænima/04.flac'];

        assert.equal((await post('/api/library/tracks/play', { files })).status, 200);
        assert.deepEqual(ran.pop(), ['clear', 'add "Tool/Lateralus/02.flac"', 'add "Tool/Ænima/04.flac"', 'play']);
        // The dead bridge's queue is empty, so queueing starts playback.
        assert.equal((await post('/api/library/tracks/queue', { files })).status, 200);
        assert.deepEqual(ran.pop(), ['add "Tool/Lateralus/02.flac"', 'add "Tool/Ænima/04.flac"', 'play']);

        for (const body of [{}, { files: [] }, { files: 'a.flac' }, { files: ['ok.flac', '/etc/passwd'] },
            { files: Array.from({ length: MAX_TRACKS + 1 }, (_, i) => `${i}.flac`) }]) {
            for (const path of ['/api/library/tracks/play', '/api/library/tracks/queue', '/api/playlist/add-tracks']) {
                assert.equal((await post(path, { name: 'Mix', ...body })).status, 400, `${path} ${JSON.stringify(body).slice(0, 40)}`);
            }
        }
        assert.equal(ran.length, 0);

        await bridge.setBluetooth(PHONE);
        for (const path of ['/api/library/tracks/play', '/api/library/tracks/queue']) {
            assert.equal((await post(path, { files })).status, 409, path);
        }
        // A playlist touches no queue, so it is allowed; the dead MPD answers.
        assert.equal((await post('/api/playlist/add-tracks', { name: 'Mix', files })).status, 503);
        assert.equal((await post('/api/playlist/add-tracks', { name: 'a/b', files })).status, 400);
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});

test('the generator offers its options, counts matches, and plays a length of them', async () => {
    const plays = memoryPlays();
    plays.record(played('Tool', 'Ænima', '1'));
    const { app, bridge, routes, port } = await startServer({ plays });
    try {
        const post = (path: string, body: unknown) =>
            fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        const library = [song('Tool', 'Ænima', '1', '1996'), song('Tool', 'Ænima', '2', '1996'), song('Low', 'Things', '1', '2005')];
        bridge.songsWindow = async (offset: number) => (offset === 0 ? library : []);
        const ran: string[][] = [];
        bridge.runAll = async (commands: string[]) => {
            ran.push(commands);
        };

        const options = await (await fetch(`http://127.0.0.1:${port}/api/generator/options`)).json();
        assert.deepEqual(options, { genres: [{ name: 'Rock', tracks: 3 }], years: { min: 1996, max: 2005 } });

        const count = await post('/api/generator/count', { filters: { lists: ['unplayed-tracks'] } });
        assert.deepEqual(await count.json(), { count: 2 });

        const filters = { years: { min: 1990, max: 1999 }, lists: ['unplayed-tracks'] };
        assert.equal((await post('/api/generator/play', { filters, length: 25 })).status, 200);
        assert.deepEqual(ran.pop(), ['clear', 'add "Tool/Ænima/2.flac"', 'play']);

        assert.equal((await post('/api/generator/play', { filters: { artists: ['Nobody'] }, length: 25 })).status, 400);
        assert.equal((await post('/api/generator/play', { filters: {}, length: 0 })).status, 400);
        assert.equal((await post('/api/generator/count', { filters: { lists: ['bogus'] } })).status, 400);
        assert.equal(ran.length, 0);

        await bridge.setBluetooth(PHONE);
        assert.equal((await post('/api/generator/play', { filters: {}, length: 25 })).status, 409);
    } finally {
        bridge.stop();
        routes.closeStreams();
        await app.close();
    }
});
