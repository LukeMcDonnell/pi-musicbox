/**
 * HTTP API.
 *
 * Commands are ordinary REST; state arrives over SSE. Every SSE message is a
 * COMPLETE snapshot — see src/shared/api.ts for why there are no deltas.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
    PLAYBACK_COMMANDS,
    SSE_SNAPSHOT_EVENT,
    SSE_BUILD_EVENT,
    SSE_SETTINGS_EVENT,
    SSE_LIBRARY_EVENT,
    SSE_FAVOURITES_EVENT,
    SSE_PLAYS_EVENT,
    API_VERSION,
    BACKUP_CONTENT_TYPE,
    BACKUP_MAX_BYTES,
    RECENTLY_ADDED_LIMIT,
    RECENTLY_ADDED_MAX,
    RECENT_PLAYS_LIMIT,
    RECENT_PLAYS_MAX,
    type AlbumResponse,
    type AlbumRef,
    type AlbumsResponse,
    type ArtistsResponse,
    type FavouriteAlbum,
    type FavouritesResponse,
    type HealthResponse,
    type LibraryState,
    type PanelState,
    type PlaybackCommand,
    type RecentlyAddedResponse,
    type RecentPlayAlbum,
    type RecentPlaysResponse,
    type RestoreResponse,
    type SettingsResponse,
    type Snapshot,
} from '../../shared/api.ts';
import type { MpdBridge } from './mpd/bridge.ts';
import { quoteArg } from './mpd/protocol.ts';
import { createArtHandler, createArtResolver } from './art.ts';
import { albumsFromSongs, createLibrary } from './library.ts';
import {
    BluetoothUnavailableError,
    DEFAULT_CONTROL_PATH,
    sendControl,
    type ControlVerb,
} from './bluetooth.ts';
import type { Panel } from './panel.ts';
import { PowerUnavailableError, isPowerAction, type Power } from './power.ts';
import { isSettingKey, parseSetting, type Settings, type SettingsValues } from './settings.ts';
import { ScanRefusedError, type LibraryScanner } from './library-scan.ts';
import { BackupError, type Backups } from './backup.ts';
import type { Favourites } from './favourites.ts';
import type { Plays } from './plays.ts';

/** How often to send an SSE comment so idle proxies and dead clients are noticed. */
const SSE_HEARTBEAT_MS = 15_000;

/**
 * Whether a request came from the box itself — which is how the panel is known.
 *
 * The kiosk loads http://localhost/ (install/setup-kiosk.sh), so its stream is
 * the loopback one and a phone's never is. The frontend decides it is the panel
 * from exactly the same fact, seen from the other side (on-screen-keyboard.ts).
 *
 * Nothing is granted by this — it decides whether the box may darken its OWN
 * screen, and the worst a spoofed answer achieves is a backlight left on.
 */
