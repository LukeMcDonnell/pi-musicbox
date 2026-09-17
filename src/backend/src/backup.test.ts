import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BackupError, backupFilename, createBackups, isAllowedMember, readBackup } from './backup.ts';
import { SCHEMA_VERSION, openDb } from './db.ts';
import { packTar, unpackTar, type TarEntry } from './tar.ts';

async function box(t: { after: (fn: () => unknown) => void }) {
    const root = await mkdtemp(join(tmpdir(), 'musicbox-backup-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const mpdDir = join(root, 'mpd');
    const restoreDir = join(root, 'restore');
    await mkdir(join(mpdDir, 'playlists'), { recursive: true });
    await mkdir(restoreDir);
    await writeFile(join(mpdDir, 'state'), 'state: pause\nplaylist_begin\n0:a.flac\nplaylist_end\n');
    await writeFile(join(mpdDir, 'tag_cache'), 'info_begin\n');
    await writeFile(join(mpdDir, 'playlists', 'Road trip.m3u'), 'a.flac\n');
    await writeFile(join(mpdDir, 'playlists', 'not-a-playlist.txt'), 'ignored');

    const db = openDb({ path: join(root, 'data', 'musicbox.db') });
    t.after(() => db.close());
    db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'panelSleepAfterMinutes', '10');

    const backups = createBackups({ db, build: 'test', mpdDir, restoreDir, now: () => 1_700_000_000_000 });
    return { root, mpdDir, restoreDir, db, backups };
}

function members(archive: Buffer): TarEntry[] {
    return unpackTar(gunzipSync(archive));
}

function repack(archive: Buffer, edit: (entries: TarEntry[]) => TarEntry[]): Buffer {
    return gzipSync(packTar(edit(members(archive))));
}

test('a backup holds the manifest, the database and MPD’s files', async (t) => {
    const { backups } = await box(t);
    const { filename, archive } = await backups.create();
    assert.match(filename, /^musicbox-backup-\d{8}-\d{4}\.tar\.gz$/);
    assert.deepEqual(
        members(archive).map((e) => e.name),
        ['manifest.json', 'musicbox.db', 'mpd/state', 'mpd/tag_cache', 'mpd/playlists/Road trip.m3u'],
    );
    const manifest = JSON.parse(members(archive)[0]!.data.toString());
    assert.deepEqual(manifest, { format: 1, createdAt: 1_700_000_000_000, build: 'test', schemaVersion: SCHEMA_VERSION });
});

test('the database in a backup is a complete, standalone copy', async (t) => {
    const { backups, root } = await box(t);
    const entries = await readBackup((await backups.create()).archive);
    const path = join(root, 'copy.db');
    await writeFile(path, entries.find((e) => e.name === 'musicbox.db')!.data);
    const copy = openDb({ path });
    t.after(() => copy.close());
    assert.equal(
        copy.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'panelSleepAfterMinutes')?.value,
        '10',
    );
});

test('a box with no MPD state cannot be backed up, and says why', async (t) => {
    const { backups, mpdDir } = await box(t);
    await rm(join(mpdDir, 'state'));
    await assert.rejects(backups.create(), (err: BackupError) => err.code === 503 && /state/.test(err.message));
});

test('restore stages the files, then drops the request', async (t) => {
    const { backups, restoreDir } = await box(t);
    await backups.restore((await backups.create()).archive);

    assert.deepEqual((await readdir(restoreDir)).sort(), ['payload', 'request']);
    assert.equal(await readFile(join(restoreDir, 'payload/mpd/state'), 'utf8'), 'state: pause\nplaylist_begin\n0:a.flac\nplaylist_end\n');
    assert.deepEqual((await readdir(join(restoreDir, 'payload'))).sort(), ['mpd', 'musicbox.db']);
    assert.deepEqual(await readdir(join(restoreDir, 'payload/mpd/playlists')), ['Road trip.m3u']);
    assert.equal(await backups.pending(), true);
});

test('a second restore while one is pending is refused', async (t) => {
    const { backups } = await box(t);
    const { archive } = await backups.create();
    await backups.restore(archive);
    await assert.rejects(backups.restore(archive), (err: BackupError) => err.code === 409);
});

test('no helper installed is a 503', async (t) => {
    const { db, mpdDir } = await box(t);
    const backups = createBackups({ db, build: 'test', mpdDir, restoreDir: '/nonexistent-restore-dir' });
    await assert.rejects(backups.restore((await backups.create()).archive), (err: BackupError) => err.code === 503);
});

test('archives it should not trust are refused, and nothing is staged', async (t) => {
    const { backups, restoreDir } = await box(t);
    const good = (await backups.create()).archive;

    const cases: [string, Buffer][] = [
        ['not gzip', Buffer.from('hello')],
        ['gzip, not tar', gzipSync(Buffer.alloc(1024, 0x41))],
        ['no manifest', repack(good, (e) => e.filter((m) => m.name !== 'manifest.json'))],
        ['a future format', repack(good, (e) => e.map((m) => (m.name === 'manifest.json' ? { ...m, data: Buffer.from('{"format":2}') } : m)))],
        ['no database', repack(good, (e) => e.filter((m) => m.name !== 'musicbox.db'))],
        ['no MPD state', repack(good, (e) => e.filter((m) => m.name !== 'mpd/state'))],
        ['an unknown file', repack(good, (e) => [...e, { name: 'etc/passwd', data: Buffer.from('x') }])],
        ['a hidden playlist', repack(good, (e) => [...e, { name: 'mpd/playlists/.x.m3u', data: Buffer.from('x') }])],
        ['a duplicate member', repack(good, (e) => [...e, e[2]!])],
        ['a corrupt database', repack(good, (e) => e.map((m) => (m.name === 'musicbox.db' ? { ...m, data: Buffer.from('not sqlite at all, not even close') } : m)))],
    ];
    for (const [label, archive] of cases) {
        await assert.rejects(backups.restore(archive), (err: BackupError) => err.code === 400, label);
    }
    assert.deepEqual(await readdir(restoreDir), []);
});

test('a database from a newer build is refused', async (t) => {
    const { backups } = await box(t);
    const archive = (await backups.create()).archive;
    await assert.rejects(readBackup(archive, SCHEMA_VERSION - 1), /schema v/);
});

test('the member allowlist', () => {
    for (const ok of ['musicbox.db', 'manifest.json', 'mpd/state', 'mpd/tag_cache', 'mpd/sticker.sql', 'mpd/playlists/A b.m3u']) {
        assert.equal(isAllowedMember(ok), true, ok);
    }
    for (const bad of ['mpd/playlists/a/b.m3u', 'mpd/playlists/x.txt', 'mpd/playlists/.m3u', 'mpd/mpd.conf', 'state', 'musicbox.db-wal']) {
        assert.equal(isAllowedMember(bad), false, bad);
    }
});

test('the filename is the box’s local time', () => {
    const at = new Date(2026, 8, 17, 9, 5).getTime();
    assert.equal(backupFilename(at), 'musicbox-backup-20260917-0905.tar.gz');
});
