import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BackupError } from './backup.ts';
import { cdArtBackupFilename, coverRelease, createCdArtBackups } from './cd-art-backup.ts';
import { packTar, unpackTar, type TarEntry } from './tar.ts';

const A = '11111111-2222-3333-4444-555555555555';
const B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function box(t: { after: (fn: () => unknown) => void }, covers: Record<string, string> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'musicbox-cd-art-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const artDir = join(root, 'cd-art');
    if (Object.keys(covers).length > 0) await mkdir(artDir);
    for (const [file, data] of Object.entries(covers)) await writeFile(join(artDir, file), data);
    const backups = createCdArtBackups({ artDir, build: 'test', now: () => 1_700_000_000_000 });
    return { root, artDir, backups };
}

function members(archive: Buffer): TarEntry[] {
    return unpackTar(gunzipSync(archive));
}

function repack(archive: Buffer, edit: (entries: TarEntry[]) => TarEntry[]): Buffer {
    return gzipSync(packTar(edit(members(archive))));
}

test('a cover backup holds a manifest and every cover, and nothing else', async (t) => {
    const { backups } = await box(t, {
        [`${A}.jpg`]: 'cover a',
        [`${B}.jpg`]: 'cover b',
        [`${B}.jpg.tmp`]: 'half written',
        'notes.txt': 'stray',
    });
    const { filename, archive } = await backups.create();
    assert.equal(filename, cdArtBackupFilename(1_700_000_000_000));
    assert.match(filename, /^musicbox-cd-covers-\d{8}-\d{4}\.tar\.gz$/);
    const entries = members(archive);
    assert.deepEqual(entries.map((e) => e.name), ['manifest.json', `cd-art/${A}.jpg`, `cd-art/${B}.jpg`]);
    assert.deepEqual(JSON.parse(entries[0]!.data.toString()), {
        kind: 'cd-art',
        format: 1,
        createdAt: 1_700_000_000_000,
        build: 'test',
    });
    assert.equal(entries[1]!.data.toString(), 'cover a');
});

test('a box that never looked up a disc backs up an empty archive', async (t) => {
    const { backups } = await box(t);
    const { archive } = await backups.create();
    assert.deepEqual(members(archive).map((e) => e.name), ['manifest.json']);
    assert.equal(await backups.restore(archive), 0);
});

test('restore adds and replaces covers, and keeps the ones the archive lacks', async (t) => {
    const source = await box(t, { [`${A}.jpg`]: 'cover a' });
    const { archive } = await source.backups.create();

    const target = await box(t, { [`${A}.jpg`]: 'old a', [`${B}.jpg`]: 'cover b' });
    assert.equal(await target.backups.restore(archive), 1);
    assert.equal(await readFile(join(target.artDir, `${A}.jpg`), 'utf8'), 'cover a');
    assert.equal(await readFile(join(target.artDir, `${B}.jpg`), 'utf8'), 'cover b');
    assert.deepEqual((await readdir(target.artDir)).sort(), [`${A}.jpg`, `${B}.jpg`]);
});

test('restore creates the cover directory on a fresh box', async (t) => {
    const source = await box(t, { [`${A}.jpg`]: 'cover a' });
    const { archive } = await source.backups.create();
    const target = await box(t);
    assert.equal(await target.backups.restore(archive), 1);
    assert.equal(await readFile(join(target.artDir, `${A}.jpg`), 'utf8'), 'cover a');
});

test('archives it should not trust are refused, and nothing is written', async (t) => {
    const source = await box(t, { [`${A}.jpg`]: 'cover a' });
    const { archive } = await source.backups.create();
    const target = await box(t);
    const manifest = (data: object): TarEntry => ({ name: 'manifest.json', data: Buffer.from(JSON.stringify(data)) });

    const bad: [string, Buffer, RegExp][] = [
        ['not gzip', Buffer.from('hello'), /not a gzip/],
        ['a main backup', repack(archive, (e) => [manifest({ format: 1, schemaVersion: 9 }), ...e.slice(1)]), /not a CD cover backup/],
        ['no manifest', repack(archive, (e) => e.slice(1)), /not a CD cover backup/],
        ['a newer format', repack(archive, (e) => [manifest({ kind: 'cd-art', format: 2 }), ...e.slice(1)]), /incompatible/],
        ['a stray file', repack(archive, (e) => [...e, { name: 'cd-art/evil.sh', data: Buffer.from('x') }]), /unexpected file/],
        ['a nested path', repack(archive, (e) => [...e, { name: `cd-art/x/${B}.jpg`, data: Buffer.from('x') }]), /unexpected file/],
        ['a database', repack(archive, (e) => [...e, { name: 'musicbox.db', data: Buffer.from('x') }]), /unexpected file/],
        ['a duplicate', repack(archive, (e) => [...e, e[1]!]), /duplicate/],
        ['an empty cover', repack(archive, (e) => [e[0]!, { name: `cd-art/${B}.jpg`, data: Buffer.alloc(0) }]), /empty/],
    ];
    for (const [what, body, message] of bad) {
        await assert.rejects(
            target.backups.restore(body),
            (err: BackupError) => err instanceof BackupError && err.code === 400 && message.test(err.message),
            what,
        );
    }
    await assert.rejects(readdir(target.artDir), { code: 'ENOENT' });
});

test('a path that climbs out is refused by the tar reader', async (t) => {
    const target = await box(t);
    // packTar would not write it, so the name goes into the header by hand.
    const evil = packTar([{ name: 'manifest.json', data: Buffer.from('{}') }]);
    evil.write('../../etc/passwd'.padEnd(100, '\0'), 0, 100);
    let sum = 0;
    evil.write('        ', 148);
    for (let i = 0; i < 512; i++) sum += evil[i]!;
    evil.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    await assert.rejects(target.backups.restore(gzipSync(evil)), (err: BackupError) => err.code === 400 && /unsafe/.test(err.message));
});

test('only a release ID names a cover', () => {
    assert.equal(coverRelease(`cd-art/${A}.jpg`), A);
    assert.equal(coverRelease(`cd-art/${A}.jpg.tmp`), null);
    assert.equal(coverRelease(`cd-art/${B.toUpperCase()}.jpg`), null);
    assert.equal(coverRelease(`${A}.jpg`), null);
    assert.equal(coverRelease('cd-art/../x.jpg'), null);
});
