/**
 * musicbox — the API contract.
 *
 * Imported by BOTH the backend and the Angular frontend, so the wire format has
 * exactly one definition. If you change something here, both sides stop
 * compiling until they agree again — which is the entire reason the stack is
 * TypeScript end to end.
 *
 * THE SNAPSHOT RULE
 *   Every SSE event carries a complete Snapshot, never a delta. A dropped,
 *   duplicated or out-of-order event therefore costs nothing: the client
 *   replaces its state wholesale and can never drift out of sync. Do not add
 *   "changed" fields or patch semantics here.
 *
 *   The one thing deliberately NOT embedded is the queue. It is referenced by
 *   `queueVersion` instead, because the library is ~37,000 songs and a long
 *   queue would mean megabytes of JSON on every volume nudge. The client
 *   refetches GET /api/queue when the version changes. The snapshot stays
 *   self-describing; it just describes the queue by version rather than value.
 */

/** Wire-format version. Bumped when a change is not backwards compatible. */
export const API_VERSION = 1;

/** Playback sources. Bluetooth and CD are not implemented yet. */
export type Source = 'mpd' | 'bluetooth' | 'cd';

export type PlaybackState = 'play' | 'pause' | 'stop';

/** How the backend is currently getting on with MPD. */
export type BackendStatus = 'ok' | 'unavailable';

export interface Track {
    /** MPD's song id within the queue, absent for a track not from the queue. */
    id?: number;
    /** Position in the queue, 0-based. */
    position?: number;
    file: string;
    title?: string;
    artist?: string;
    album?: string;
    albumArtist?: string;
    track?: string;
    date?: string;
    genre?: string;
    /** Seconds. Absent for streams. */
    duration?: number;
}

export interface Snapshot {
    apiVersion: number;

    /**
     * 'unavailable' means MPD is down or unreachable. The server keeps serving
     * the UI in that state rather than failing — MPD restarting, or not having
     * started yet at boot, must not take the web UI with it.
     */
    status: BackendStatus;

    source: Source;
    state: PlaybackState;

    /** 0-100, or null when MPD reports no mixer. */
    volume: number | null;

    repeat: boolean;
    random: boolean;
    single: boolean;
    consume: boolean;

    track: Track | null;

    /**
     * Seconds into the current track at the moment this snapshot was taken.
     *
     * The client MUST interpolate from here rather than polling: advance it
     * locally using serverTime as the baseline and re-sync on the next
     * snapshot. MPD does not push progress continuously, and polling for a
     * smooth progress bar is the obvious wrong answer.
     */
    elapsed: number | null;
    duration: number | null;

    /**
     * MPD's queue version. When this changes, refetch GET /api/queue.
     * See the snapshot rule above for why the queue is not embedded.
     */
    queueVersion: number;
    queueLength: number;

    /**
     * 0-based position of the current track in the queue, or null when nothing
     * is selected.
     *
     * This comes from MPD's `status`, not from the track, so it is still correct
     * when `track` is null — and it is the field to use for "highlight the
     * playing row" in a queue rendered from GET /api/queue. `track.position`
     * carries the same number when a track is present; this one is authoritative
     * because it does not depend on `currentsong` returning anything.
     *
     * Note it is a POSITION, so it shifts when the queue is reordered. If you
     * need a handle that survives reordering, use `track.id` (MPD's song id).
     */
    queuePosition: number | null;

    /** Server clock (epoch ms) when this snapshot was taken, for interpolation. */
    serverTime: number;
}

export interface QueueResponse {
    /** The version this queue listing corresponds to. */
    version: number;
    tracks: Track[];
}

export interface HealthResponse {
    ok: true;
    /** Set at build time so a deploy can be confirmed from the outside. */
    build: string;
    apiVersion: number;
    uptimeSeconds: number;
    /** Whether MPD is reachable. Health is about the SERVER, so this is informational. */
    mpd: BackendStatus;
}

export interface ErrorResponse {
    error: string;
}

/** Commands accepted by POST /api/playback/:command */
export const PLAYBACK_COMMANDS = ['play', 'pause', 'stop', 'next', 'previous'] as const;
export type PlaybackCommand = (typeof PLAYBACK_COMMANDS)[number];

export interface VolumeRequest {
    /** 0-100. */
    value: number;
}

/** The SSE event name carrying a Snapshot. */
export const SSE_SNAPSHOT_EVENT = 'snapshot';
