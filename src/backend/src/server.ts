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
import { registerRoutes } from './routes.ts';
import { registerStatic } from './static.ts';
import { createBluetoothWatcher } from './bluetooth.ts';

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

    // Before the routes: the onRequest hook must be in place for /api responses,
    // and the preflight route must exist before static.ts claims unknown paths.
    registerCors(app);
    const routes = registerRoutes(app, {
        bridge,
        build: BUILD,
        startedAt,
        musicRoot: config.musicRoot,
        bluetoothControl: config.bluetoothControl,
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

    const shutdown = async (signal: string) => {
        app.log.info(`${signal} received, shutting down`);
        bridge.stop();
        // Also before close(): the inotify watch and its poll timer both hold the
        // event loop open, the same way the SSE streams below do.
        bluetooth.stop();
        // MUST come before close(): Fastify waits for connections to finish and
        // an SSE stream never finishes, so a single connected client — the kiosk
        // always has one — would wedge shutdown until systemd's stop timeout.
        routes.closeStreams();
        await app.close();
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    try {
        await app.listen({ port: config.port, host: config.host });
        app.log.info(
            `musicbox build ${BUILD} — serving ${config.webRoot}, MPD at ${config.mpdHost}:${config.mpdPort}, art from ${config.musicRoot}`,
        );
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

void main();
