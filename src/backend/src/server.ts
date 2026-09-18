/**
 * musicbox server — entry point.
 *
 * One process serves both the Angular build and the API. See install/setup-server.sh
 * for the unit; note it is deliberately NOT ordered after mpd.service, because
 * MPD takes ~6s at boot and ordering behind it would put that on the critical
 * path. MPD being absent is handled here, not by systemd.
 */

import Fastify from 'fastify';
import { loadConfig, DEFAULT_CONF_PATH } from './config.ts';
import { MpdBridge } from './mpd/bridge.ts';
import { registerCors } from './cors.ts';
import { registerRoutes, type RouteHandle } from './routes.ts';
import { registerStatic } from './static.ts';
import { createBluetoothWatcher } from './bluetooth.ts';
import { openDb } from './db.ts';
import { createSettings } from './settings.ts';
import { createLibraryScanner } from './library-scan.ts';
import { createLibraryNotes } from './library-notes.ts';
import { createPanel } from './panel.ts';
import { createPower } from './power.ts';
import { createBackups } from './backup.ts';
import { createFavourites } from './favourites.ts';
import { createPlays } from './plays.ts';
import { createPlayWatch } from './play-watch.ts';

/** Replaced at build time by esbuild's define. */
declare const __MUSICBOX_BUILD__: string;
const BUILD = typeof __MUSICBOX_BUILD__ === 'string' ? __MUSICBOX_BUILD__ : 'dev';

