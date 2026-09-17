import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TarError, packTar, unpackTar } from './tar.ts';

const run = promisify(execFile);

test('a packed archive unpacks to the same files', () => {
    const entries = [
        { name: 'manifest.json', data: Buffer.from('{}') },
        { name: 'mpd/state', data: Buffer.from('state: pause\n') },
        { name: 'mpd/empty', data: Buffer.alloc(0) },
        { name: 'exactly-a-block', data: Buffer.alloc(512, 7) },
    ];
    assert.deepEqual(unpackTar(packTar(entries)), entries);
});

test('a long playlist name survives via the ustar prefix', () => {
    const name = `mpd/playlists/${'x'.repeat(95)}.m3u`;
    assert.deepEqual(unpackTar(packTar([{ name, data: Buffer.from('a') }]))[0]!.name, name);
});

test('tar(1) reads what this writes', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-tar-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(
        join(dir, 'a.tar'),
        packTar([{ name: 'mpd/playlists/Road trip.m3u', data: Buffer.from('song.flac\n') }]),
    );
    await run('tar', ['-xf', join(dir, 'a.tar'), '-C', dir]);
    assert.equal(await readFile(join(dir, 'mpd/playlists/Road trip.m3u'), 'utf8'), 'song.flac\n');
});

test('this reads what tar(1) writes, skipping directory entries', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-tar-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, 'src/mpd'), { recursive: true });
    await writeFile(join(dir, 'src/mpd/state'), 'hello');
    await run('tar', ['--format=ustar', '-cf', join(dir, 'b.tar'), '-C', join(dir, 'src'), '.']);
    const entries = unpackTar(await readFile(join(dir, 'b.tar')));
    assert.deepEqual(entries.map((e) => [e.name, e.data.toString()]), [['mpd/state', 'hello']]);
});

test('a symlink member is refused, not followed', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-tar-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, 'src'));
    await symlink('/etc/passwd', join(dir, 'src/musicbox.db'));
    await run('tar', ['--format=ustar', '-cf', join(dir, 'c.tar'), '-C', join(dir, 'src'), 'musicbox.db']);
    const archive = await readFile(join(dir, 'c.tar'));
    assert.throws(() => unpackTar(archive), /not a regular file/);
});

test('names that climb out or are absolute are refused', () => {
    for (const name of ['../etc/passwd', 'mpd/../../x', '/etc/passwd']) {
        const archive = packTar([{ name: 'placeholder', data: Buffer.from('x') }]);
        // Rewrite the name field, then fix the checksum so only the name is wrong.
        archive.fill(0, 0, 100);
        archive.write(name, 0);
        archive.fill(0x20, 148, 156);
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += archive[i]!;
        archive.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        assert.throws(() => unpackTar(archive), /unsafe member name/, name);
    }
});

test('a corrupted header fails its checksum', () => {
    const archive = packTar([{ name: 'mpd/state', data: Buffer.from('x') }]);
    archive[0] = 'n'.charCodeAt(0);
    assert.throws(() => unpackTar(archive), /checksum/);
});

test('a truncated archive is refused', () => {
    const archive = packTar([{ name: 'mpd/tag_cache', data: Buffer.alloc(4096, 1) }]);
    assert.throws(() => unpackTar(archive.subarray(0, 1024)), TarError);
});

test('random bytes are not an archive', () => {
    assert.throws(() => unpackTar(Buffer.alloc(1024, 0x41)), TarError);
});
