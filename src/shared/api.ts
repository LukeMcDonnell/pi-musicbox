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

/**
 * Wire-format version. Bumped when a change is not backwards compatible.
 *
 * Deliberately NOT bumped when `volume` was removed from Snapshot: nothing is in
 * production yet, so a bump would imply a compatibility story that does not exist.
 * Start bumping it once something outside this repo consumes the API.
 */
export const API_VERSION = 1;

/**
 * Playback sources. Exactly one owns the DAC at a time — `hw:0,0` is opened raw,
 * with no mixing layer, so this is a hard exclusion and not a preference.
 * See .claude/docs/bluetooth.md for how the handoff is sequenced. CD is not
 * implemented yet.
 */
export type Source = 'mpd' | 'bluetooth' | 'cd';

export type PlaybackState = 'play' | 'pause' | 'stop';

/** How the backend is currently getting on with MPD. */
export type BackendStatus = 'ok' | 'unavailable';

/**
 * The Bluetooth device currently connected to the A2DP sink, when there is one.
 *
 * WHY IT LIVES ON THE SNAPSHOT
 *   Which source owns the DAC is playback state, and the snapshot rule above
 *   says playback state travels as a complete snapshot. `source` already says
 *   'bluetooth'; this says *which* phone, which is the only part a person can
 *   act on ("why is my music stopped?" — because that phone is connected).
 *
 * WHY THE CODEC IS ON THE WIRE
 *   The whole point of the Bluetooth work is to negotiate the best codec each
 *   phone can manage. Without this field the only way to check which one was
 *   actually chosen is to read journald on the device. See .claude/docs/bluetooth.md.
 *
 *   It is nullable because it is read from BlueALSA after the transport appears,
 *   and a connect is visible before the codec is known. Treat null as "not yet",
 *   not as "no codec".
 *
 * THIS IS THE DEVICE, NOT WHAT IT IS PLAYING
 *   What is playing lives in the top-level `state`, `track`, `elapsed` and
 *   `duration`, which describe the ACTIVE SOURCE whichever that is. This object
 *   is only the identity of the thing on the other end of the radio. Nothing is
 *   duplicated between the two.
 */
export interface BluetoothInfo {
    /** The device's own name, as it advertises it — e.g. "Luke's iPhone". */
    name: string;
    /** MAC, upper-case colon-separated. Stable across reconnects; the name is not. */
    address: string;
    /** Negotiated A2DP codec as BlueALSA reports it (e.g. "aptX HD", "SBC"), or null. */
    codec: string | null;
}

export interface Track {
    /** MPD's song id within the queue, absent for a track not from the queue. */
    id?: number;
    /** Position in the queue, 0-based. */
    position?: number;
    /**
     * Path within the music library, relative to the library root.
     *
     * OPTIONAL, because not every source has a library. A Bluetooth track is
     * whatever the phone says it is — a title and an artist over AVRCP, with no
     * file anywhere on this machine. Present for every MPD track, and
     * `trackFromTags` still refuses to build one without it.
     */
    file?: string;
    title?: string;
    artist?: string;
    album?: string;
    albumArtist?: string;
    track?: string;
    date?: string;
    genre?: string;
    /** Seconds. Absent for streams. */
    duration?: number;

    /**
     * URI for this album's cover art, e.g. `/api/art?album=Radiohead%2FIn%20Rainbows`,
     * or null when there is none to be had.
     *
     * PRESENT FOR EVERY LIBRARY TRACK, AND MAY STILL 404. It is derived purely
     * from `file`, so building a snapshot or a 130-track queue listing touches
     * the filesystem zero times — resolution happens only when a client actually
     * requests the bytes. Clients must handle a 404 by showing a placeholder;
     * about 7.5% of this library's albums have no cover file.
     *
     * Keyed by album DIRECTORY, not by track, so every track on an album shares
     * one URL: the browser fetches it once and a track change within an album
     * causes no refetch and no repaint. See src/backend/src/art.ts.
     *
     * NULL FOR A BLUETOOTH TRACK, and that is settled rather than pending. The
     * phone advertises AVRCP 1.6, which does specify Cover Art — but it offers no
     * OBEX channel to fetch images over, and BlueZ implements none of it either.
     * Deriving a cover by matching the phone's artist and album against the local
     * library was considered and rejected: that metadata is free text, and a
     * near-miss would show a confidently wrong cover. A missing cover is obvious;
     * a wrong one is misinformation. See .claude/docs/bluetooth.md.
     */
    image: string | null;
}

export interface Snapshot {
    apiVersion: number;

    /**
     * 'unavailable' means MPD is down or unreachable. The server keeps serving
     * the UI in that state rather than failing — MPD restarting, or not having
     * started yet at boot, must not take the web UI with it.
     */
    status: BackendStatus;

    /**
     * Which source owns the DAC. Exactly one does — see the Source doc above.
     *
     * THE FIELDS BELOW DESCRIBE THIS SOURCE, whichever it is. `state`, `track`,
     * `elapsed`, `duration`, `queueLength` and `queuePosition` are answers to
     * "what is playing", not "what is MPD doing". A client renders them the same
     * way for every source and consults `source` only to decide what EXTRA it can
     * offer — a queue listing for MPD, a device name for Bluetooth.
     *
     * This was the other way round when the Bluetooth sink first landed: the
     * top-level fields meant MPD and clients were told to branch on `source`.
     * That was honest while there was no metadata for a phone, and wrong once
     * AVRCP gave us title, artist, album, duration and position.
     */
    source: Source;
    state: PlaybackState;

