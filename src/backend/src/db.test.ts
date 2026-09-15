import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION, openDb } from './db.ts';

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
    assert.deepEqual(applied, [1]);

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