export function isLoopback(ip: string | undefined): boolean {
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export interface RouteOptions {
    bridge: MpdBridge;
    build: string;
    startedAt: number;
    /** Music library root, for cover art lookups. See config.musicRoot. */
    musicRoot: string;
    /** The arbiter's control FIFO. See config.bluetoothControl. */
    bluetoothControl?: string;
    /** The panel's backlight. Absent on a build with no panel support wired up. */
    panel?: Panel;
    /** The box's settings store. See settings.ts for what belongs in it. */
    settings?: Settings;
    /** Restart and shutdown, via the root path unit. See power.ts. */
    power?: Power;
    /** Library scanning and its history. See library-scan.ts. */
    scanner?: LibraryScanner;
    /** Backup and restore of MPD's state and the database. See backup.ts. */
    backups?: Backups;
    /** Favourite albums. See favourites.ts. */
    favourites?: Favourites;
    /** What the box has played. See plays.ts; play-watch.ts is what fills it. */
    plays?: Plays;
}

/** Handle returned by registerRoutes so the server can shut down cleanly. */
export interface RouteHandle {
    /**
     * End every open SSE stream.
     *
     * Fastify's close() waits for connections to finish, and an SSE stream never
     * does — so without this a single connected client (the kiosk always has
     * one) wedges shutdown until systemd's stop timeout fires.
     */
    closeStreams: () => void;
}

/** MPD commands for each API verb. `previous` is spelled `previous` in MPD too. */
const COMMAND_MAP: Record<PlaybackCommand, string> = {
    play: 'play',
    pause: 'pause 1',
    stop: 'stop',
    next: 'next',
    previous: 'previous',
};

/**
 * The same verbs, for the Bluetooth arbiter.
 *
 * A second exhaustive `Record<PlaybackCommand, …>` on purpose: adding a command
 * to PLAYBACK_COMMANDS now fails to compile until BOTH sources handle it. That
 * exhaustiveness is the only thing standing between this route and a command
 * that silently does nothing for one source.
 */
const BLUETOOTH_COMMAND_MAP: Record<PlaybackCommand, ControlVerb> = {
    play: 'play',
    pause: 'pause',
    stop: 'stop',
    next: 'next',
    previous: 'previous',
};

function sseFrame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function registerRoutes(app: FastifyInstance, opts: RouteOptions): RouteHandle {
    const { bridge, build, startedAt, musicRoot } = opts;
    const controlPath = opts.bluetoothControl ?? DEFAULT_CONTROL_PATH;

    /** Every live SSE stream, so shutdown can end them. */
    const streams = new Set<() => void>();

    /**
     * The subset of those streams belonging to the panel itself.
     *
     * The backlight may only be held off while at least one of these is open.
     * The panel's renderer crashing is an open issue (.claude/docs/roadmap.md),
     * and a crash with the backlight off would leave a box that looks dead; its
     * stream dies with it, which is the signal to light the screen again.
     */
    const panelStreams = new Set<() => void>();

    const panel = opts.panel;
    const settings = opts.settings;
    const power = opts.power;

    const favourites = opts.favourites;
    const favouritesSinks = new Set<(albums: FavouriteAlbum[]) => void>();
    favourites?.onChange((albums) => {
        for (const sink of [...favouritesSinks]) sink(albums);
    });

    const plays = opts.plays;
    const playsSinks = new Set<(albums: RecentPlayAlbum[]) => void>();
    plays?.onChange((albums) => {
        for (const sink of [...playsSinks]) sink(albums);
    });

    /** Sinks for the settings event, one per open stream. */
    const settingsSinks = new Set<(values: SettingsValues) => void>();
    settings?.onChange((values) => {
        for (const sink of [...settingsSinks]) sink(values);
    });

    /** The same, for the library event. */
    const librarySinks = new Set<(state: LibraryState) => void>();
    const scanner = opts.scanner;
    scanner?.onChange((state) => {
        for (const sink of [...librarySinks]) sink(state);
    });

    const panelState = (): PanelState => ({
        supported: panel?.supported ?? false,
        // Unsupported reads as on: there is no dark screen to report.
        on: panel?.isOn() ?? true,
    });

    /** Light the panel again because nothing is left that could be looking at it. */
    const restorePanel = (): void => {
        if (!panel?.supported || panel.isOn()) return;
        panel.set(true);
        app.log.info('panel backlight restored — no panel client is connected');
    };

    // Health must never depend on MPD: it answers whether the SERVER is up.
    // Reporting MPD here is informational, which is what lets the deploy loop
    // poll this endpoint while MPD is stopped.
    app.get('/api/health', async (): Promise<HealthResponse> => {
        return {
            ok: true,
            build,
            apiVersion: API_VERSION,
            uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
            mpd: bridge.status,
        };
    });

    // Refreshed, not cached. MPD's `idle` does not fire as elapsed time advances,
    // so bridge.current can be minutes old — fine for a live SSE client, which
    // interpolates from when it received the frame, but wrong for a one-shot GET.
    app.get('/api/status', async (): Promise<Snapshot> => {
        await bridge.refresh();
        return bridge.current;
    });

    /**
     * The MPD queue.
     *
     * 409, not an empty list, while a phone is the source. A phone has no
     * readable track list at all — AVRCP browsing is not exposed by BlueZ — and
     * an empty array would be indistinguishable from "nothing queued", which is a
     * different and answerable state. The snapshot says the same thing more
     * cheaply with `queueVersion: -1`, so a well-behaved client never gets here.
     */
    app.get('/api/queue', async (_req: FastifyRequest, reply: FastifyReply) => {
        if (bridge.current.source === 'bluetooth') {
            return reply.code(409).send({
                error: 'no queue for the bluetooth source — a phone exposes no track list',
            });
        }
        try {
            return await bridge.queue();
        } catch (err) {
            return reply.code(503).send({ error: (err as Error).message });
        }
    });

    /**
     * Jump playback to one track in the queue.
     *
     * BY SONG ID, NOT POSITION. A position is only valid until somebody reorders
     * the queue, and the listing a phone is looking at may be seconds old by the
     * time a finger lands on it; MPD's song id survives a reorder. See the
     * `queuePosition` note in src/shared/api.ts.
     *
     * NOT a PLAYBACK_COMMANDS verb, deliberately — those are the ones both
     * sources implement, and a phone has no addressable track list. 409 here for
     * the same reason GET /api/queue is a 409.
     */
    app.post('/api/queue/play/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        if (bridge.current.source === 'bluetooth') {
            return reply.code(409).send({
                error: 'cannot play a queue track while a phone owns the DAC',
            });
        }
        const { id } = request.params as { id: string };
        /*
         * Digits only, tested as a STRING before conversion. This value is
         * interpolated into an MPD command line, so the check is load-bearing
         * rather than defensive — and Number() is far too generous to be it:
         * Number('') is 0, so an empty segment would have played song 0, and
         * '1e2' and '0x10' are both integers to it too.
         */
        if (!/^\d+$/.test(id)) {
            return reply.code(400).send({ error: `invalid song id '${id}'` });
        }
        try {
            await bridge.command(`playid ${Number(id)}`);
            return bridge.current;
        } catch (err) {
            return reply.code(503).send({ error: (err as Error).message });
        }
    });

    app.post('/api/playback/:command', async (request: FastifyRequest, reply: FastifyReply) => {
        const { command } = request.params as { command: string };
        if (!(PLAYBACK_COMMANDS as readonly string[]).includes(command)) {
            return reply.code(400).send({
                error: `unknown command '${command}', expected one of ${PLAYBACK_COMMANDS.join(', ')}`,
            });
        }
        /*
         * Whichever source owns the DAC gets the command. There is deliberately no
         * way to address the other one: the buttons mean "control what I am
         * hearing", and a phone that is playing is what you are hearing.
         *
         * Pressing play used to be how you took the speaker back from a phone —
         * it started MPD, and the arbiter noticed and disconnected. That is now
         * POST /api/bluetooth/disconnect, an explicit action rather than a side
         * effect of a button that appears to mean something else.
         */
        if (bridge.current.source === 'bluetooth') {
            try {
                await sendControl(BLUETOOTH_COMMAND_MAP[command as PlaybackCommand], controlPath);
                // No refreshed snapshot to return: AVRCP takes seconds to settle
                // and the truth arrives over SSE. Answering with the current
                // snapshot would state the old value as though it were the new one.
                return reply.code(202).send({ accepted: command });
            } catch (err) {
                if (err instanceof BluetoothUnavailableError) {
                    return reply.code(503).send({ error: err.message });
                }
                throw err;
            }
        }

        try {
            await bridge.command(COMMAND_MAP[command as PlaybackCommand]);
            return bridge.current;
        } catch (err) {
            return reply.code(503).send({ error: (err as Error).message });
        }
    });

    /**
     * End the Bluetooth session and give the DAC back to MPD.
     *
     * NOT a playback command, which is why it is not in PLAYBACK_COMMANDS: it
     * changes which source exists, not what that source is doing.
     *
     * MPD is left PAUSED, exactly as it is when a phone wanders out of range. It
     * keeps its position, so the next press of play resumes in place — but the box
     * does not start playing to an empty room because somebody tidied up.
     */
    app.post('/api/bluetooth/disconnect', async (_req: FastifyRequest, reply: FastifyReply) => {
        if (bridge.current.source !== 'bluetooth') {
            return reply.code(409).send({ error: 'no bluetooth device is connected' });
        }
        try {
            await sendControl('disconnect', controlPath);
            return reply.code(202).send({ accepted: 'disconnect' });
        } catch (err) {
            if (err instanceof BluetoothUnavailableError) {
                return reply.code(503).send({ error: err.message });
            }
            throw err;
        }
    });

    /**
     * Cover art. The resolver is created once so its cache — including its
     * negative entries — lives for the life of the process rather than the
     * request. Track.image points here; see src/backend/src/art.ts.
     */
    app.get('/api/art', createArtHandler(createArtResolver(musicRoot)));

    /*
     * LIBRARY BROWSE
     *
     * Read-only listings from MPD's tag database, plus the two ways to put an
     * album in the queue. Everything is addressed by QUERY PARAMETER rather than
     * by path segment, for the reason /api/art already is: `AC/DC` is a real
     * artist and album titles contain `/` too, so the identity would have to
     * travel as `%2F`, which routers and proxies are entitled to normalise back.
     *
     * These routes are appended after /api/art deliberately. Three tests in
     * routes.test.ts assert on the SOURCE TEXT of this file, slicing between
     * route literals — inserting a route between two existing ones silently
     * changes what they assert.
     */

    const library = createLibrary(bridge);

    /*
     * A database scan invalidates the index.
     *
     * Via onIdle rather than onSnapshot: a snapshot says nothing about the
     * library, deliberately, so the fact that the song database changed has
     * nowhere else to travel. The index is dropped, not rebuilt — the next
     * request pays the ~200ms, and on a box where `auto_update` is off that
     * request may be days away.
     *
     * `mpc update` on a library this size takes the better part of an hour, and
     * `update` fires at both ends of it. Invalidating twice is free.
     */
    bridge.onIdle((subsystems) => {
        if (subsystems.includes('database') || subsystems.includes('update')) {
            library.invalidate();
        }
    });

    /** Every artist in the library, in MPD's own AlbumArtist order. */
    app.get('/api/library/artists', async (_req: FastifyRequest, reply: FastifyReply) => {
        try {
            const artists = await library.artists();
            const body: ArtistsResponse = { artists };
            return body;
        } catch (err) {
            return reply.code(503).send({ error: (err as Error).message });
        }
    });

    /** One artist's albums, oldest first. */
    app.get('/api/library/albums', async (request: FastifyRequest, reply: FastifyReply) => {
        const { artist } = request.query as { artist?: string };
        if (artist === undefined || artist === '') {
            return reply.code(400).send({ error: "missing 'artist' query parameter" });
        }
        try {
            const { image, albums } = await library.albumsOf(artist);
            const body: AlbumsResponse = { albumArtist: artist, image, albums };
            return body;
        } catch (err) {
            return reply.code(503).send({ error: (err as Error).message });
        }
    });

    /** One album: its header and its tracks in playing order. */
    app.get('/api/library/album', async (request: FastifyRequest, reply: FastifyReply) => {
        const { artist, album } = request.query as { artist?: string; album?: string };
        if (artist === undefined || artist === '') {
            return reply.code(400).send({ error: "missing 'artist' query parameter" });
        }
        if (album === undefined || album === '') {
            return reply.code(400).send({ error: "missing 'album' query parameter" });
        }
        try {
            const songs = await library.songsOf(artist, album);
            if (songs.length === 0) {
                return reply.code(404).send({ error: 'no such album' });
            }
            // Built from the tracks just fetched rather than by asking again:
            // the header's date, cover, count, genres and running time are all
            // facts about these very rows, and a second query could disagree.
            const [summary] = albumsFromSongs(artist, songs);
            favourites?.refresh(summary);
            const body: AlbumResponse = { album: summary, tracks: songs.map((s) => s.track) };
            return body;
        } catch (err) {
            return reply.code(503).send({ error: (err as Error).message });
        }
    });

    /**
     * Read an AlbumRef off a request body.
     *
     * Both fields are checked as STRINGS before they go anywhere near MPD. They
     * are interpolated into a command line — `quoteArg` escapes them, but a
     * non-string would reach it as `[object Object]` or `undefined` and quietly
     * match nothing, which looks to a user like a button that does not work.
     * Same standard as the `/^\d+$/` on a song id.
     */
    function albumRefFrom(body: unknown): AlbumRef | string {
        const ref = (body ?? {}) as { albumArtist?: unknown; album?: unknown; disc?: unknown };
        if (typeof ref.albumArtist !== 'string' || ref.albumArtist === '') {
            return "missing 'albumArtist'";
        }
        if (typeof ref.album !== 'string' || ref.album === '') return "missing 'album'";
        // Optional, but held to the same standard once supplied: `disc: 1` would
        // reach quoteArg as "1" and happen to work, and `disc: {}` as
        // "[object Object]" and silently match nothing.
        if (ref.disc === undefined) return { albumArtist: ref.albumArtist, album: ref.album };
        if (typeof ref.disc !== 'string' || ref.disc === '') return "invalid 'disc'";
        return { albumArtist: ref.albumArtist, album: ref.album, disc: ref.disc };
    }

    /**
     * MPD's own `findadd` — the whole album in ONE command.
     *
     * The alternative was fetching the track list and adding it a song at a
     * time, which is a round trip per track and bumps `queueVersion` once per
     * track with it: a client watching that version would refetch the whole
     * listing a dozen times for one button press. MusicboxApi has a sequence
     * guard against exactly that, and this makes it unnecessary.
     */
    function findaddFor(ref: AlbumRef): string {
        const album = `findadd ${quoteArg('albumartist')} ${quoteArg(ref.albumArtist)} ${quoteArg('album')} ${quoteArg(ref.album)}`;
        // One more filter pair narrows it to a disc. MPD indexes `Disc`, so this
        // is the same one command whether it adds 48 tracks or 17.
        return ref.disc === undefined
            ? album
            : `${album} ${quoteArg('disc')} ${quoteArg(ref.disc)}`;
    }

    /**
     * Append an album to the queue.
     *
     * 409 while a phone owns the DAC, exactly as GET /api/queue is. MPD's queue
     * is not what anyone is listening to during a Bluetooth session, so adding
     * to it silently would be a button that appears to do nothing.
     */
    app.post('/api/library/queue', async (request: FastifyRequest, reply: FastifyReply) => {
        const ref = albumRefFrom(request.body);
        if (typeof ref === 'string') return reply.code(400).send({ error: ref });
        if (bridge.current.source === 'bluetooth') {
            return reply.code(409).send({
                error: 'cannot queue an album while a phone owns the DAC',
            });
        }
        try {
            await bridge.runAll([findaddFor(ref)]);
            return bridge.current;
        } catch (err) {
            return reply.code(503).send({ error: (err as Error).message });
        }
    });

    /**
     * Replace the queue with an album and play it.
     *
     * THREE COMMANDS, ONE REFRESH — see MpdBridge.runAll. `clear` then `findadd`
     * then `play`, rather than `findadd` then seeking: the button means "play
     * this album", and leaving the previous queue underneath would make the next
     * track a surprise.
     *
     * Separate from the queue route rather than a flag on it, because this one
     * throws away what you were listening to and that should not be reachable by
     * passing `false`.
     */
    app.post('/api/library/play', async (request: FastifyRequest, reply: FastifyReply) => {
        const ref = albumRefFrom(request.body);
        if (typeof ref === 'string') return reply.code(400).send({ error: ref });
        if (bridge.current.source === 'bluetooth') {
            return reply.code(409).send({
                error: 'cannot play an album while a phone owns the DAC',
            });
        }
        try {
            await bridge.runAll(['clear', findaddFor(ref), 'play']);
            return bridge.current;
        } catch (err) {
            return reply.code(503).send({ error: (err as Error).message });
        }
    });

    /**
     * SSE stream. Sends the current snapshot immediately on connect, so a client
     * is correct from its first frame without a separate /api/status call, then
     * a fresh full snapshot on every change.
     */
    app.get('/api/events', async (request: FastifyRequest, reply: FastifyReply) => {
        const fromPanel = isLoopback(request.ip);
        reply.raw.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            // Proxies that buffer would defeat the whole point of streaming.
            'x-accel-buffering': 'no',
        });

        const send = (snapshot: Snapshot) => {
            reply.raw.write(sseFrame(SSE_SNAPSHOT_EVENT, snapshot));
        };

        // State the build before anything else. A client that has seen a
        // different one reloads itself — without this the kiosk, which never
        // navigates after boot, runs a stale bundle forever after a deploy.
        // See SSE_BUILD_EVENT in src/shared/api.ts.
        reply.raw.write(sseFrame(SSE_BUILD_EVENT, { build }));

        // The box's settings, before the first snapshot. The panel acts on them
        // and they can be changed from a phone, so they travel on the stream
        // rather than being polled — see SSE_SETTINGS_EVENT in shared/api.ts.
        const sendSettings = (values: SettingsValues) => {
            reply.raw.write(sseFrame(SSE_SETTINGS_EVENT, values));
        };
        if (settings) {
            sendSettings(settings.all());
            settingsSinks.add(sendSettings);
        }

        // The library, on the same terms. The CACHED state deliberately: the
        // fresh one probes the music share, and an unreachable NAS would then
        // hold up every client's first frame for as long as the probe takes.
        const sendLibrary = (state: LibraryState) => {
            reply.raw.write(sseFrame(SSE_LIBRARY_EVENT, state));
        };
        if (scanner) {
            sendLibrary(scanner.state());
            librarySinks.add(sendLibrary);
        }

        const sendFavourites = (albums: FavouriteAlbum[]) => {
            const body: FavouritesResponse = { albums };
            reply.raw.write(sseFrame(SSE_FAVOURITES_EVENT, body));
        };
        if (favourites) {
            sendFavourites(favourites.all());
            favouritesSinks.add(sendFavourites);
        }

        const sendPlays = (albums: RecentPlayAlbum[]) => {
            const body: RecentPlaysResponse = { albums };
            reply.raw.write(sseFrame(SSE_PLAYS_EVENT, body));
        };
        if (plays) {
            sendPlays(plays.recentAlbums(RECENT_PLAYS_LIMIT));
            playsSinks.add(sendPlays);
        }

        // The FIRST frame must be freshly queried, not bridge.current.
        //
        // MPD's `idle` never fires merely because elapsed time advanced, so the
        // cached snapshot's `elapsed` dates from the last real event — a resume,
        // a seek, a track change. A client interpolates from the moment it
        // received the frame, so handing it a stale snapshot makes it count up
        // from that old position: refresh the page after pausing and resuming and
        // the UI shows the resume position as though it were now.
        //
        // Fixed here rather than by having the client trust snapshot.serverTime,
        // because that would require a phone's clock to agree with the Pi's.
        await bridge.refresh();
        send(bridge.current);
        const unsubscribe = bridge.onSnapshot(send);

        const heartbeat = setInterval(() => {
            reply.raw.write(`: keep-alive\n\n`);
        }, SSE_HEARTBEAT_MS);

        const cleanup = () => {
            clearInterval(heartbeat);
            unsubscribe();
            settingsSinks.delete(sendSettings);
            librarySinks.delete(sendLibrary);
            favouritesSinks.delete(sendFavourites);
            playsSinks.delete(sendPlays);
            streams.delete(close);
            if (fromPanel) {
                panelStreams.delete(close);
                // The last thing that could have been looking at a dark screen
                // has gone: a crashed renderer, a reload, or a shutdown.
                if (panelStreams.size === 0) restorePanel();
            }
        };
        const close = () => {
            cleanup();
            reply.raw.end();
        };
        streams.add(close);
        if (fromPanel) panelStreams.add(close);

        request.raw.on('close', cleanup);
        request.raw.on('error', cleanup);
    });

    // -----------------------------------------------------------------------
    // The panel and the box's settings.
    //
    // APPENDED AFTER /api/events DELIBERATELY. Three tests in routes.test.ts
    // assert on the SOURCE TEXT of this file, slicing it between route literals;
    // a route inserted between two existing ones silently changes what they
    // assert rather than failing. Add new routes here, at the end.
    // -----------------------------------------------------------------------

    app.get('/api/panel', async (): Promise<PanelState> => panelState());

    /**
     * Turn the panel's backlight on or off.
     *
     * A DUMB ACTUATOR. The decision belongs to the panel's own browser, which is
     * the only thing that can see a touch; it also knows whether music is
     * playing, from the snapshot it already has. See panel-sleep on the frontend.
     */
    app.post('/api/panel/backlight', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!panel?.supported) {
            return reply.code(503).send({ error: 'this box has no panel backlight' });
        }
        const body = request.body as { on?: unknown } | undefined;
        if (typeof body?.on !== 'boolean') {
            return reply.code(400).send({ error: 'on must be true or false' });
        }
        // Only the panel may put the panel to sleep, and only while it is still
        // there to wake it: a phone that darkened a screen it cannot see, or a
        // renderer that died mid-request, would leave the box looking broken.
        if (!body.on && !isLoopback(request.ip)) {
            return reply.code(409).send({ error: 'only the panel itself may sleep the panel' });
        }
        if (!body.on && panelStreams.size === 0) {
            return reply.code(409).send({ error: 'no panel client is connected' });
        }
        if (!panel.set(body.on)) {
            return reply.code(503).send({ error: 'the backlight could not be written' });
        }
        return panelState();
    });

    app.get('/api/settings', async (_request: FastifyRequest, reply: FastifyReply) => {
        if (!settings) return reply.code(503).send({ error: 'settings are unavailable' });
        return settings.all() as SettingsResponse;
    });

    /**
     * Change one or more settings.
     *
     * PATCH, not PUT: a client sends what it is changing, never the whole set,
     * so two clients editing different settings cannot clobber each other.
     */
    app.patch('/api/settings', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!settings) return reply.code(503).send({ error: 'settings are unavailable' });
        const body = request.body;
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            return reply.code(400).send({ error: 'body must be an object of settings' });
        }

        const entries = Object.entries(body as Record<string, unknown>);
        if (entries.length === 0) {
            return reply.code(400).send({ error: 'no settings given' });
        }

        // Validate EVERYTHING before writing ANYTHING: a half-applied patch is a
        // box in a state no client asked for.
        const pending: [keyof SettingsValues, SettingsValues[keyof SettingsValues]][] = [];
        for (const [key, value] of entries) {
            if (!isSettingKey(key)) {
                return reply.code(400).send({ error: `unknown setting: ${key}` });
            }
            const parsed = parseSetting(key, value);
            if (parsed === undefined) {
                return reply.code(400).send({ error: `invalid value for ${key}` });
            }
            pending.push([key, parsed]);
        }

        let values = settings.all();
        for (const [key, value] of pending) values = settings.set(key, value);
        return values as SettingsResponse;
    });

    /**
     * Restart or shut the box down.
     *
     * 202, like the Bluetooth commands: the request is written and root acts on
     * it a moment later. There is no success to report — if it works, this
     * process is about to be killed by systemd.
     *
     * NOT restricted to the panel. The power button is in the settings header on
     * every client, and shutting the box down from a phone is the point of
     * having it there. The LAN is the trust boundary for this API, as it is for
     * every other route here.
     */
    app.post('/api/power/:action', async (request: FastifyRequest, reply: FastifyReply) => {
        const { action } = request.params as { action: string };
        if (!isPowerAction(action)) {
            return reply.code(400).send({ error: `unknown power action: ${action}` });
        }
        if (!power) {
            return reply.code(503).send({ error: 'power control is not configured' });
        }
        try {
            await power.request(action);
        } catch (err) {
            if (err instanceof PowerUnavailableError) {
                return reply.code(503).send({ error: err.message });
            }
            throw err;
        }
        app.log.warn(`${action} requested over the API`);
        return reply.code(202).send({ accepted: action });
    });

    // -----------------------------------------------------------------------
    // Scanning the library. APPENDED AT THE END for the reason given above the
    // panel routes: routes.test.ts slices this file's source text between route
    // literals, so a route inserted higher up silently changes what it asserts.
    // -----------------------------------------------------------------------

    /** What the library holds, when it was last scanned, and whether one is running. */
    app.get('/api/library/state', async (_request: FastifyRequest, reply: FastifyReply) => {
        if (!scanner) return reply.code(503).send({ error: 'library scanning is unavailable' });
        // The fresh state, unlike the one on the stream: this is a client asking
        // the question, so it can wait for the share to be probed.
        return scanner.refresh();
    });

    /**
     * Scan for what changed.
     *
     * 202: this runs for the better part of an hour on the real library, so
     * there is nothing to wait for. Progress arrives on the SSE stream.
     */
    app.post('/api/library/scan', async (_request: FastifyRequest, reply: FastifyReply) => {
        if (!scanner) return reply.code(503).send({ error: 'library scanning is unavailable' });
        try {
            await scanner.scan('manual');
        } catch (err) {
            if (err instanceof ScanRefusedError) {
                return reply.code(err.code).send({ error: err.message });
            }
            throw err;
        }
        return reply.code(202).send({ accepted: 'scan' });
    });

    /** Re-read every tag, not just what changed. Its own route, not a flag on the above. */
    app.post('/api/library/rescan', async (_request: FastifyRequest, reply: FastifyReply) => {
        if (!scanner) return reply.code(503).send({ error: 'library scanning is unavailable' });
        try {
            await scanner.scan('rescan');
        } catch (err) {
            if (err instanceof ScanRefusedError) {
                return reply.code(err.code).send({ error: err.message });
            }
            throw err;
        }
        return reply.code(202).send({ accepted: 'rescan' });
    });

    // -----------------------------------------------------------------------
    // Backup and restore. Appended for the same reason as the scan routes.
    // -----------------------------------------------------------------------

    app.get('/api/backup', async (_request: FastifyRequest, reply: FastifyReply) => {
        const backups = opts.backups;
        if (!backups) return reply.code(503).send({ error: 'backups are unavailable' });
        try {
            const { filename, archive } = await backups.create();
            return reply
                .type(BACKUP_CONTENT_TYPE)
                .header('content-disposition', `attachment; filename="${filename}"`)
                .header('cache-control', 'no-store')
                .send(archive);
        } catch (err) {
            if (err instanceof BackupError) return reply.code(err.code).send({ error: err.message });
            throw err;
        }
    });

    // Scoped to this route's content type; nothing else accepts a gzip body.
    app.addContentTypeParser(
        BACKUP_CONTENT_TYPE,
        { parseAs: 'buffer', bodyLimit: BACKUP_MAX_BYTES },
        (_request, body, done) => done(null, body),
    );

    /**
     * Replace MPD's state and the database with an uploaded backup.
     *
     * 202: root's helper stops MPD and this server, swaps the files and starts
     * both again, so the client learns it worked by reconnecting.
     */
    app.post(
        '/api/restore',
        { bodyLimit: BACKUP_MAX_BYTES },
        async (request: FastifyRequest, reply: FastifyReply) => {
            const backups = opts.backups;
            if (!backups) return reply.code(503).send({ error: 'backups are unavailable' });
            if (!Buffer.isBuffer(request.body)) {
                return reply.code(400).send({ error: `body must be ${BACKUP_CONTENT_TYPE}` });
            }
            // Restarting MPD mid-scan leaves a partial library database.
            if (opts.scanner?.state().scanning) {
                return reply.code(409).send({ error: 'a library scan is running — try again when it finishes' });
            }
            if (bridge.current.source === 'bluetooth') {
                return reply.code(409).send({ error: 'a phone is playing over Bluetooth — disconnect it first' });
            }
            try {
                await backups.restore(request.body);
            } catch (err) {
                if (err instanceof BackupError) return reply.code(err.code).send({ error: err.message });
                throw err;
            }
            app.log.warn('restore requested over the API');
            const body: RestoreResponse = { accepted: 'restore' };
            return reply.code(202).send(body);
        },
    );

    // -----------------------------------------------------------------------
    // Favourite albums. Appended for the same reason as the scan routes.
    // -----------------------------------------------------------------------

    function albumQuery(query: unknown): { artist: string; album: string } | string {
        const { artist, album } = (query ?? {}) as { artist?: unknown; album?: unknown };
        if (typeof artist !== 'string' || artist === '') return "missing 'artist' query parameter";
        if (typeof album !== 'string' || album === '') return "missing 'album' query parameter";
        return { artist, album };
    }

    app.get('/api/favourites', async (_request: FastifyRequest, reply: FastifyReply) => {
        if (!favourites) return reply.code(503).send({ error: 'favourites are unavailable' });
        const body: FavouritesResponse = { albums: favourites.all() };
        return body;
    });

    /** The summary is read from MPD, so only an album the library has can be added. */
    app.put('/api/favourites/album', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!favourites) return reply.code(503).send({ error: 'favourites are unavailable' });
        const ref = albumQuery(request.query);
        if (typeof ref === 'string') return reply.code(400).send({ error: ref });
        let songs: Awaited<ReturnType<typeof library.songsOf>>;
        try {
            songs = await library.songsOf(ref.artist, ref.album);
        } catch (err) {
            return reply.code(503).send({ error: (err as Error).message });
        }
        if (songs.length === 0) return reply.code(404).send({ error: 'no such album' });
        const [summary] = albumsFromSongs(ref.artist, songs);
        const body: FavouritesResponse = { albums: favourites.add(summary) };
        return body;
    });

    app.delete('/api/favourites/album', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!favourites) return reply.code(503).send({ error: 'favourites are unavailable' });
        const ref = albumQuery(request.query);
        if (typeof ref === 'string') return reply.code(400).send({ error: ref });
        const body: FavouritesResponse = { albums: favourites.remove(ref.artist, ref.album) };
        return body;
    });

    // -----------------------------------------------------------------------
    // Recently added. Appended for the same reason as the routes above.
    // -----------------------------------------------------------------------

    app.get('/api/library/recent', async (request: FastifyRequest, reply: FastifyReply) => {
        const { limit } = request.query as { limit?: unknown };
        let count = RECENTLY_ADDED_LIMIT;
        if (limit !== undefined && limit !== '') {
            // The whole string, so '5x' and '2.5' are refused rather than read as 5 and 2.
            if (typeof limit !== 'string' || !/^\d+$/.test(limit)) {
                return reply.code(400).send({ error: "'limit' must be a whole number" });
            }
            count = Number(limit);
            if (count < 1 || count > RECENTLY_ADDED_MAX) {
                return reply.code(400).send({ error: `'limit' must be between 1 and ${RECENTLY_ADDED_MAX}` });
            }
        }
        try {
            const body: RecentlyAddedResponse = { albums: await library.recentlyAdded(count) };
            return body;
        } catch (err) {
            return reply.code(503).send({ error: (err as Error).message });
        }
    });

    // -----------------------------------------------------------------------
    // Recent plays. Appended for the same reason as the routes above.
    // -----------------------------------------------------------------------

    app.get('/api/plays/recent', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!plays) return reply.code(503).send({ error: 'recent plays are unavailable' });
        const { limit } = request.query as { limit?: unknown };
        let count = RECENT_PLAYS_LIMIT;
        if (limit !== undefined && limit !== '') {
            // The whole string, so '5x' and '2.5' are refused rather than read as 5 and 2.
            if (typeof limit !== 'string' || !/^\d+$/.test(limit)) {
                return reply.code(400).send({ error: "'limit' must be a whole number" });
            }
            count = Number(limit);
            if (count < 1 || count > RECENT_PLAYS_MAX) {
                return reply.code(400).send({ error: `'limit' must be between 1 and ${RECENT_PLAYS_MAX}` });
            }
        }
        const body: RecentPlaysResponse = { albums: plays.recentAlbums(count) };
        return body;
    });

    return {
        closeStreams: () => {
            for (const close of [...streams]) {
                try {
                    close();
                } catch {
                    // A stream already torn down by the client; nothing to do.
                }
            }
            streams.clear();
        },
    };
}