async function main(): Promise<void> {
    const confPath = process.env.MUSICBOX_CONF ?? DEFAULT_CONF_PATH;
    const config = loadConfig(confPath);
    const startedAt = Date.now();

    const app = Fastify({
        logger: { level: config.logLevel },
        // The panel and phones are on a trusted LAN, and /api/events is long-lived;
        // keep per-request logging for debug only.
        //
        // Fastify 5 warns that this moves to logController in v6. The replacement
        // type requires a complete LogController object rather than this one flag,
        // so it stays as-is until v6 actually lands — it is a one-line change then.
        disableRequestLogging: config.logLevel !== 'debug',
        // Do not wait on lingering keep-alive sockets during close().
        forceCloseConnections: true,
    });

    const bridge = new MpdBridge({
        host: config.mpdHost,
        port: config.mpdPort,
        connectTimeoutMs: config.mpdConnectTimeoutMs,
        log: (level, msg) => app.log[level](msg),
    });

    // The box's own state. Opened before the routes because they take it, and
    // a failure here is fatal: a server that silently forgets every setting is
    // worse than one that does not start and says why in the journal.
    const db = openDb({
        path: config.dbPath,
        onMigrate: (to) => app.log.info(`database migrated to schema v${to}`),
    });
    const settings = createSettings(db);

    // What the box has played. The watcher's bridge subscription lives here for
    // the same reason the scanner's does — routes.ts keeps its single listener.
    const plays = createPlays(db);
    const playWatch = createPlayWatch(plays);
    bridge.onSnapshot((snapshot) => playWatch.observe(snapshot));

    // Ratings and biographies from the NAS's `.nfo` sidecars. Read after a scan
    // rather than on request, because the share is unmounted most of the time —
    // see library-notes.ts.
    const notes = createLibraryNotes({
        db,
        bridge,
        musicRoot: config.musicRoot,
        log: (level, msg) => app.log[level](msg),
    });

    // Assigned below, before anything can call it: a harvest only runs after a
    // scan, and a scan only after scanner.start().
    let routes: RouteHandle;

    // Library scanning. Constructed before the routes because they take it, and
    // started below with the bridge — its wiring lives here rather than in
    // routes.ts so there is still exactly one bridge.onIdle call in that file.
    const scanner = createLibraryScanner({
        bridge,
        db,
        settings,
        musicRoot: config.musicRoot,
        log: (level, msg) => app.log[level](msg),
        // Straight after a scan, while the share is mounted and its directory
        // entries are warm — the harvest costs about a minute cold and a few
        // seconds warm. MPD's own `database` event has already dropped the artist
        // index by now, so it is dropped AGAIN here: the ratings this just wrote
        // are part of that index.
        onScanComplete: async () => {
            await notes.harvest();
            routes.invalidateLibrary();
        },
    });

    // The panel's backlight. Unsupported everywhere but the box itself, which is
    // not an error — the routes answer 503 and the UI says so.
    const panel = createPanel({
        device: process.env.MUSICBOX_BACKLIGHT,
        onError: (err) => app.log.warn(`panel backlight: ${err.message}`),
    });
    // Whatever happened before this process existed, the screen is on now. A
    // crash with the backlight off would otherwise survive the restart.
    if (panel.supported) panel.set(true);

    // Before the routes: the onRequest hook must be in place for /api responses,
    // and the preflight route must exist before static.ts claims unknown paths.
    registerCors(app);
    routes = registerRoutes(app, {
        bridge,
        build: BUILD,
        startedAt,
        musicRoot: config.musicRoot,
        bluetoothControl: config.bluetoothControl,
        panel,
        settings,
        power: createPower(config.powerDir),
        scanner,
        backups: createBackups({
            db,
            build: BUILD,
            mpdDir: config.mpdStateDir,
            restoreDir: config.restoreDir,
        }),
        favourites: createFavourites(db),
        plays,
        notes,
    });
    registerStatic(app, config.webRoot);

    // Started AFTER the bridge is constructed and BEFORE it connects, so the very
    // first snapshot already knows whether a phone is connected. The arbiter owns
    // the audio handoff; this only observes it. See src/backend/src/bluetooth.ts.
    const bluetooth = createBluetoothWatcher({
        path: config.bluetoothState,
        log: (level, msg) => app.log[level](msg),
        onChange: (state) => {
            app.log.info(
                state
                    ? `bluetooth: ${state.device.name} (${state.device.codec ?? 'codec pending'}) ${state.state ?? 'state unknown'}` +
                      (state.title ? ` — ${state.artist ?? '?'} / ${state.title}` : '')
                    : 'bluetooth: disconnected',
            );
            void bridge.setBluetooth(state);
        },
    });
    void bluetooth.poll();

    bridge.start();
    // After the bridge, so reconciling an in-flight scan can see MPD's job id.
    scanner.start();

    // A database restored from a backup, or a first run on a box whose library
    // was scanned before this feature existed, has no notes and no scan due for
    // up to a day. Fill it once, in the background.
    //
    // WAITS FOR MPD, because the harvest asks it for the directory list and
    // bridge.start() above has only just been called — the connection comes up a
    // few milliseconds later, and the first attempt reliably lost the race and
    // logged "MPD is not connected". Same shape and the same patience as the
    // scanner's boot scan; the timers are unref'd so they can never hold
    // shutdown open.
    if (notes.count() === 0) {
        const INITIAL_HARVEST_RETRIES = 10;
        const INITIAL_HARVEST_RETRY_MS = 15_000;
        const armInitialHarvest = (attempt: number): void => {
            const timer = setTimeout(() => {
                void (async () => {
                    if (bridge.status !== 'ok') {
                        if (attempt >= INITIAL_HARVEST_RETRIES) {
                            app.log.warn('initial nfo harvest skipped: MPD never became available');
                            return;
                        }
                        armInitialHarvest(attempt + 1);
                        return;
                    }
                    // harvest() checks the share itself and does nothing quietly
                    // when it is not mounted.
                    await notes.harvest();
                    routes.invalidateLibrary();
                })().catch((err: Error) => app.log.warn(`initial nfo harvest failed: ${err.message}`));
            }, attempt === 0 ? 1_000 : INITIAL_HARVEST_RETRY_MS);
            timer.unref();
        };
        armInitialHarvest(0);
    }

    const shutdown = async (signal: string) => {
        app.log.info(`${signal} received, shutting down`);
        bridge.stop();
        // Before close() for the same reason as the two below: its tick holds
        // the event loop open.
        scanner.stop();
        // Also before close(): the inotify watch and its poll timer both hold the
        // event loop open, the same way the SSE streams below do.
        bluetooth.stop();
        // MUST come before close(): Fastify waits for connections to finish and
        // an SSE stream never finishes, so a single connected client — the kiosk
        // always has one — would wedge shutdown until systemd's stop timeout.
        routes.closeStreams();
        // Never leave the panel dark across a restart: the browser that asked
        // for it will reconnect to a server that has forgotten why.
        if (panel.supported) panel.set(true);
        await app.close();
        db.close();
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    try {
        await app.listen({ port: config.port, host: config.host });
        app.log.info(
            `musicbox build ${BUILD} — serving ${config.webRoot}, MPD at ${config.mpdHost}:${config.mpdPort}, art from ${config.musicRoot}, db ${config.dbPath}` +
                (panel.supported ? '' : ', no panel backlight'),
        );
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

void main();
