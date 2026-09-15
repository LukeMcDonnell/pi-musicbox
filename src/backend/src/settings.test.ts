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
