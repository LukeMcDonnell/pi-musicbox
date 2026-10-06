import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { thumbUriFor } from '../../shared/api.ts';
import { THUMBS_COMPLETE_MARKER, THUMBS_STATUS_FILE, createThumbRequests, parseThumbStatus, thumbName } from './thumbs.ts';

const ID = '8d0bc6d4-8700-44e8-90c8-b86c23e7ff14';

test('thumbUriFor maps both cover endpoints, with or without an origin', () => {
    assert.equal(thumbUriFor('/api/art?album=A%2FB'), '/api/art/thumb?album=A%2FB');
    assert.equal(thumbUriFor(`/api/cd/art?release=${ID}`), `/api/cd/art/thumb?release=${ID}`);
    assert.equal(thumbUriFor('http://musicbox.local/api/art?album=X'), 'http://musicbox.local/api/art/thumb?album=X');
    assert.equal(thumbUriFor('/api/other?u=/api/art?x'), null);
    assert.equal(thumbUriFor('/somewhere/else.jpg'), null);
});

// The same values are pinned in tests/test-server-config.sh against the helper's
// `printf '%s:%s' kind key | sha1sum`: the helper writes these names, the server reads them.
test('thumbName agrees with the helper, byte for byte', () => {
    assert.equal(thumbName('album', 'Radiohead/OK Computer (1997)'), '0631821edeb32cb920ab2a8f89507ea4fc0824e5');
    assert.equal(thumbName('release', ID), '38075632807adfad84ebd6380904d66f5e79ffca');
    assert.equal(thumbName('album', ''), '34a12cf31a4607c06c44a6a16b5ca71c73f512a5');
});

test('a request is an empty file named for what is asked; no helper is not an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-thumbreq-'));
    try {
        const requests = createThumbRequests(dir, join(dir, 'thumbs'));
        await requests.request('library');
        await requests.request('cd');
        assert.deepEqual((await readdir(dir)).sort(), ['cd', 'library']);
        await createThumbRequests(join(dir, 'absent'), dir).request('library');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('built() follows the marker the helper writes after a full pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-thumbs-'));
    try {
        const requests = createThumbRequests(join(dir, 'req'), dir);
        assert.equal(await requests.built(), false);
        await writeFile(join(dir, THUMBS_COMPLETE_MARKER), '');
        assert.equal(await requests.built(), true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// The lines are pinned in tests/test-server-config.sh against the helper that writes them.
test('parseThumbStatus reads the helper, and a running pass whose process is gone was interrupted', () => {
    assert.deepEqual(parseThumbStatus('running 42 1700000000 150 3812 library\n', () => true), {
        state: 'running', scope: 'library', progress: 150, total: 3812,
        startedAt: 1_700_000_000_000, finishedAt: null, built: null, failed: null,
    });
    assert.equal(parseThumbStatus('running 42 1700000000 150 3812 library', () => false)?.state, 'interrupted');
    assert.deepEqual(parseThumbStatus('idle 1700000100 3 10 2 1 cd', () => false), {
        state: 'done', scope: 'cd', progress: null, total: null,
        startedAt: null, finishedAt: 1_700_000_100_000, built: 3, failed: 1,
    });
    assert.equal(parseThumbStatus('running 42', () => true), null);
    assert.equal(parseThumbStatus('', () => true), null);
});

test('status() falls back to the completion marker, then to never', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-thumbs-'));
    try {
        const req = join(dir, 'req');
        await mkdir(req);
        const requests = createThumbRequests(req, dir);
        assert.equal((await requests.status()).state, 'never');
        await writeFile(join(dir, THUMBS_COMPLETE_MARKER), '');
        assert.equal((await requests.status()).state, 'done');
        await writeFile(join(req, THUMBS_STATUS_FILE), `running ${process.pid} 1700000000 1 2 library\n`);
        assert.equal((await requests.status()).state, 'running');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
