/**
 * Cross-origin access to /api: open to any origin.
 *
 * Hand-rolled for the same reason static.ts is — the runtime dependency list is
 * exactly one package, and @fastify/cors would double it for ~20 lines of header
 * setting.
 *
 * WHY THIS IS OPEN
 *   The frontend can be pointed at a different origin by setting apiUrl in
 *   src/frontend/src/environments/environment.development.ts — an `ng serve`
 *   session on :4200 driving the real box, say. Both fetch and EventSource are
 *   subject to the same-origin policy, and the playback POST sends
 *   content-type: application/json, which is not a CORS-safelisted value and so
 *   provokes a preflight. Without these headers the browser blocks the lot.
 *
 *   `*` rather than an allowlist is deliberate: no origin has to be enumerated
 *   ahead of time, so any dev machine, phone or port works untouched. The cost is
 *   that the API is open to any page loaded by any device on the LAN — it can
 *   read state and issue transport commands. There is no auth here either way;
 *   this is a music player on a home network, and the blast radius is skipping a
 *   track. Do not copy this to anything that matters.
 *
 * Static files get no CORS header: they are same-origin by nature, served by this
 * same process.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** What the frontend actually sends: JSON bodies on the playback POST. */
const ALLOWED_HEADERS = 'content-type';
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

/** True for the paths CORS applies to. */
function isApi(url: string): boolean {
    return url.split('?')[0].startsWith('/api/');
}

export function registerCors(app: FastifyInstance): void {
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!isApi(request.url)) return;

        // reply.raw.setHeader, NOT reply.header.
        //
        // /api/events is an SSE stream and its handler calls reply.raw.writeHead()
        // to take over the socket, which discards everything in Fastify's reply
        // header store — so a reply.header() here would reach every route EXCEPT
        // the stream, which is the one a remote dev frontend most needs. Node
        // merges setHeader() values into a later writeHead(), so setting it on the
        // raw response covers the streaming and the ordinary routes alike.
        //
        // No `vary: origin`: the response is the same whoever asks.
        // No access-control-allow-credentials: a browser refuses it alongside `*`,
        // and nothing here sends cookies.
        reply.raw.setHeader('access-control-allow-origin', '*');
    });

    // An explicit route rather than answering OPTIONS inside the hook: the
    // not-found handler in static.ts would otherwise turn a preflight into a 405,
    // and a route keeps the preflight visible in the route table.
    app.options('/api/*', async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply
            .header('access-control-allow-methods', ALLOWED_METHODS)
            .header('access-control-allow-headers', ALLOWED_HEADERS)
            .header('access-control-max-age', '600')
            .code(204)
            .send();
    });
}
