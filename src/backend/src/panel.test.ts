import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPanel } from './panel.ts';

/** A backlight device on disk, shaped like the real one on the box. */
async function fakeBacklight(name = '10-0045', max = '255') {
    const root = await mkdtemp(join(tmpdir(), 'musicbox-backlight-'));
    const device = join(root, name);
    await mkdir(device, { recursive: true });
    await writeFile(join(device, 'max_brightness'), `${max}\n`);
    await writeFile(join(device, 'brightness'), `${max}\n`);
    return { root, device, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('with no backlight at all it reports unsupported and stays out of the way', () => {
    // Every dev machine. The routes turn this into a 503 rather than pretending.
    const panel = createPanel({ deps: { root: '/nonexistent-backlight-root' } });
    assert.equal(panel.supported, false);
    assert.equal(panel.set(false), false);
    // Unsupported reads as ON: claiming a dark screen while one is lit is worse
    // than admitting we cannot tell.
    assert.equal(panel.isOn(), true);
});

test('off writes 0 and on writes max_brightness', async (t) => {
    const { root, device, cleanup } = await fakeBacklight();
    t.after(cleanup);
    const panel = createPanel({ deps: { root } });
    assert.equal(panel.supported, true);

    assert.equal(panel.set(false), true);
    assert.equal((await readFile(join(device, 'brightness'), 'utf8')).trim(), '0');
    assert.equal(panel.isOn(), false);

    assert.equal(panel.set(true), true);
    // Back to full, not to some remembered dim value: the panel has one
    // brightness and this is not a dimmer.
    assert.equal((await readFile(join(device, 'brightness'), 'utf8')).trim(), '255');
    assert.equal(panel.isOn(), true);
});

test('the device is discovered, not hardcoded to this box i2c address', async (t) => {
    // 10-0045 is where the address landed on this board; another panel is another
    // number, and the server should not care.
    const { root, device, cleanup } = await fakeBacklight('99-00ff', '100');
    t.after(cleanup);
    const panel = createPanel({ deps: { root } });
    assert.equal(panel.supported, true);
    panel.set(true);
    assert.equal((await readFile(join(device, 'brightness'), 'utf8')).trim(), '100');
});

test('an explicit device wins over discovery', async (t) => {
    const { root, cleanup } = await fakeBacklight('first');
    t.after(cleanup);
    const second = join(root, 'second');
    await mkdir(second, { recursive: true });
    await writeFile(join(second, 'max_brightness'), '64\n');
    await writeFile(join(second, 'brightness'), '64\n');

    const panel = createPanel({ device: second, deps: { root } });
    panel.set(true);
    assert.equal((await readFile(join(second, 'brightness'), 'utf8')).trim(), '64');
});

test('a device with no usable max_brightness is unsupported, not half-working', async (t) => {
    const { root, device, cleanup } = await fakeBacklight('10-0045', '0');
    t.after(cleanup);
    await writeFile(join(device, 'max_brightness'), 'not a number\n');
    // Turning it off without knowing what to restore leaves a screen nobody can
    // light again, so this refuses the whole feature instead.
    assert.equal(createPanel({ deps: { root } }).supported, false);
});

test('a write that fails is reported, not thrown at the caller', async (t) => {
    const { root, cleanup } = await fakeBacklight();
    t.after(cleanup);
    const errors: Error[] = [];
    const panel = createPanel({
        deps: {
            root,
            writeFile: () => {
                // EACCES is what a box whose user was dropped from `video` gives.
                throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            },
        },
        onError: (err) => errors.push(err),
    });
    assert.equal(panel.set(false), false);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /EACCES/);
});

test('an unreadable brightness reads as on', async (t) => {
    const { root, cleanup } = await fakeBacklight();
    t.after(cleanup);
    const panel = createPanel({
        deps: {
            root,
            readFile: (path) => {
                if (path.endsWith('max_brightness')) return '255\n';
                throw new Error('EIO');
            },
        },
        onError: () => {},
    });
    assert.equal(panel.supported, true);
    assert.equal(panel.isOn(), true);
});
