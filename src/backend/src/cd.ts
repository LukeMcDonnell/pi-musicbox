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
import { audioTracks, discIdOf, type Toc } from './cd-toc.ts';

/** Must match install/setup-cd.sh; tests/test-cd-config.sh checks. */
export const DEFAULT_CD_STATE_PATH = '/run/musicbox-cd/cd.json';
export const DEFAULT_CD_CONTROL_PATH = '/run/musicbox-cd/control';

/**
 * What the helper said. `null` is "unknown" — no helper, no file, or a file that
 * would not parse — and is deliberately NOT the same as `{present: false}`: a
 * helper restart passes through unknown, and must not look like an insertion.
 */
export type CdState = { present: false } | { present: true; tracks: number; toc?: Toc };

const isFrame = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** A table of contents that is internally consistent, or undefined. */
function parseToc(raw: unknown): Toc | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const { first, leadout, offsets, data } = raw as Record<string, unknown>;
    if (!isFrame(first) || first < 1 || !isFrame(leadout)) return undefined;
    if (!Array.isArray(offsets) || offsets.length === 0 || offsets.length > 99) return undefined;
    if (!Array.isArray(data) || data.length !== offsets.length) return undefined;
    if (!offsets.every(isFrame) || !data.every((d) => typeof d === 'boolean')) return undefined;
    const ascending = [...offsets, leadout].every((o, i, all) => i === 0 || o > all[i - 1]);
    return ascending ? { first, leadout, offsets, data } : undefined;
}

export function parseCdState(text: string | null): CdState | null {
    if (text === null || text.trim() === '') return null;
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const { present, tracks, toc } = raw as Record<string, unknown>;
    if (present === false) return { present: false };
    if (present === true && typeof tracks === 'number' && Number.isInteger(tracks) && tracks > 0) {
        const parsed = parseToc(toc);
        return parsed ? { present: true, tracks, toc: parsed } : { present: true, tracks };
    }
    return null;
}

function same(a: CdState | null, b: CdState | null): boolean {
    if (a === null || b === null) return a === b;
    if (!a.present || !b.present) return a.present === b.present;
    return a.tracks === b.tracks && JSON.stringify(a.toc) === JSON.stringify(b.toc);
}

/** One track of the disc in the drive, as far as anything knows it. */
export interface CdTrackInfo {
    number: number;
    duration: number | null;
    title: string | null;
    artist: string | null;
}

/** The disc in the drive: what goes on the wire, plus the per-track detail queue rows use. */
export interface CdDisc {
    info: CdInfo;
    tracks: CdTrackInfo[];
}

/** What the drive alone says about a disc. `lookup` is where the online half starts from. */
export function discFromState(
    state: { tracks: number; toc?: Toc },
    lookupEnabled: boolean,
): CdDisc {
    const toc = state.toc;
    const tracks: CdTrackInfo[] = toc
        ? audioTracks(toc).map((t) => ({ number: t.number, duration: t.duration, title: null, artist: null }))
        // Without a TOC all there is to go on is udev's count.
        : Array.from({ length: state.tracks }, (_, i) => ({ number: i + 1, duration: null, title: null, artist: null }));
    const discId = toc ? discIdOf(toc) : null;
    return {
        info: {
            tracks: tracks.length,
            discId,
            lookup: !lookupEnabled ? 'off' : discId === null ? 'not-found' : 'pending',
            album: null,
            artist: null,
            date: null,
            image: null,
        },
        tracks,
    };
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
export function cdPlayCommands(tracks: readonly number[]): string[] {
    return ['clear', ...tracks.map((n) => `add ${quoteArg(cdUri(n))}`), 'play'];
}
