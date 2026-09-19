/**
 * Decides that a track was played, and tells plays.ts.
 *
 * A PLAIN SNAPSHOT LISTENER. The bridge replaces its snapshot before notifying,
 * so it cannot hand anyone the previous frame — but a listener that keeps its own
 * copy of what it last saw has one, which is all this needs. No change to the
 * bridge, and no second place that knows about playback.
 *
 * NO TIMER. MPD's `idle` never fires because elapsed time advanced, so a track
 * playing quietly for four minutes produces no frames at all — and then the frame
 * at the song change carries a `serverTime` four minutes later, which IS the time
 * it played. So the threshold is accrued from the wall clock between frames while
 * the state is `play`, never read from MPD's `elapsed`: a seek backwards cannot
 * make one track count twice, and a pause does not accrue.
 *
 * Frames arrive for reasons other than playback — /api/status and every SSE
 * connect call refresh() — which costs nothing here, because adding real elapsed
 * wall clock twice is the same as adding it once.
 */

import { PLAY_THRESHOLD_SECONDS, type Snapshot } from '../../shared/api.ts';
import type { Plays, TrackPlay } from './plays.ts';

export const PLAY_THRESHOLD_MS = PLAY_THRESHOLD_SECONDS * 1000;

/**
 * How far `elapsed` must fall for the same song to count as started again.
 *
 * Repeat-one replays the same songid, so nothing in the frame says "new play"
 * except the position dropping back to the top. A couple of seconds of slack
 * keeps an ordinary seek-to-start out of it.
 */
const RESTART_SLACK_SECONDS = 2;

interface Tracking {
    play: TrackPlay;
    id: number | undefined;
    playedMs: number;
    /** `serverTime` of the frame that last moved this on. */
    lastAt: number;
    /** Whether the music was running as of that frame. */
    playing: boolean;
    elapsed: number | null;
}

export interface PlayWatch {
    /** Feed one snapshot. The bridge subscription in server.ts is the only caller. */
    observe(snapshot: Snapshot): void;
}

export function createPlayWatch(plays: Plays): PlayWatch {
    let tracking: Tracking | null = null;

    const finalise = (): void => {
        if (tracking !== null && tracking.playedMs >= PLAY_THRESHOLD_MS) {
            plays.record(tracking.play);
        }
        tracking = null;
    };

    return {
        observe(snapshot) {
            // Accrue FIRST, on every frame whatever it says. A track that played
            // to the end of the queue is banked by the very frame that reports the
            // queue stopping, and that frame is the only news of it there will be.
            if (tracking !== null && tracking.playing) {
                tracking.playedMs += Math.max(0, snapshot.serverTime - tracking.lastAt);
            }

            const track = snapshot.track;
            // Bluetooth has no file and never will, and an unavailable frame says
            // nothing about MPD. Stopping ends the play outright — unlike a pause,
            // which is the same play waiting to go on.
            if (
                snapshot.source !== 'mpd' ||
                snapshot.status !== 'ok' ||
                snapshot.state === 'stop' ||
                track?.file === undefined
            ) {
                finalise();
                return;
            }

            if (tracking !== null) {
                const restarted =
                    tracking.elapsed !== null &&
                    snapshot.elapsed !== null &&
                    snapshot.elapsed < tracking.elapsed - RESTART_SLACK_SECONDS;
                if (track.file !== tracking.play.file || track.id !== tracking.id || restarted) {
                    finalise();
                }
            }

            if (tracking === null) {
                tracking = {
                    play: {
                        file: track.file,
                        title: track.title,
                        artist: track.artist,
                        album: track.album,
                        albumArtist: track.albumArtist,
                        release: track.release,
                        image: track.image,
                    },
                    id: track.id,
                    playedMs: 0,
                    lastAt: snapshot.serverTime,
                    playing: snapshot.state === 'play',
                    elapsed: snapshot.elapsed,
                };
                return;
            }

            tracking.lastAt = snapshot.serverTime;
            tracking.playing = snapshot.state === 'play';
            tracking.elapsed = snapshot.elapsed;
        },
    };
}
