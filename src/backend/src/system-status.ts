/**
 * The box's vital signs for Settings → Status, read from /proc and /sys only —
 * the server runs no processes (see thumbs.ts). Polled, never pushed.
 */
import { readFileSync, readdirSync, statfsSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import type { MetadataStatus, SystemStatus, Temperature, ThumbnailStatus, Usage } from '../../shared/api.ts';

export interface SystemStatusDeps {
    /** Prefixed to every /proc and /sys path. Tests point this at a temp tree. */
    root: string;
    readFile: (path: string) => string;
    listDir: (path: string) => string[];
    statfs: (path: string) => { blocks: number; bfree: number; bsize: number };
    loadavg: () => number[];
    now: () => number;
    sleep: (ms: number) => Promise<void>;
}

export const defaultSystemStatusDeps: SystemStatusDeps = {
    root: '',
    readFile: (path) => readFileSync(path, 'utf8'),
    listDir: (path) => readdirSync(path),
    statfs: (path) => statfsSync(path),
    loadavg,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A previous /proc/stat sample older than this is no measure of "now". */
const CPU_SAMPLE_MAX_AGE_MS = 30_000;
/** How long to wait for a second sample when there is no fresh first one. */
const CPU_SAMPLE_GAP_MS = 250;

interface CpuSample {
    at: number;
    busy: number;
    total: number;
}

/** The aggregate `cpu` line of /proc/stat; iowait counts as idle. */
export function parseCpuLine(stat: string): { busy: number; total: number } | null {
    const line = stat.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return null;
    const v = line.trim().split(/\s+/).slice(1, 9).map(Number);
    if (v.length < 5 || v.some((x) => !Number.isFinite(x))) return null;
    const total = v.reduce((a, b) => a + b, 0);
    return { busy: total - v[3] - v[4], total };
}

/** `MemTotal` less `MemAvailable`: what the kernel could not hand out without swapping. */
export function parseMeminfo(meminfo: string): Usage | null {
    const kb = (key: string) => {
        const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(meminfo);
        return m ? Number(m[1]) * 1024 : null;
    };
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    if (total === null || available === null) return null;
    return { usedBytes: total - available, totalBytes: total };
}

export interface SystemStatusReader {
    read: () => Promise<SystemStatus>;
}

export function createSystemStatus(
    thumbnails: () => Promise<ThumbnailStatus>,
    deps: SystemStatusDeps = defaultSystemStatusDeps,
    metadata: (() => MetadataStatus) | null = null,
): SystemStatusReader {
    const path = (p: string) => join(deps.root || '/', p);
    let last: CpuSample | null = null;

    const tryRead = (p: string): string | null => {
        try {
            return deps.readFile(path(p));
        } catch {
            return null;
        }
    };

    const sampleCpu = (): CpuSample | null => {
        const text = tryRead('proc/stat');
        const cpu = text === null ? null : parseCpuLine(text);
        return cpu && { at: deps.now(), ...cpu };
    };

    const cpuPercent = async (): Promise<number | null> => {
        let before = last;
        if (before === null || deps.now() - before.at > CPU_SAMPLE_MAX_AGE_MS) {
            before = sampleCpu();
            await deps.sleep(CPU_SAMPLE_GAP_MS);
        }
        const after = sampleCpu();
        if (after === null) return null;
        last = after;
        if (before === null || after.total <= before.total) return null;
        const percent = ((after.busy - before.busy) / (after.total - before.total)) * 100;
        return Math.round(Math.min(100, Math.max(0, percent)));
    };

    const temperatures = (): Temperature[] => {
        let zones: string[];
        try {
            zones = deps.listDir(path('sys/class/thermal')).filter((z) => z.startsWith('thermal_zone')).sort();
        } catch {
            return [];
        }
        const out: Temperature[] = [];
        for (const zone of zones) {
            const name = tryRead(`sys/class/thermal/${zone}/type`)?.trim();
            const milli = Number(tryRead(`sys/class/thermal/${zone}/temp`) ?? NaN);
            if (name && Number.isFinite(milli)) out.push({ name, celsius: Math.round(milli / 100) / 10 });
        }
        return out;
    };

    // The firmware's own alarm; this kernel exposes no get_throttled (measured on the box).
    const underVoltage = (): boolean | null => {
        let hwmons: string[];
        try {
            hwmons = deps.listDir(path('sys/class/hwmon'));
        } catch {
            return null;
        }
        for (const h of hwmons) {
            if (tryRead(`sys/class/hwmon/${h}/name`)?.trim() !== 'rpi_volt') continue;
            const alarm = tryRead(`sys/class/hwmon/${h}/in0_lcrit_alarm`)?.trim();
            return alarm === undefined ? null : alarm !== '0';
        }
        return null;
    };

    const disk = (): Usage | null => {
        try {
            const fs = deps.statfs(path(''));
            // As df counts it: root's reserved blocks are not "used".
            return { usedBytes: (fs.blocks - fs.bfree) * fs.bsize, totalBytes: fs.blocks * fs.bsize };
        } catch {
            return null;
        }
    };

    return {
        read: async () => {
            const [cpu, thumbs] = await Promise.all([cpuPercent(), thumbnails()]);
            const meminfo = tryRead('proc/meminfo');
            const [l1 = 0, l5 = 0, l15 = 0] = deps.loadavg();
            return {
                uptimeSeconds: Math.round(Number(tryRead('proc/uptime')?.split(' ')[0]) || 0),
                cpuPercent: cpu,
                load: [l1, l5, l15],
                memory: meminfo === null ? null : parseMeminfo(meminfo),
                disk: disk(),
                temperatures: temperatures(),
                underVoltage: underVoltage(),
                thumbnails: thumbs,
                metadata: metadata?.() ?? null,
            };
        },
    };
}
