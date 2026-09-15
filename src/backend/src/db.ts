/**
 * The database.
 *
 * node:sqlite, which is part of the runtime from Node 22.5 and needs no flag
 * from 24 — so this costs no dependency, nothing to ship beside server.js, and
 * no native module to break the single-file bundle. install.sh is what puts a
 * node that new on the device.
 *
 * THE ONLY FILE THAT IMPORTS node:sqlite. Everything else takes the small
 * interface below, so swapping the engine is one file and a day, not a search
 * through the backend.
 *
 * MIGRATIONS ARE APPEND-ONLY. `PRAGMA user_version` says which have run; each
 * entry moves the schema forward by one and is never edited once it has shipped,
 * because the box in the next room is already at that version. Favourites and
 * recent plays arrive as MIGRATIONS[1], [2] — not as edits to [0].
 */

import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * A prepared, executed statement — the subset of node:sqlite this backend uses.
 *
 * Deliberately not re-exporting the driver's own types: they are what an engine
 * swap would change, and naming them here is what keeps that swap local.
 */
export interface Db {
    /** One row, or undefined. */
    get<T>(sql: string, ...params: SqlValue[]): T | undefined;
    /** Every row. */
    all<T>(sql: string, ...params: SqlValue[]): T[];
    /** A statement with no result worth having. */
    run(sql: string, ...params: SqlValue[]): void;
    /** Several statements as one unit — all of them, or none. */
    transaction(fn: () => void): void;
    close(): void;
}

export type SqlValue = string | number | null;

/**
 * The schema, one entry per version.
 *
 * `user_version` is 0 on an empty file, so MIGRATIONS[0] is what takes it to 1.
 */
export const MIGRATIONS: readonly string[] = [
    // v1 — settings. Values are TEXT because that is what survives: a setting
    // that is a number today may be an enum tomorrow, and the typed layer above
    // (settings.ts) is where the meaning lives.
    `CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    ) STRICT;`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export interface OpenOptions {
    /** A path, or ':memory:' — which is what the tests use. */
    path: string;
    /** Called once per applied migration. */
    onMigrate?: (to: number) => void;
    /**
     * The schema to apply. Defaults to MIGRATIONS, and only the tests pass
     * anything else — a deliberate seam, because a migration that fails halfway
     * is the one failure here that must never be guessed at.
     */
    migrations?: readonly string[];
}

/**
 * Open the database, creating and migrating it as needed.
 *
 * WAL, because the alternative is a reader blocking a writer: the snapshot
 * stream and an HTTP write are the same process but not the same moment, and a
 * locked database would surface as a 500 on a settings change. It also survives
 * an unclean shutdown, which on a box people switch off at the wall is the
 * normal way to stop.
 */
export function openDb(options: OpenOptions): Db {
    const { path, onMigrate, migrations = MIGRATIONS } = options;

    // :memory: has no directory, and the parent of a real path may not exist on
    // a first boot. install/setup-server.sh creates it owned by the app user;
    // this is the belt for a dev machine, where nothing has.
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

    const sqlite = new DatabaseSync(path);

    // WAL is a property of the FILE, not the connection, so it is set once and
    // persists; :memory: silently stays in journal mode, which is correct.
    if (path !== ':memory:') sqlite.exec('PRAGMA journal_mode = WAL;');
    sqlite.exec('PRAGMA foreign_keys = ON;');
    // A second writer should wait, not fail. There is only one today; the page
    // that says so is not the page to discover this on.
    sqlite.exec('PRAGMA busy_timeout = 5000;');

    const db: Db = {
        get<T>(sql: string, ...params: SqlValue[]): T | undefined {
            return sqlite.prepare(sql).get(...params) as T | undefined;
        },
        all<T>(sql: string, ...params: SqlValue[]): T[] {
            return sqlite.prepare(sql).all(...params) as T[];
        },
        run(sql: string, ...params: SqlValue[]): void {
            sqlite.prepare(sql).run(...params);
        },
        transaction(fn: () => void): void {
            sqlite.exec('BEGIN');
            try {
                fn();
                sqlite.exec('COMMIT');
            } catch (err) {
                sqlite.exec('ROLLBACK');
                throw err;
            }
        },
        close(): void {
            sqlite.close();
        },
    };

    migrate(sqlite, migrations, onMigrate);
    return db;
}

/**
 * Apply whatever has not run yet.
 *
 * Each step and its version bump go in ONE transaction: a migration that half
 * applied and then claimed it had not would be applied again on the next start,
 * which for a CREATE TABLE is an error and for an ALTER is worse.
 */
function migrate(
    sqlite: DatabaseSync,
    migrations: readonly string[],
    onMigrate?: (to: number) => void,
): void {
    const row = sqlite.prepare('PRAGMA user_version').get() as
        | { user_version: number }
        | undefined;
    let version = row?.user_version ?? 0;

    // Older than this build knows about. Refusing beats guessing: it means the
    // file was written by a newer server, and running v3 statements against a
    // v5 schema corrupts rather than fails.
    if (version > migrations.length) {
        throw new Error(
            `database is at schema v${version}, but this build only knows v${migrations.length}`,
        );
    }

    while (version < migrations.length) {
        const next = version + 1;
        sqlite.exec('BEGIN');
        try {
            sqlite.exec(migrations[version]!);
            // Not a bound parameter: PRAGMA does not take one. `next` is an
            // integer this module computed, never anything from outside.
            sqlite.exec(`PRAGMA user_version = ${next}`);
            sqlite.exec('COMMIT');
        } catch (err) {
            sqlite.exec('ROLLBACK');
            throw err;
        }
        version = next;
        onMigrate?.(next);
    }
}
