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
    API_VERSION,
    type HealthResponse,
    type PlaybackCommand,
    type Snapshot,
} from '../../shared/api.ts';
import type { MpdBridge } from './mpd/bridge.ts';

/** How often to send an SSE comment so idle proxies and dead clients are noticed. */
const SSE_HEARTBEAT_MS = 15_000;

export interface RouteOptions {
    bridge: MpdBridge;
    build: string;
    startedAt: number;
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

function sseFrame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function registerRoutes(app: FastifyInstance, opts: RouteOptions): RouteHandle {
    const { bridge, build, startedAt } = opts;

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

    app.get('/api/status', async (): Promise<Snapshot> => bridge.current);

    app.get('/api/queue', async (_req: FastifyRequest, reply: FastifyReply) => {
        try {
            return await bridge.queue();
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
        try {
            await bridge.command(COMMAND_MAP[command as PlaybackCommand]);
            return bridge.current;
        } catch (err) {
            return reply.code(503).send({ error: (err as Error).message });
        }
    });

    app.post('/api/volume', async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { value?: unknown } | undefined;
        const value = body?.value;
        // Must be an actual number: Number(null) is 0 and Number("") is 0, so
        // coercing would turn a malformed request into "set volume to silent".
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
            return reply.code(400).send({ error: 'value must be a number from 0 to 100' });
        }
        try {
            await bridge.setVolume(value);
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
    app.get('/api/events', (request: FastifyRequest, reply: FastifyReply) => {
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
