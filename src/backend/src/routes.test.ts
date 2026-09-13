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
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRoutes } from './routes.ts';
import { registerStatic } from './static.ts';
import { MpdBridge } from './mpd/bridge.ts';

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

async function startServer(opts: { forceCloseConnections?: boolean; musicRoot?: string } = {}) {
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
