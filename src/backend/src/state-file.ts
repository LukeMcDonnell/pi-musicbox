/**
 * A JSON state file published by a root helper, observed; and that helper's
 * control FIFO. Shared by the Bluetooth arbiter and the CD helper.
 *
 * The directory is watched rather than the file because the helper replaces the
 * file by rename. The poll is the backstop for a missed event and re-arms the
 * watch: at boot the directory does not exist yet, and a helper restart replaces
 * it (a new inode). See .claude/docs/bluetooth.md.
 */

import { readFile, open as openFile, stat } from 'node:fs/promises';
import { watch, statSync, constants as fsConstants } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { dirname } from 'node:path';

/** Backstop for a missed inotify event. Long: this is a safety net, not the channel. */
export const DEFAULT_POLL_MS = 10_000;

/** Injected in tests so a watcher can be driven without a real filesystem. */
export interface StateFileDeps {
    readText: (path: string) => Promise<string | null>;
}

export const realStateFileDeps: StateFileDeps = {
    readText: async (path) => {
        try {
            return await readFile(path, 'utf8');
        } catch {
            // Absent is normal: no helper installed, or a dev machine.
            return null;
        }
    },
};

export interface StateFileWatcherOptions<T> {
    path: string;
    /** Must never throw: a malformed file degrades to whatever it returns. */
    parse: (text: string | null) => T;
    same: (a: T, b: T) => boolean;
    initial: T;
    /** Named in log lines. */
    label: string;
    pollMs?: number;
    deps?: StateFileDeps;
    /** Called only when the value actually changes, with the value it replaced. */
    onChange: (next: T, previous: T) => void;
    log?: (level: 'warn' | 'info', message: string) => void;
}

export interface StateFileWatcher<T> {
    /** Read once and emit if it differs. Called on every event and on startup. */
    poll: () => Promise<void>;
    current: () => T;
    /** Whether an inotify watch is currently established. Test seam. */
    watching: () => boolean;
    /** Must be called on shutdown: the watch and the timer hold the event loop open. */
    stop: () => void;
}

export function createStateFileWatcher<T>(opts: StateFileWatcherOptions<T>): StateFileWatcher<T> {
    const { path, label } = opts;
    const dir = dirname(path);
    const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    const deps = opts.deps ?? realStateFileDeps;
    const log = opts.log ?? (() => {});

    let value = opts.initial;
    let stopped = false;
    let watcher: FSWatcher | null = null;
    let armWarned = false;
    let watchedIno: number | null = null;

    // A missing directory is the expected state at boot, so it is noted once.
    const arm = (): boolean => {
        if (stopped || watcher !== null) return watcher !== null;
        try {
            const w = watch(dir, () => void poll());
            w.on('error', (err) => {
                log('warn', `${label} state watch dropped, falling back to polling: ${(err as Error).message}`);
                w.close();
                if (watcher === w) watcher = null;
            });
            watcher = w;
            try {
                watchedIno = statSync(dir).ino;
            } catch {
                watchedIno = null;
            }
            if (armWarned) log('info', `${label} state watch established on ${dir}`);
            return true;
        } catch {
            if (!armWarned) {
                armWarned = true;
                log('info', `${dir} does not exist yet — polling until it does`);
            }
            return false;
        }
    };

    const dropStaleWatch = async (): Promise<void> => {
        if (watcher === null) return;
        let ino: number | null = null;
        try {
            ino = (await stat(dir)).ino;
        } catch {
            ino = null;
        }
        if (ino === watchedIno) return;
        log('info', `${label} state directory was replaced — re-arming the watch`);
        watcher.close();
        watcher = null;
        watchedIno = null;
    };

    const poll = async (): Promise<void> => {
        if (stopped) return;
        // Before reading, so a directory that just (re)appeared is watched in the
        // same tick that first sees a file in it.
        await dropStaleWatch();
        if (stopped) return;
        arm();
        const next = opts.parse(await deps.readText(path));
        if (stopped || opts.same(value, next)) return;
        const previous = value;
        value = next;
        opts.onChange(next, previous);
    };

    arm();
    const timer = setInterval(() => void poll(), pollMs);

    return {
        poll,
        current: () => value,
        watching: () => watcher !== null,
        stop: () => {
            stopped = true;
            clearInterval(timer);
            watcher?.close();
            watcher = null;
        },
    };
}

/** The FIFO exists but nobody reads it, or there is no FIFO: the helper is not running. */
export class FifoUnavailableError extends Error {}

/**
 * Write one line to a helper's control FIFO.
 *
 * O_NONBLOCK so a missing reader answers ENXIO at once rather than hanging the
 * request until the client gives up. Fire-and-forget: the result arrives as the
 * next state file.
 */
export async function writeFifoLine(path: string, line: string): Promise<void> {
    let handle;
    try {
        handle = await openFile(path, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENXIO' || code === 'ENOENT') throw new FifoUnavailableError(code);
        throw err;
    }
    try {
        await handle.write(`${line}\n`);
    } finally {
        await handle.close();
    }
}
