/**
 * Static serving: path traversal and cache policy.
 *
 * The traversal cases matter because this server binds 0.0.0.0:80 on a LAN and
 * serves a directory out of a home folder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheControlFor, contentTypeFor, safeJoin } from './static.ts';

const ROOT = '/home/musicbox/musicbox/frontend';

test('normal paths resolve inside the root', () => {
    assert.equal(safeJoin(ROOT, '/index.html'), `${ROOT}/index.html`);
    assert.equal(safeJoin(ROOT, '/assets/logo.svg'), `${ROOT}/assets/logo.svg`);
});

test('traversal attempts are refused or clamped inside the root', () => {
    for (const attack of [
        '/../../../../etc/passwd',
        '/..%2f..%2f..%2fetc/passwd',
        '/assets/../../../../etc/shadow',
        '/....//....//etc/passwd',
    ]) {
        const resolved = safeJoin(ROOT, attack);
        if (resolved !== null) {
            assert.ok(
                resolved.startsWith(`${ROOT}/`) || resolved === ROOT,
                `escaped the root: ${attack} -> ${resolved}`,
            );
        }
    }
});

test('NUL bytes and bad encoding are refused outright', () => {
    assert.equal(safeJoin(ROOT, '/index.html\0.png'), null);
    assert.equal(safeJoin(ROOT, '/%ZZ'), null);
});

test('index.html is never cached — it names the hashed bundles', () => {
    assert.equal(cacheControlFor('/x/index.html'), 'no-cache');
});

test('content-hashed assets are immutable for a year', () => {
    assert.equal(
        cacheControlFor('/x/main-A1B2C3D4.js'),
        'public, max-age=31536000, immutable',
    );
    assert.equal(
        cacheControlFor('/x/styles-0F9E8D7C.css'),
        'public, max-age=31536000, immutable',
    );
});

test('unhashed assets get a modest cache lifetime', () => {
    assert.equal(cacheControlFor('/x/favicon.ico'), 'public, max-age=3600');
});

test('content types cover what Angular emits', () => {
    assert.equal(contentTypeFor('a.js'), 'text/javascript; charset=utf-8');
    assert.equal(contentTypeFor('a.css'), 'text/css; charset=utf-8');
    assert.equal(contentTypeFor('a.html'), 'text/html; charset=utf-8');
    assert.equal(contentTypeFor('a.woff2'), 'font/woff2');
    assert.equal(contentTypeFor('a.unknown'), 'application/octet-stream');
});
