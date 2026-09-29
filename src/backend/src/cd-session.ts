/**
 * The disc in the drive, and the lookup running for it.
 *
 * What the drive says is published at once — track count and durations need no
 * network — and the lookup's answer is merged in when it arrives. A failed lookup
 * is retried while the same disc stays in; ejecting it abandons the lookup.
 */

import { discFromState, type CdDisc, type CdState } from './cd.ts';
import type { CdLookup, CdRelease } from './cd-lookup.ts';

export const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000];

export interface CdSessionDeps {
    publish: (disc: CdDisc | null) => Promise<void>;
    lookup: CdLookup;
    lookupEnabled: () => boolean;
    log: (level: 'warn' | 'info', message: string) => void;
    retryDelaysMs?: readonly number[];
}

export interface CdSession {
    /** Publish what the helper now says; resolves with the drive-only view. */
    update(state: CdState | null): Promise<CdDisc | null>;
    /** Start again from the last state — the lookup setting changed. */
    refresh(): Promise<void>;
    current(): CdDisc | null;
    stop(): void;
}

export function withRelease(disc: CdDisc, release: CdRelease, image: string | null): CdDisc {
    return {
        info: {
            ...disc.info,
            lookup: 'found',
            album: release.album,
            artist: release.artist,
            date: release.date,
            image,
        },
        tracks: disc.tracks.map((t, i) => ({
            ...t,
            title: release.tracks[i]?.title || null,
            artist: release.tracks[i]?.artist ?? release.artist,
        })),
    };
}

export function createCdSession(deps: CdSessionDeps): CdSession {
    const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
    let state: CdState | null = null;
    let disc: CdDisc | null = null;
    // Bumped on every change, so a lookup for a disc that has since gone is dropped.
    let generation = 0;
    let timer: NodeJS.Timeout | null = null;

    const clearTimer = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };

    const run = async (gen: number, attempt: number): Promise<void> => {
        const discId = disc?.info.discId;
        if (!discId) return;
        const result = await deps.lookup.find(discId);
        if (gen !== generation || disc === null) return;
        if (result.status === 'found') {
            disc = withRelease(disc, result.release, result.image);
        } else {
            disc = { ...disc, info: { ...disc.info, lookup: result.status } };
        }
        await deps.publish(disc);
        if (result.status === 'failed') {
            const delay = delays[Math.min(attempt, delays.length - 1)];
            deps.log('warn', `cd: lookup failed (${result.reason}); retrying in ${Math.round(delay / 1000)}s`);
            timer = setTimeout(() => void run(gen, attempt + 1), delay);
            timer.unref();
        }
    };

    const update = async (next: CdState | null): Promise<CdDisc | null> => {
        clearTimer();
        generation++;
        state = next;
        disc = next?.present ? discFromState(next, deps.lookupEnabled()) : null;
        await deps.publish(disc);
        if (disc?.info.lookup === 'pending') void run(generation, 0);
        return disc;
    };

    return {
        update,
        refresh: async () => {
            await update(state);
        },
        current: () => disc,
        stop: () => {
            clearTimer();
            generation++;
        },
    };
}
