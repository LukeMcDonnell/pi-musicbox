/**
 * CORS: /api is open to any origin, static files are not.
 *
 * The wildcard is a deliberate choice (see cors.ts) — these tests pin the shape
 * of it, and the SSE case below pins the part that can silently regress.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { request as httpRequest } from 'node:http';
import { registerCors } from './cors.ts';
import { registerStatic } from './static.ts';

/** Composed as production composes it: CORS, then a route, then static's 404. */
async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false, forceCloseConnections: true });
    registerCors(app);
    app.post('/api/playback/:command', async () => ({ ok: true }));
    registerStatic(app, '/nonexistent-web-root');
    await app.ready();
    return app;
}

test('any origin is allowed, with no origin enumerated', async () => {
    const app = await buildApp();
    for (const origin of ['http://localhost:4200', 'http://some-phone.local', undefined]) {
        const response = await app.inject({
            method: 'POST',
            url: '/api/playback/play',
            headers: origin ? { origin } : {},
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['access-control-allow-origin'], '*');
    }
    await app.close();
});

test('credentials are never allowed — a browser rejects that alongside *', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/playback/play' });
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
    await app.close();
});

test('the preflight is answered 204, not 405 by the static handler', async () => {
    const app = await buildApp();
    const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/playback/play',
        headers: {
            origin: 'http://localhost:4200',
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type',
        },
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], '*');
    // content-type on the POST is what makes a preflight happen in the first place.
    assert.match(String(response.headers['access-control-allow-headers']), /content-type/);
    assert.match(String(response.headers['access-control-allow-methods']), /POST/);
    // Favourites are PUT and DELETE, settings PATCH; a dev frontend on another origin needs all three.
    assert.match(String(response.headers['access-control-allow-methods']), /PUT.*PATCH.*DELETE/);
    await app.close();
});

test('static paths get no CORS header — they are same-origin by nature', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/index.html' });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    await app.close();
});

/**
 * The SSE case, over a real socket rather than inject.
 *
 * This is the route that matters most for a remote dev frontend — without the
 * header the EventSource never connects and the UI shows no state at all — and it
 * is the one route that can silently miss it: its handler calls
 * reply.raw.writeHead(), which throws away anything set through Fastify's reply.
 */
function streamHeaders(port: number): Promise<Record<string, string | string[] | undefined>> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            {
                host: '127.0.0.1',
                port,
                path: '/api/events',
                method: 'GET',
                headers: { origin: 'http://localhost:4200' },
            },
            (res) => {
                res.on('data', () => {});
                res.on('error', () => {});
                resolve(res.headers);
                req.destroy();
            },
        );
        req.on('error', reject);
        req.end();
    });
}

test('an SSE stream carries the CORS header despite raw.writeHead', async () => {
    const app = Fastify({ logger: false, forceCloseConnections: true });
    registerCors(app);
    // Composed exactly as routes.ts does it: raw.writeHead takes over the socket.
    app.get('/api/events', async (_request, reply) => {
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        reply.raw.write(': keep-alive\n\n');
        return reply;
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const headers = await streamHeaders(address.port);
    assert.equal(headers['access-control-allow-origin'], '*');
    assert.equal(headers['content-type'], 'text/event-stream; charset=utf-8');

    await app.close();
});
