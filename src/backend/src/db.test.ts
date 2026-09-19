import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION, checkDbFile, openDb } from './db.ts';

/** Every schema version from `from` to the current one, in the order they run. */
function versions(from: number): number[] {
    const out: number[] = [];
    for (let v = from; v <= SCHEMA_VERSION; v += 1) out.push(v);
    return out;
}

async function tempDir(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'musicbox-db-'));
}

test('an empty file comes up fully migrated', () => {
    const db = openDb({ path: ':memory:' });
    const row = db.get<{ user_version: number }>('PRAGMA user_version');
    assert.equal(row?.user_version, SCHEMA_VERSION);
    db.close();
});

test('the settings table exists and round-trips a row', () => {
    const db = openDb({ path: ':memory:' });
    db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'panelSleepAfterMinutes', '10');
    assert.equal(
        db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'panelSleepAfterMinutes')
            ?.value,
        '10',
    );
    db.close();
});

test('migrations run once, not on every open — the second open is a no-op', async (t) => {
    const dir = await tempDir();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'musicbox.db');

    const applied: number[] = [];
    const first = openDb({ path, onMigrate: (to) => applied.push(to) });
    first.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'panelSleepAfterMinutes', '5');
    first.close();
    // Derived, not a literal list: every new migration would otherwise fail this
    // test for no reason, and the assertion is "each version once, in order".
    assert.deepEqual(applied, versions(1));

    const againApplied: number[] = [];
    const second = openDb({ path, onMigrate: (to) => againApplied.push(to) });
    // The point of user_version: re-running CREATE TABLE would throw.
    assert.deepEqual(againApplied, []);
    // And the data is still there, which is the entire reason for a file.
    assert.equal(
        second.get<{ value: string }>(
            'SELECT value FROM settings WHERE key = ?',
            'panelSleepAfterMinutes',
        )?.value,
        '5',
    );
    second.close();
});

test('a file is WAL, so a reader cannot block a writer', async (t) => {
    const dir = await tempDir();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const db = openDb({ path: join(dir, 'musicbox.db') });
    const mode = db.get<{ journal_mode: string }>('PRAGMA journal_mode');
    assert.equal(mode?.journal_mode.toLowerCase(), 'wal');
    db.close();
});

test('a database from a NEWER build is refused, not half-read', async (t) => {
    const dir = await tempDir();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'musicbox.db');

    const db = openDb({ path });
    // Pretend a later server wrote this file.
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    db.close();

    // Running this build's statements against a schema it does not know is how
    // data gets destroyed rather than merely lost.
    assert.throws(() => openDb({ path }), /only knows v/);
});

test('a failing migration leaves the version where it was', async (t) => {
    const dir = await tempDir();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'musicbox.db');

    // A broken step must not claim to have run: the next start would skip it and
    // the schema would be half-built for good.
    const broken = [...MIGRATIONS, 'CREATE TABLE ( this is not sql;'];
    assert.throws(() => openDb({ path, migrations: broken }));

    // The good steps before it stand, and the version stops at the last one that
    // actually applied — so a fixed build picks up exactly where this left off.
    const db = openDb({ path });
    assert.equal(
        db.get<{ user_version: number }>('PRAGMA user_version')?.user_version,
        MIGRATIONS.length,
    );
    assert.equal(db.all('SELECT key FROM settings').length, 0);
    db.close();
});

test('transactions roll back as a unit', () => {
    const db = openDb({ path: ':memory:' });
    assert.throws(() => {
        db.transaction(() => {
            db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'panelSleepAfterMinutes', '1');
            throw new Error('halfway');
        });
    }, /halfway/);
    assert.equal(db.all('SELECT key FROM settings').length, 0);
    db.close();
});

test('the parent directory is created when it does not exist', async (t) => {
    const dir = await tempDir();
    t.after(() => rm(dir, { recursive: true, force: true }));
    // First boot on a machine where nothing has made /var/lib/musicbox/data.
    const db = openDb({ path: join(dir, 'nested', 'deeper', 'musicbox.db') });
    assert.equal(db.all('SELECT key FROM settings').length, 0);
    db.close();
});

test('schema v2 adds the library_scan table', () => {
    const db = openDb({ path: ':memory:' });
    db.run(
        'INSERT INTO library_scan (started_at, trigger, songs_before) VALUES (?, ?, ?)',
        1000,
        'manual',
        37289,
    );
    const row = db.get<{ started_at: number; finished_at: number | null; trigger: string }>(
        'SELECT started_at, finished_at, trigger FROM library_scan',
    );
    assert.equal(row?.started_at, 1000);
    assert.equal(row?.trigger, 'manual');
    // Nullable on purpose: the row is written when a scan starts, and one whose
    // end was never seen must not be given a duration it never had.
    assert.equal(row?.finished_at, null);
    db.close();
});

