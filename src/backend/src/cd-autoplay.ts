/**
 * What the box does when a disc goes in or comes out.
 *
 * Only an explicit no-disc -> disc change is an insertion. "Unknown" -> disc is
 * this server starting, or the helper restarting, with a disc already in: a
 * redeploy must never restart the CD.
 */

import type { CdInfo } from '../../shared/api.ts';
import { cdInfoOf, type CdState } from './cd.ts';

export interface CdReactorDeps {
    setCd: (info: CdInfo | null) => Promise<void>;
    playCd: (tracks: number) => Promise<void>;
    removeCdTracks: () => Promise<void>;
    autoPlay: () => boolean;
    log: (level: 'warn' | 'info', message: string) => void;
}

export function createCdReactor(deps: CdReactorDeps) {
    return async (next: CdState | null, previous: CdState | null): Promise<void> => {
        await deps.setCd(cdInfoOf(next));
        try {
            if (previous?.present === false && next?.present === true) {
                deps.log('info', `cd: audio disc inserted, ${next.tracks} tracks`);
                if (deps.autoPlay()) await deps.playCd(next.tracks);
            } else if (previous?.present === true && next?.present === false) {
                deps.log('info', 'cd: disc removed');
                await deps.removeCdTracks();
            }
        } catch (err) {
            deps.log('warn', `cd: ${(err as Error).message}`);
        }
    };
}
