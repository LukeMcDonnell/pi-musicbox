import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POWER_ACTIONS, PowerUnavailableError, createPower, isPowerAction } from './power.ts';

async function tempDir(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'musicbox-power-'));
}

test('the only two actions are restart and shutdown', () => {
    assert.deepEqual([...POWER_ACTIONS], ['restart', 'shutdown']);
    assert.equal(isPowerAction('restart'), true);
    assert.equal(isPowerAction('shutdown'), true);
    // The route reads this straight off the URL, so everything else is a 400.
    assert.equal(isPowerAction('poweroff'), false);
    assert.equal(isPowerAction('halt'), false);
    assert.equal(isPowerAction('../../etc/passwd'), false);
    assert.equal(isPowerAction('shutdown; rm -rf /'), false);
    assert.equal(isPowerAction(''), false);
});

test('a request is an empty file named after the action, and nothing else', async (t) => {
    const dir = await tempDir();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const power = createPower(dir);

    await power.request('shutdown');
    assert.deepEqual(await readdir(dir), ['shutdown']);
    // Empty: the helper reads the NAME. Nothing here is parsed, so nothing here
    // can be injected.
    assert.equal((await stat(join(dir, 'shutdown'))).size, 0);

    await power.request('restart');
    assert.deepEqual((await readdir(dir)).sort(), ['restart', 'shutdown']);
});

test('pressing twice is not an error', async (t) => {
    // A second press means the same thing as the first, and a 500 in the UI for
    // an impatient tap would be absurd.
    const dir = await tempDir();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const power = createPower(dir);
    await power.request('shutdown');
    await power.request('shutdown');
    assert.deepEqual(await readdir(dir), ['shutdown']);
});

test('a box with no power helper says so instead of failing silently', async () => {
    // Every dev machine, and any box where setup-server.sh has not run.
    const power = createPower('/nonexistent-power-dir');
    assert.equal(await power.available(), false);
    await assert.rejects(() => power.request('restart'), PowerUnavailableError);
    await assert.rejects(() => power.request('restart'), /setup-server\.sh/);
});

test('available() is true for a writable directory', async (t) => {
    const dir = await tempDir();
    t.after(() => rm(dir, { recursive: true, force: true }));
    assert.equal(await createPower(dir).available(), true);
});
