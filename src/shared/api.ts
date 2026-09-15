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
    /**
     * The `OriginalDate` tag — when the album first came out, as opposed to when
     * THIS pressing did.
     *
     * WORTH A SECOND DATE FIELD because `Date` on a remaster is the remaster's
     * year, and this library is full of them: measured across all 2,758 albums,
     * 2,726 carry OriginalDate and **940 of them disagree with `Date`**. AC/DC's
     * catalogue is dated 2020 by `Date` and 1976-1990 by this one; `Back in
     * Black` is 2003 against 1980. An "albums by year" screen built on `Date`
     * would be wrong for a third of the library and would contradict the year
     * written on the folder on disk.
     *
     * Free text like `date`, and absent rather than guessed when untagged.
     */
    originalDate?: string;
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

/*
 * BROWSING THE LIBRARY
 *
 * Three screens, three GETs: artists, then one artist's albums, then one album's
 * tracks. Nothing here travels on the snapshot — the library is 37,289 songs and
 * the snapshot rule at the top of this file exists precisely to keep collections
 * that size off the event stream. These are ordinary cacheable responses.
 *
 * WHY AN ARTIST IS IDENTIFIED BY ITS AlbumArtist TAG
 *   `Artist` is the performing credit and splits an album across "Queen",
 *   "Queen & David Bowie" and so on; `AlbumArtist` is the one an album is filed
 *   under. Measured on this library: 535 Artist values against 487 AlbumArtist,
 *   and the 487 line up one-for-one with the directories on disk.
 */

/**
 * One artist in the browse list.
 *
 * NAME AND DIRECTORY ARE BOTH HERE, AND THEY ARE NOT THE SAME STRING. 48 of this
 * library's 487 artists are filed under a directory that differs from the tag —
 * `AC/DC` lives in `AC-DC` (a `/` cannot be a path segment), `Andrew W.K.` in
 * `Andrew W.K`, `CAKE` in `Cake`. The tag is what a person is shown; the
 * directory is only ever used to build `image`, and the backend learns it by
 * asking MPD for one of the artist's songs rather than by transforming the name.
 * Deriving one from the other would be wrong about one artist in ten, which is
 * the same "confidently wrong" failure that rules out guessing Bluetooth covers.
 */
export interface ArtistSummary {
    /** The `AlbumArtist` tag. This is the string to display. */
    name: string;
    /**
     * The artist's directory, relative to the music root. Display it nowhere; it
     * exists so `image` can be built and so a caller can tell two identically
     * named artists apart.
     */
    directory: string;
    albumCount: number;
    /**
     * `/api/art?album=<directory>`, or null when the artist's directory is not
     * known.
     *
     * THE SAME ENDPOINT AS ALBUM ART, deliberately. `/api/art` resolves a cover
     * inside whatever library directory it is given, and an artist directory in
     * this library holds a `folder.jpg` of the artist exactly as an album
     * directory holds one of the sleeve — 473 of 487, measured. So artist images
     * needed no new endpoint, no new filename list and no new cache.
     *
     * Like every art URI here it MAY STILL 404: 16 artists have no image file.
     * Clients show their placeholder, as they already do for the covers.
     */
    image: string | null;
}

/** One album in an artist's list, or the header of the album screen. */
export interface AlbumSummary {
    album: string;
    /** The `AlbumArtist` this album is filed under — the `name` above. */
    albumArtist: string;
    /**
     * When the album came out — `OriginalDate` where the tracks have it, falling
     * back to `Date`.
     *
     * THAT PREFERENCE IS THE POINT. `Date` is the year of the pressing, and 940
     * of this library's 2,758 albums are remasters whose `Date` is decades after
     * the record. Sorting an artist's albums by `Date` puts AC/DC's entire
     * catalogue in 2020.
     *
     * NOT parsed to a number: free text, and it appears as `1997`, `1997-06-16`
     * and occasionally worse. Clients that want a year take the leading four
     * digits.
     *
     * Null for the albums carrying neither tag. They sort last rather than as
     * year zero.
     */
    date: string | null;
    trackCount: number;
    /** `/api/art?album=<album directory>`; may 404, as ever. */
    image: string | null;
}

export interface ArtistsResponse {
    artists: ArtistSummary[];
}

