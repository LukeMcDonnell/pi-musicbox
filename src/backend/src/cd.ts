/**
 * The CD drive, observed; and eject, requested.
 *
 * /usr/local/bin/musicbox-cd (install/setup-cd.sh) publishes whether an audio
 * disc is in the drive and ejects on request. This server cannot do either
 * itself — no child_process, and Node cannot issue the ioctl. See
 * .claude/docs/cd.md.
 */

import type { CdInfo } from '../../shared/api.ts';
import {
    FifoUnavailableError,
    createStateFileWatcher,
    writeFifoLine,
} from './state-file.ts';
import type { StateFileDeps, StateFileWatcher } from './state-file.ts';
import { quoteArg } from './mpd/protocol.ts';

/** Must match install/setup-cd.sh; tests/test-cd-config.sh checks. */
export const DEFAULT_CD_STATE_PATH = '/run/musicbox-cd/cd.json';
export const DEFAULT_CD_CONTROL_PATH = '/run/musicbox-cd/control';

/**
 * What the helper said. `null` is "unknown" — no helper, no file, or a file that
 * would not parse — and is deliberately NOT the same as `{present: false}`: a
 * helper restart passes through unknown, and must not look like an insertion.
 */
export type CdState = { present: false } | { present: true; tracks: number };

export function parseCdState(text: string | null): CdState | null {
    if (text === null || text.trim() === '') return null;
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const { present, tracks } = raw as Record<string, unknown>;
    if (present === false) return { present: false };
    if (present === true && typeof tracks === 'number' && Number.isInteger(tracks) && tracks > 0) {
        return { present: true, tracks };
    }
    return null;
}

/** What goes on the wire: the disc, or null for no disc and for unknown alike. */
export function cdInfoOf(state: CdState | null): CdInfo | null {
    return state?.present ? { tracks: state.tracks } : null;
}

function same(a: CdState | null, b: CdState | null): boolean {
    if (a === null || b === null) return a === b;
    if (!a.present || !b.present) return a.present === b.present;
    return a.tracks === b.tracks;
}

export interface CdWatcherOptions {
    path?: string;
    pollMs?: number;
    deps?: StateFileDeps;
    onChange: (next: CdState | null, previous: CdState | null) => void;
    log?: (level: 'warn' | 'info', message: string) => void;
}

export function createCdWatcher(opts: CdWatcherOptions): StateFileWatcher<CdState | null> {
    return createStateFileWatcher<CdState | null>({
        path: opts.path ?? DEFAULT_CD_STATE_PATH,
        parse: parseCdState,
        same,
        initial: null,
        label: 'cd',
        pollMs: opts.pollMs,
        deps: opts.deps,
        onChange: opts.onChange,
        log: opts.log,
    });
}

/** The helper's verbs. `handle_ctl` in install/setup-cd.sh has the matching arms. */
export const CD_CONTROL_VERBS = ['eject'] as const;
export type CdControlVerb = (typeof CD_CONTROL_VERBS)[number];

export class CdUnavailableError extends Error {}

export async function sendCdControl(
    verb: CdControlVerb,
    path: string = DEFAULT_CD_CONTROL_PATH,
): Promise<void> {
    try {
        await writeFifoLine(path, verb);
    } catch (err) {
        if (err instanceof FifoUnavailableError) {
            throw new CdUnavailableError('the CD helper is not running (musicbox-cd) — is setup-cd.sh installed?');
        }
        throw err;
    }
}

/** MPD's URI for one track on the disc. */
export function cdUri(track: number): string {
    return `cdda:///${track}`;
}

/** Replace the queue with the disc and play it — the same verb as playing an album. */
export function cdPlayCommands(tracks: number): string[] {
    const adds = Array.from({ length: tracks }, (_, i) => `add ${quoteArg(cdUri(i + 1))}`);
    return ['clear', ...adds, 'play'];
}