test('favourites are keyed by RELEASE, so one artist can favourite two same-titled records', () => {
    const db = openDb({ path: ':memory:' });
    const insert =
        'INSERT INTO favourite_album (album_artist, album, release, added_at, summary) VALUES (?, ?, ?, ?, ?)';
    db.run(insert, 'Weezer', 'Weezer', 'mb:blue', 1, '{}');
    db.run(insert, 'Weezer', 'Weezer', 'mb:green', 2, '{}');
    assert.throws(() => db.run(insert, 'Weezer', 'Weezer', 'mb:green', 3, '{}'), /UNIQUE/);
    assert.equal(db.all('SELECT * FROM favourite_album').length, 2);
    db.close();
});

test('v6 carries existing favourites over, taking the release from the stored summary', async (t) => {
    // The user's box had 413 of these and 412 carried an id. The one that did
    // not is dropped rather than given a guessed key.
    const dir = await tempDir();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'musicbox.db');

    const before = openDb({ path, migrations: MIGRATIONS.slice(0, 5) });
    const insert = 'INSERT INTO favourite_album (album_artist, album, added_at, summary) VALUES (?, ?, ?, ?)';
    before.run(insert, 'Radiohead', 'Kid A', 10, JSON.stringify({ mbAlbumId: 'kid-a' }));
    before.run(insert, "Don't Stop Me Now", 'EP', 20, JSON.stringify({ label: 'none' }));
    before.run(
        'INSERT INTO track_play (file, album, album_artist, image, play_count, last_played) VALUES (?, ?, ?, ?, 1, 1)',
        'a.flac',
        'Kid A',
        'Radiohead',
        null,
    );
    before.close();

    const after = openDb({ path });
    const kept = after.all<{ album: string; release: string }>('SELECT album, release FROM favourite_album');
    assert.deepEqual(
        kept.map((r) => [r.album, r.release]),
        [['Kid A', 'mb:kid-a']],
    );
    // v7 adds the column to a table that already had rows; they carry no release.
    assert.deepEqual(
        after.all<{ release: string | null }>('SELECT release FROM track_play').map((r) => r.release),
        [null],
    );
    after.close();
});

test('a v1 file migrates forward to v2 without disturbing its settings', async (t) => {
    const dir = await tempDir();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'musicbox.db');

    // Open at v1 only — the schema as it shipped before scan history existed.
    const v1 = openDb({ path, migrations: MIGRATIONS.slice(0, 1) });
    v1.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'panelSleepAfterMinutes', '15');
    assert.equal(v1.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 1);
    v1.close();

    const applied: number[] = [];
    const v2 = openDb({ path, onMigrate: (to) => applied.push(to) });
    assert.deepEqual(applied, versions(2), 'only the new steps ran');
    assert.equal(
        v2.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'panelSleepAfterMinutes')
            ?.value,
        '15',
    );
    assert.equal(v2.all('SELECT * FROM library_scan').length, 0);
    v2.close();
});

test('snapshot writes a standalone copy that checkDbFile accepts', async (t) => {
    const dir = await tempDir();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const db = openDb({ path: join(dir, 'musicbox.db') });
    db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'panelSleepAfterMinutes', '7');
    db.snapshot(join(dir, 'copy.db'));
    db.close();

    assert.equal(checkDbFile(join(dir, 'copy.db')), SCHEMA_VERSION);
    // No sidecars: the copy travels as one file.
    assert.deepEqual((await readdir(dir)).filter((f) => f.startsWith('copy.db')), ['copy.db']);
    const copy = openDb({ path: join(dir, 'copy.db') });
    assert.equal(
        copy.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'panelSleepAfterMinutes')?.value,
        '7',
    );
    copy.close();
});

test('checkDbFile refuses a file that is not a musicbox database', async (t) => {
    const dir = await tempDir();
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, 'junk.db'), 'this is not sqlite, and it is long enough to have a header');
    assert.throws(() => checkDbFile(join(dir, 'junk.db')));

    const newer = openDb({ path: join(dir, 'newer.db') });
    newer.close();
    assert.throws(() => checkDbFile(join(dir, 'newer.db'), SCHEMA_VERSION - 1), /schema v/);
});