export interface AlbumsResponse {
    albumArtist: string;
    /**
     * The artist's picture, as on ArtistSummary — repeated here so the artist
     * screen is self-sufficient.
     *
     * IT CANNOT COME FROM THE ARTISTS LIST. That list is a client-side cache, and
     * this screen is reachable without it: the kiosk reloads the page on every
     * deploy, and a phone can hold a bookmark. Reading the picture out of the
     * cache meant the hero silently fell back to the placeholder whenever the
     * screen was opened directly — observed in a screenshot of the real device.
     *
     * Free to send: the backend derives it from the first path segment of a
     * track it has already fetched, so it costs no extra MPD command and no
     * index lookup.
     */
    image: string | null;
    /** Oldest first; undated albums last. */
    albums: AlbumSummary[];
}

export interface AlbumResponse {
    album: AlbumSummary;
    /**
     * The album's tracks in playing order.
     *
     * FLAT, EVEN FOR A MULTI-DISC ALBUM, but ordered by directory before track
     * number — 149 albums here keep their tracks in `CD 01`/`CD 02`/`Vinyl 01`
     * subdirectories, and sorting on the `Track` tag alone would interleave two
     * tracks both numbered 01.
     *
     * These carry no `id`: they are library songs, not queue entries, so there is
     * nothing for `POST /api/queue/play/:id` to address. Play the album.
     */
    tracks: Track[];
}

/** Names an album for the two POSTs below. */
export interface AlbumRef {
    albumArtist: string;
    album: string;
}

/*
 * PUTTING AN ALBUM IN THE QUEUE
 *
 *   POST /api/library/queue   appends it
 *   POST /api/library/play    clears the queue, adds it, starts playing
 *
 * Both take an AlbumRef and answer with a Snapshot.
 *
 * TWO ROUTES RATHER THAN ONE WITH A FLAG, because they are two different verbs:
 * one adds to what you are listening to, the other replaces it. A boolean would
 * make the destructive one the easier thing to reach by accident.
 *
 * The album is named by tag and resolved by MPD's own `findadd`, so the server
 * never enumerates tracks and the whole album is queued in one command. 409 while
 * a phone owns the DAC, for the same reason GET /api/queue is a 409 — MPD's queue
 * is not what anyone is looking at during a Bluetooth session.
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

/**
 * The SSE event name carrying the box's settings, sent once per connection and
 * again whenever they change.
 *
 * ON THE STREAM, BUT NOT ON THE SNAPSHOT. The snapshot rule at the top of this
 * file is about what the music is doing, and a setting is not that — the same
 * reason SSE_BUILD_EVENT is its own event rather than a Snapshot field. It has
 * to reach clients promptly, though: the setting can be changed from a phone and
 * the panel is the thing that has to act on it, so polling would mean the panel
 * obeying a stale answer for as long as the poll interval.
 */
export const SSE_SETTINGS_EVENT = 'settings';

/**
 * The box's settings. Payload of SSE_SETTINGS_EVENT, and the body of
 * GET/PATCH /api/settings.
 *
 * Distinct from the frontend's own preferences, which are per-device and live in
 * that browser's localStorage. These describe the BOX: there is one panel, and
 * its behaviour should not depend on which phone last looked at it.
 */
export interface SettingsResponse {
    /**
     * Minutes of no interaction before the panel's backlight goes off; 0 is
     * never. Honoured only while nothing is playing.
     */
    panelSleepAfterMinutes: number;
}

/**
 * The delays the panel-sleep setting may take, in minutes, 0 being never.
 *
 * ONE LIST, SHARED. The dropdown renders it and the backend guard validates
 * against it, so a value the UI cannot offer is also a value the box will not
 * store. It matches the frontend's own idle options deliberately — the two
 * settings read as a pair on screen and would look arbitrary if they differed.
 */
export const PANEL_SLEEP_MINUTES: readonly number[] = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20,
];

/**
 * What the panel's backlight is doing.
 *
 * `supported` is false wherever there is no backlight to drive — every dev
 * machine, and any box whose panel does not expose one. The UI uses it to say
 * so rather than offering a setting that silently does nothing.
 */
export interface PanelState {
    supported: boolean;
    /** True when the backlight is on. Always true when `supported` is false. */
    on: boolean;
}