    /**
     * The connected Bluetooth device, or null when none is.
     *
     * ALWAYS PRESENT AS A KEY, like every other snapshot field — null is the
     * "nothing connected" value, never an absent key. bridge.test.ts asserts the
     * key set is identical across a live, an empty and an unavailable snapshot.
     *
     * Non-null implies `source === 'bluetooth'`, and that MPD has been paused and
     * has released the DAC: the two can never both hold hw:0,0.
     *
     * While it is non-null, MPD's own position is NOT on the wire. It is not lost
     * — MPD is paused, not stopped, so disconnecting brings it straight back on
     * the next snapshot — it is simply not what is playing.
     */
    bluetooth: BluetoothInfo | null;

    /*
     * NOTE: there is no `volume`. This box has no volume control — it feeds a
     * preamp and power amp which own that job, and MPD runs mixer_type "none" so
     * it never touches the DAC's attenuator. See install/setup-mpd.sh.
     *
     * Bluetooth was the first real test of that rule, and it did not need a field:
     * bluealsa-aplay runs --volume=none, so the phone attenuates BEFORE encoding
     * and nothing on this box touches the signal. The phone's own slider IS the
     * volume control. If CD ever needs one, put it on the source as this says.
     */

    repeat: boolean;
    random: boolean;
    single: boolean;
    consume: boolean;

    track: Track | null;

    /**
     * Seconds into the current track at the moment this snapshot was taken.
     *
     * The client MUST interpolate from here rather than polling: advance it
     * locally from ITS OWN receive time and re-sync on the next snapshot. Neither
     * source pushes progress continuously, and polling for a smooth progress bar
     * is the obvious wrong answer.
     *
     * Deliberately not `serverTime` as the baseline, which an earlier version of
     * this comment claimed: that would need a phone's clock to agree with the
     * Pi's. It works because the server sends a freshly queried snapshot on SSE
     * connect and on GET /api/status. See decisions.md.
     *
     * For Bluetooth this is AVRCP's Position, which the phone reports in
     * milliseconds and which only updates when we ask. Same interpolation, same
     * caveat.
     */
    elapsed: number | null;
    duration: number | null;

    /**
     * MPD's queue version. When this changes, refetch GET /api/queue.
     * See the snapshot rule above for why the queue is not embedded.
     *
     * -1 MEANS THERE IS NO LISTING TO FETCH, and that is the signal not to try.
     * A Bluetooth source has no readable track list: AVRCP browsing is not
     * exposed by BlueZ, so GET /api/queue answers 409 while a phone is playing.
     * `queueLength` and `queuePosition` below are still meaningful — the phone
     * reports "track 1 of 8" — so the counts are real even though the list is not.
     */
    queueVersion: number;
    queueLength: number;

    /**
     * 0-based position of the current track in the queue, or null when nothing
     * is selected.
     *
     * For MPD this comes from `status`, not from the track, so it is still
     * correct when `track` is null — and it is the field to use for "highlight
     * the playing row" in a queue rendered from GET /api/queue. `track.position`
     * carries the same number when a track is present; this one is authoritative
     * because it does not depend on `currentsong` returning anything.
     *
     * For Bluetooth it is AVRCP's TrackNumber, converted to 0-based. There is no
     * listing to highlight a row in, but "3 of 8" is still worth showing.
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

/*
 * PLAYING A TRACK FROM THE QUEUE: POST /api/queue/play/:id
 *
 * `:id` is `Track.id` — MPD's song id, not the position. Position shifts when
 * the queue is reordered; the id does not. See the `queuePosition` note above.
 *
 * It answers with a Snapshot, 400 for an id that is not a non-negative integer,
 * 409 while a phone owns the DAC, and 503 when MPD is unreachable.
 *
 * WHY IT IS NOT A PlaybackCommand
 *   PLAYBACK_COMMANDS is deliberately a set that BOTH sources implement — the
 *   backend keeps an exhaustive Record for each, so a new verb fails to compile
 *   until MPD and Bluetooth both handle it. A phone exposes no addressable track
 *   list at all (the same reason GET /api/queue is a 409 during a session), so
 *   putting this there would force a mapping that could only ever be a lie.
 */

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

/** The SSE event name carrying a Snapshot. */
export const SSE_SNAPSHOT_EVENT = 'snapshot';

/**
 * The SSE event name carrying the server's build id, sent once per connection.
 *
 * WHY THIS EXISTS
 *   The kiosk browser loads the page at boot and never navigates again — it has
 *   no keyboard and nobody to press reload. Deploying a new frontend therefore
 *   left the panel running the old bundle indefinitely: observed running a
 *   14-hour-old page while the correct files sat on disk being served. The same
 *   trap applies to `git pull` in production, not just the dev loop.
 *
 *   So the server states its build on every connection, and a client that sees
 *   it change reloads itself. Kept OUT of Snapshot deliberately: this is deploy
 *   metadata, not playback state, and the snapshot contract should stay about
 *   what the music is doing.
 */
export const SSE_BUILD_EVENT = 'build';

/** Payload of SSE_BUILD_EVENT. */
export interface BuildInfo {
    /** Same value as HealthResponse.build. */
    build: string;
}
