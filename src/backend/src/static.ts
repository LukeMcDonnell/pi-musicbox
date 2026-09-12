/**
 * Static file serving for the Angular build.
 *
 * Hand-rolled rather than using @fastify/static, for three reasons: it keeps the
 * runtime dependency list at exactly one package, it avoids the dynamic requires
 * that make some middleware awkward to bundle into a single file, and it gives
 * exact control over caching — which matters because Angular content-hashes its
 * filenames, so the right policy is genuinely different per file.
 *
 * CACHING
 *   index.html      no-cache — it names the hashed bundles, so a stale copy
 *                   pins the browser to an old build forever
 *   hashed assets   immutable, one year — the hash IS the version
 *   everything else one hour
 *
 * SPA FALLBACK
 *   Unknown paths that are not /api and not obviously a file return index.html,
 *   so Angular's router owns client-side routes on a hard refresh.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
};

/** Angular emits main-A1B2C3D4.js; an 8+ char hash before the extension. */
const HASHED = /-[A-Z0-9]{8,}\.[a-z0-9]+$/i;

export function contentTypeFor(path: string): string {
    return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export function cacheControlFor(path: string): string {
    if (path.endsWith('index.html')) return 'no-cache';
    if (HASHED.test(path)) return 'public, max-age=31536000, immutable';
    return 'public, max-age=3600';
}

/**
 * Resolve a URL path inside root, refusing anything that escapes it.
 * Returns null when the request tries to traverse out.
 */
export function safeJoin(root: string, urlPath: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(urlPath);
    } catch {
        return null;
    }
    if (decoded.includes('\0')) return null;
    const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
    const full = resolve(join(root, rel));
    const rootResolved = resolve(root);
    if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null;
    return full;
}

async function sendFile(reply: FastifyReply, path: string): Promise<boolean> {
    try {
        const info = await stat(path);
        if (!info.isFile()) return false;
        reply
            .header('content-type', contentTypeFor(path))
            .header('cache-control', cacheControlFor(path))
            .header('content-length', String(info.size));
        await reply.send(createReadStream(path));
        return true;
    } catch {
        return false;
    }
}

export function registerStatic(app: FastifyInstance, webRoot: string): void {
    app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
        const urlPath = request.url.split('?')[0];

        // The API owns its own 404s; never hand it an HTML page.
        if (urlPath.startsWith('/api/')) {
            return reply.code(404).send({ error: 'not found' });
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return reply.code(405).send({ error: 'method not allowed' });
        }

        const candidate = safeJoin(webRoot, urlPath === '/' ? '/index.html' : urlPath);
        if (candidate && (await sendFile(reply, candidate))) return reply;

        // SPA fallback, so Angular routes survive a hard refresh.
        const index = safeJoin(webRoot, '/index.html');
        if (index && (await sendFile(reply, index))) return reply;

        return reply
            .code(404)
            .type('text/plain; charset=utf-8')
            .send(
                'musicbox: no frontend build found.\n' +
                    `Looked in ${webRoot}.\n` +
                    'Deploy one with tools/dev-push.sh\n',
            );
    });
}
