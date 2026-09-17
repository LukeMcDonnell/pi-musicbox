import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { SETTINGS_DEFAULTS, createSettings, parseSetting } from './settings.ts';

function fresh() {
    const db = openDb({ path: ':memory:' });
    return { db, settings: createSettings(db) };
}

test('an empty database answers with the defaults', () => {
    const { db, settings } = fresh();
    assert.deepEqual(settings.all(), SETTINGS_DEFAULTS);
    // Never, so a box nobody has configured does not blank its own screen.
    assert.equal(settings.all().panelSleepAfterMinutes, 0);
    db.close();
});

test('a written setting is what comes back', () => {
    const { db, settings } = fresh();
    const after = settings.set('panelSleepAfterMinutes', 10);
    assert.equal(after.panelSleepAfterMinutes, 10);
    assert.equal(settings.all().panelSleepAfterMinutes, 10);
    db.close();
});

test('writing twice updates rather than failing on the primary key', () => {
    const { db, settings } = fresh();
    settings.set('panelSleepAfterMinutes', 5);
    settings.set('panelSleepAfterMinutes', 20);
    assert.equal(settings.all().panelSleepAfterMinutes, 20);
    assert.equal(db.all('SELECT key FROM settings').length, 1);
    db.close();
});

test('a stored value the UI cannot offer falls back to the default', () => {
    const { db, settings } = fresh();
    // 12 is not on the list; 7.5 never was; 'soon' is somebody with sqlite3.
    for (const junk of ['12', '7.5', 'soon', '', '-1']) {
        db.run(
            'INSERT INTO settings (key, value) VALUES (?, ?) ' +
                'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            'panelSleepAfterMinutes',
            junk,
        );
        assert.equal(
            settings.all().panelSleepAfterMinutes,
            SETTINGS_DEFAULTS.panelSleepAfterMinutes,
            `stored ${JSON.stringify(junk)} should have fallen back`,
        );
    }
    db.close();
});

test('a key this build no longer knows is ignored, not fatal', () => {
    const { db, settings } = fresh();
    db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'somethingRetired', 'yes');
    assert.deepEqual(settings.all(), SETTINGS_DEFAULTS);
    db.close();
});

test('parseSetting is the gate — it refuses what the wire may carry', () => {
    // The route validates with this before writing, so anything a client can put
    // in a JSON body has to be answered here.
    assert.equal(parseSetting('panelSleepAfterMinutes', 15), 15);
    assert.equal(parseSetting('panelSleepAfterMinutes', '15'), 15);
    assert.equal(parseSetting('panelSleepAfterMinutes', 0), 0);
    assert.equal(parseSetting('panelSleepAfterMinutes', 12), undefined);
    assert.equal(parseSetting('panelSleepAfterMinutes', 'soon'), undefined);
    assert.equal(parseSetting('panelSleepAfterMinutes', null), undefined);
    assert.equal(parseSetting('panelSleepAfterMinutes', undefined), undefined);
    assert.equal(parseSetting('panelSleepAfterMinutes', { minutes: 5 }), undefined);
    assert.equal(parseSetting('panelSleepAfterMinutes', [5]), undefined);
    assert.equal(parseSetting('panelSleepAfterMinutes', true), undefined);
});

test('listeners are told what the settings now are, and can stop listening', () => {
    const { db, settings } = fresh();
    const seen: number[] = [];
    const off = settings.onChange((values) => seen.push(values.panelSleepAfterMinutes));

    settings.set('panelSleepAfterMinutes', 3);
    settings.set('panelSleepAfterMinutes', 4);
    off();
    settings.set('panelSleepAfterMinutes', 5);

    // The event carries the whole set, like every other event in this API.
    assert.deepEqual(seen, [3, 4]);
    db.close();
});

test('settings survive a reopen of the same file', () => {
    // Covered against a real file in db.test.ts; this asserts the typed layer
    // reads back through the same path rather than caching in memory.
    const { db, settings } = fresh();
    settings.set('panelSleepAfterMinutes', 9);
    const second = createSettings(db);
    assert.equal(second.all().panelSleepAfterMinutes, 9);
    db.close();
});

test('the scan hour accepts never and every hour of the day, as a number or a string', () => {
    assert.equal(parseSetting('libraryScanHour', -1), -1);
    assert.equal(parseSetting('libraryScanHour', '-1'), -1);
    assert.equal(parseSetting('libraryScanHour', 0), 0);
    assert.equal(parseSetting('libraryScanHour', 4), 4);
    assert.equal(parseSetting('libraryScanHour', '23'), 23);
});

test('the scan hour rejects anything the dropdown could not have offered', () => {
    for (const bad of [24, -2, 99, '4.5', '0x4', '', ' 4', '4 ', 'soon', null, undefined, {}, []]) {
        assert.equal(parseSetting('libraryScanHour', bad), undefined, `accepted ${JSON.stringify(bad)}`);
    }
});

test('scan-on-boot round-trips a boolean through a TEXT column', () => {
    // settings.set stores String(value), so the guard has to read back what it wrote.
    const { db, settings } = fresh();
    assert.equal(settings.all().libraryScanOnBoot, false);
    assert.equal(settings.set('libraryScanOnBoot', true).libraryScanOnBoot, true);
    assert.equal(settings.all().libraryScanOnBoot, true);
    assert.equal(settings.set('libraryScanOnBoot', false).libraryScanOnBoot, false);
    assert.equal(settings.all().libraryScanOnBoot, false, 'false is a value, not a missing one');
    db.close();
});

test('scan-on-boot rejects the near misses', () => {
    assert.equal(parseSetting('libraryScanOnBoot', true), true);
    assert.equal(parseSetting('libraryScanOnBoot', false), false);
    assert.equal(parseSetting('libraryScanOnBoot', 'true'), true);
    assert.equal(parseSetting('libraryScanOnBoot', 'false'), false);
    for (const bad of ['yes', 'no', 1, 0, '1', '0', '', 'TRUE', null, {}]) {
        assert.equal(
            parseSetting('libraryScanOnBoot', bad),
            undefined,
            `accepted ${JSON.stringify(bad)}`,
        );
    }
});

test('a scan setting written by a newer build falls back to its default', () => {
    const { db, settings } = fresh();
    db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'libraryScanHour', '37');
    assert.equal(settings.all().libraryScanHour, SETTINGS_DEFAULTS.libraryScanHour);
    db.close();
});
