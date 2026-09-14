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
    API_VERSION,
    type AlbumResponse,
    type AlbumsResponse,
    type ArtistsResponse,
    type HealthResponse,
    type PlaybackCommand,
    type Snapshot,
} from '../../shared/api.ts';
import type { MpdBridge } from './mpd/bridge.ts';
import { quoteArg } from './mpd/protocol.ts';
import { createArtHandler, createArtResolver } from './art.ts';
import { albumsFromTracks, createLibrary } from './library.ts';
import {
    BluetoothUnavailableError,
    DEFAULT_CONTROL_PATH,
    sendControl,
    type ControlVerb,
} from './bluetooth.ts';

/** How often to send an SSE comment so idle proxies and dead clients are noticed. */
const SSE_HEARTBEAT_MS = 15_000;

export interface RouteOptions {
    bridge: MpdBridge;
    build: string;
    startedAt: number;
    /** Music library root, for cover art lookups. See config.musicRoot. */
    musicRoot: string;
    /** The arbiter's control FIFO. See config.bluetoothControl. */
    bluetoothControl?: string;
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
            const tracks = await library.tracksOf(artist, album);
            if (tracks.length === 0) {
                return reply.code(404).send({ error: 'no such album' });
            }
            // Built from the tracks just fetched rather than by asking again:
            // the header's date, cover and count are all facts about these very
            // rows, and a second query could disagree with them.
            const [summary] = albumsFromTracks(artist, tracks);
            const body: AlbumResponse = { album: summary, tracks };
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
    function albumRefFrom(body: unknown): { albumArtist: string; album: string } | string {
        const ref = (body ?? {}) as { albumArtist?: unknown; album?: unknown };
        if (typeof ref.albumArtist !== 'string' || ref.albumArtist === '') {
            return "missing 'albumArtist'";
        }
        if (typeof ref.album !== 'string' || ref.album === '') return "missing 'album'";
        return { albumArtist: ref.albumArtist, album: ref.album };
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
    function findaddFor(ref: { albumArtist: string; album: string }): string {
        return `findadd ${quoteArg('albumartist')} ${quoteArg(ref.albumArtist)} ${quoteArg('album')} ${quoteArg(ref.album)}`;
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
            streams.delete(close);
        };
        const close = () => {
            cleanup();
            reply.raw.end();
        };
        streams.add(close);

        request.raw.on('close', cleanup);
        request.raw.on('error', cleanup);
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
