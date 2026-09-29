/**
 * What the box does when a disc goes in or comes out.
 *
 * Only an explicit no-disc -> disc change is an insertion. "Unknown" -> disc is
 * this server starting, or the helper restarting, with a disc already in: a
 * redeploy must never restart the CD.
 */

import type { CdDisc, CdState } from './cd.ts';

export interface CdReactorDeps {
    /** Publishes the disc and starts its lookup; resolves with what the drive says. */
    setCd: (state: CdState | null) => Promise<CdDisc | null>;
    playCd: (tracks: readonly number[]) => Promise<void>;
    removeCdTracks: () => Promise<void>;
    autoPlay: () => boolean;
    log: (level: 'warn' | 'info', message: string) => void;
}

export function createCdReactor(deps: CdReactorDeps) {
    return async (next: CdState | null, previous: CdState | null): Promise<void> => {
        const disc = await deps.setCd(next);
        try {
            if (previous?.present === false && next?.present === true && disc !== null) {
                deps.log('info', `cd: audio disc inserted, ${disc.tracks.length} tracks`);
                // Not held back for the lookup: titles arrive while it plays.
                if (deps.autoPlay()) await deps.playCd(disc.tracks.map((t) => t.number));
            } else if (previous?.present === true && next?.present === false) {
                deps.log('info', 'cd: disc removed');
                await deps.removeCdTracks();
            }
        } catch (err) {
            deps.log('warn', `cd: ${(err as Error).message}`);
        }
    };
}
