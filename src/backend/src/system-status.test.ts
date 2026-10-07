import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MetadataStatus, ThumbnailStatus } from '../../shared/api.ts';
import { createSystemStatus, parseCpuLine, parseMeminfo, type SystemStatusDeps } from './system-status.ts';

const THUMBS: ThumbnailStatus = {
    state: 'never', scope: null, progress: null, total: null,
    startedAt: null, finishedAt: null, built: null, failed: null,
};

/** A /proc and /sys tree shaped like the Pi 4's, measured on the box. */
async function fakeBox(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'musicbox-sys-'));
    const put = async (path: string, data: string) => {
        await mkdir(join(root, path, '..'), { recursive: true });
        await writeFile(join(root, path), data);
    };
    await put('proc/uptime', '940.78 2174.70\n');
    await put('proc/meminfo', 'MemTotal:        3886888 kB\nMemFree:  100 kB\nMemAvailable:    3158736 kB\n');
    await put('proc/stat', 'cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 1 1 1 1 1 1 1 0 0\n');
    await put('sys/class/thermal/thermal_zone0/type', 'cpu-thermal\n');
    await put('sys/class/thermal/thermal_zone0/temp', '75471\n');
    await put('sys/class/thermal/cooling_device0/type', 'fan\n');
    await put('sys/class/hwmon/hwmon0/name', 'cpu_thermal\n');
    await put('sys/class/hwmon/hwmon1/name', 'rpi_volt\n');
    await put('sys/class/hwmon/hwmon1/in0_lcrit_alarm', '0\n');
    return root;
}

function deps(root: string, overrides: Partial<SystemStatusDeps> = {}): SystemStatusDeps {
    return {
        root,
        readFile: (path) => readFileSync(path, 'utf8'),
        listDir: (path) => readdirSync(path),
        statfs: () => ({ blocks: 1000, bfree: 750, bsize: 4096 }),
        loadavg: () => [0.5, 0.25, 0.125],
        now: () => 0,
        sleep: async () => {},
        ...overrides,
    };
}

test('parseCpuLine counts iowait as idle', () => {
    assert.deepEqual(parseCpuLine('cpu  10 2 3 80 5 0 0 0 0 0\n'), { busy: 15, total: 100 });
    assert.equal(parseCpuLine('intr 1 2 3\n'), null);
});

test('parseMeminfo uses MemAvailable, not MemFree', () => {
    assert.deepEqual(parseMeminfo('MemTotal: 4 kB\nMemFree: 1 kB\nMemAvailable: 3 kB\n'), { usedBytes: 1024, totalBytes: 4096 });
    assert.equal(parseMeminfo('MemTotal: 4 kB\n'), null);
});

test('reads the Pi 4 as it is laid out on the box', async () => {
    const root = await fakeBox();
    try {
        const status = await createSystemStatus(async () => THUMBS, deps(root)).read();
        assert.equal(status.uptimeSeconds, 941);
        assert.deepEqual(status.load, [0.5, 0.25, 0.125]);
        assert.deepEqual(status.memory, { usedBytes: (3886888 - 3158736) * 1024, totalBytes: 3886888 * 1024 });
        assert.deepEqual(status.disk, { usedBytes: 250 * 4096, totalBytes: 1000 * 4096 });
        assert.deepEqual(status.temperatures, [{ name: 'cpu-thermal', celsius: 75.5 }]);
        assert.equal(status.underVoltage, false);
        assert.equal(status.thumbnails, THUMBS);
        assert.equal(status.metadata, null);

        const metadata = { phase: null, hasToken: false } as unknown as MetadataStatus;
        assert.equal((await createSystemStatus(async () => THUMBS, deps(root), () => metadata).read()).metadata, metadata);

        await writeFile(join(root, 'sys/class/hwmon/hwmon1/in0_lcrit_alarm'), '1\n');
        assert.equal((await createSystemStatus(async () => THUMBS, deps(root)).read()).underVoltage, true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('CPU is the delta between samples, with a short one of its own when there is no fresh one', async () => {
    const root = await fakeBox();
    try {
        let now = 0;
        const sleeps: number[] = [];
        const stat = join(root, 'proc/stat');
        const reader = createSystemStatus(async () => THUMBS, deps(root, {
            now: () => now,
            // Between the in-request pair, 50 busy and 50 idle jiffies pass.
            sleep: async (ms) => { sleeps.push(ms); await writeFile(stat, 'cpu  150 0 100 750 100 0 0 0 0 0\n'); },
        }));
        assert.equal((await reader.read()).cpuPercent, 50);
        assert.equal(sleeps.length, 1);

        now = 3_000;
        await writeFile(stat, 'cpu  150 0 100 850 100 0 0 0 0 0\n');
        assert.equal((await reader.read()).cpuPercent, 0, 'measured against the previous poll');
        assert.equal(sleeps.length, 1, 'with no wait of its own');

        now = 60_000;
        await reader.read();
        assert.equal(sleeps.length, 2, 'a stale sample is resampled');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a dev machine with none of it answers with nulls, not an error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'musicbox-sys-'));
    try {
        const status = await createSystemStatus(async () => THUMBS, deps(root, {
            statfs: () => { throw new Error('ENOENT'); },
        })).read();
        assert.equal(status.uptimeSeconds, 0);
        assert.equal(status.cpuPercent, null);
        assert.equal(status.memory, null);
        assert.equal(status.disk, null);
        assert.deepEqual(status.temperatures, []);
        assert.equal(status.underVoltage, null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
