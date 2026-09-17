/**
 * Minimal MPD protocol client.
 *
 * Deliberately hand-written rather than pulling a library: the protocol is
 * line-oriented and simple, it keeps the runtime dependency list at exactly
 * one package (fastify), it bundles cleanly with no dynamic requires, and
 * reconnect behaviour is the part we most need to control precisely.
 *
 * Protocol, as spoken by MPD 0.24:
 *   - on connect the server sends "OK MPD <version>\n"
 *   - a command is a line; the reply is zero or more "key: value" lines
 *     terminated by "OK\n", or "ACK [code@idx] {cmd} message\n" on error
 *   - "idle" blocks until something changes, then replies with
 *     "changed: <subsystem>" lines and "OK"
 */

import { createConnection, type Socket } from 'node:net';

export class MpdError extends Error {}

/** MPD quotes arguments with " and backslash-escapes " and \ inside them. */
export function quoteArg(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A parsed reply. MPD returns repeated keys (a queue listing repeats "file"),
 * so the raw ordered pairs are kept alongside a convenience map of first-wins
 * lookups.
 */
export interface Reply {
    pairs: Array<[string, string]>;
}

export function firstValue(reply: Reply, key: string): string | undefined {
    for (const [k, v] of reply.pairs) if (k === key) return v;
    return undefined;
}

/**
 * Split a reply into groups, starting a new group each time `key` is seen.
 * This is how MPD list responses are delimited — a queue listing is a series
 * of records each beginning with "file".
 */
export function groupBy(reply: Reply, key: string): Array<Map<string, string>> {
    const groups: Array<Map<string, string>> = [];
    let current: Map<string, string> | null = null;
    for (const [k, v] of reply.pairs) {
        if (k === key) {
            current = new Map();
            groups.push(current);
        }
        if (current) current.set(k, v);
    }
    return groups;
}

/**
 * As `groupBy`, but keeps every value of a repeated key rather than the last.
 *
 * MPD sends one line per value of a multi-valued tag, and 91% of this library's
 * songs carry more than one `Genre` — "Burn the Witch" has twelve. A Map keyed
 * by tag name silently keeps whichever came last, which is how `Track.genre`
 * came to report "Orchestral" for a song tagged Art Rock through Krautrock.
 */
export function groupByMulti(reply: Reply, key: string): Array<Map<string, string[]>> {
    const groups: Array<Map<string, string[]>> = [];
    let current: Map<string, string[]> | null = null;
    for (const [k, v] of reply.pairs) {
        if (k === key) {
            current = new Map();
            groups.push(current);
        }
        if (current) {
            const existing = current.get(k);
            if (existing === undefined) current.set(k, [v]);
            else existing.push(v);
        }
    }
    return groups;
}

/**
 * Collapse a multi-value record to one value per key, FIRST wins.
 *
 * First rather than last so it agrees with `firstValue` above. Only `Genre` is
 * repeated often enough for the choice to matter (`Date` on about 1% of songs);
 * everything else in this library is single-valued, measured.
 */
export function firstOf(tags: Map<string, string[]>): Map<string, string> {
    const out = new Map<string, string>();
    for (const [k, values] of tags) if (values.length > 0) out.set(k, values[0]);
    return out;
}

interface Pending {
    resolve: (reply: Reply) => void;
    reject: (err: Error) => void;
    pairs: Array<[string, string]>;
    /** Reply deadline, or null for a command allowed to block (see send()). */
    timer: NodeJS.Timeout | null;
}

/**
 * How long to wait for a reply before declaring the connection dead.
 *
 * There is a real failure mode this exists for: a firmware/clock deadlock on
 * this board leaves MPD's process alive and its socket accepted by the kernel,
 * but its main thread blocked forever, so it reads the command and never
 * answers. Without a deadline `send()` waits for eternity, `refresh()` with it,
 * and the whole web UI hangs — a wedged MPD took the entire server down rather
 * than being reported as unavailable. Observed on the device: nearly two hours
 * of a dead /api/status while MPD still showed `active (running)`.
 * See .claude/docs/clock-deadlock.md.
 *
 * Deliberately generous. MPD is local, over loopback, and answers `status` in
 * microseconds; even a `find` across ~37,000 songs is an in-memory scan. The
 * cost of a false positive is a dropped connection and a reconnect, so this is
 * set far above any plausible honest reply rather than tuned tight.
 */
export const DEFAULT_REPLY_TIMEOUT_MS = 10_000;

/**
 * One MPD connection. Not automatically reconnecting — that policy lives in
 * the bridge, which owns two of these for different purposes.
 */
export class MpdConnection {
    private socket: Socket | null = null;
    private buffer = '';
    private queue: Pending[] = [];
    private greeted = false;
    private readonly replyTimeoutMs: number;

    // Not a constructor parameter property: those emit code, and Node's
    // type-stripping (used by `npm test`) rejects them.
    constructor(opts: { replyTimeoutMs?: number } = {}) {
        this.replyTimeoutMs = opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    }

    /** MPD's advertised version, once the greeting has been read. */
    version = '';

    /** Resolves once the greeting has arrived and commands may be sent. */
    connect(host: string, port: number, timeoutMs: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = createConnection({ host, port });
            this.socket = socket;
            this.greeted = false;

            const onFail = (err: Error) => {
                socket.destroy();
                this.failAll(err);
                reject(err);
            };

            const timer = setTimeout(
                () => onFail(new MpdError(`timed out connecting to ${host}:${port}`)),
                timeoutMs,
            );

            socket.once('error', onFail);

            socket.on('data', (chunk) => {
                this.buffer += chunk.toString('utf8');
                if (!this.greeted) {
                    const nl = this.buffer.indexOf('\n');
                    if (nl === -1) return;
                    const greeting = this.buffer.slice(0, nl);
                    this.buffer = this.buffer.slice(nl + 1);
                    if (!greeting.startsWith('OK MPD ')) {
                        onFail(new MpdError(`unexpected greeting: ${greeting}`));
                        return;
                    }
                    this.version = greeting.slice('OK MPD '.length).trim();
                    this.greeted = true;
                    clearTimeout(timer);
                    // Connection-level errors from here on are the bridge's problem.
                    socket.removeListener('error', onFail);
                    socket.on('error', (err) => this.failAll(err));
                    socket.on('close', () =>
                        this.failAll(new MpdError('connection closed by MPD')),
                    );
                    resolve();
                }
                this.drainBuffer();
            });
        });
    }

    private drainBuffer(): void {
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, nl);
            this.buffer = this.buffer.slice(nl + 1);
            const pending = this.queue[0];
            if (!pending) continue; // unsolicited; nothing is waiting

            if (line === 'OK') {
                this.queue.shift();
                if (pending.timer) clearTimeout(pending.timer);
                pending.resolve({ pairs: pending.pairs });
            } else if (line.startsWith('ACK ')) {
                this.queue.shift();
                if (pending.timer) clearTimeout(pending.timer);
                pending.reject(new MpdError(line));
            } else {
                const sep = line.indexOf(': ');
                if (sep !== -1) {
                    pending.pairs.push([line.slice(0, sep), line.slice(sep + 2)]);
                }
            }
        }
    }

    private failAll(err: Error): void {
        const queued = this.queue;
        this.queue = [];
        for (const p of queued) {
            if (p.timer) clearTimeout(p.timer);
            p.reject(err);
        }
    }

    /**
     * Send a command and wait for its reply.
     *
     * `timeoutMs: null` opts out of the deadline, which `idle` REQUIRES — it is
     * meant to block until something changes, possibly for hours, and MPD
     * exempts it from its own connection_timeout. Nothing else should opt out.
     *
     * A timeout is fatal to the connection, not just to the one command. This is
     * the important part: replies are matched to commands purely by order, so a
     * reply that arrives after we have given up would be handed to whatever
     * command came next, silently reporting one thing's answer as another's.
     * There is no way to resynchronise a stream like that, so the socket is
     * destroyed and the bridge reconnects — which it already knows how to do,
     * behind the grace period that stops a blip reaching the UI.
     */
    send(command: string, opts: { timeoutMs?: number | null } = {}): Promise<Reply> {
        const timeoutMs = opts.timeoutMs === undefined ? this.replyTimeoutMs : opts.timeoutMs;
        return new Promise((resolve, reject) => {
            if (!this.socket || this.socket.destroyed) {
                reject(new MpdError('not connected'));
                return;
            }
            const pending: Pending = { resolve, reject, pairs: [], timer: null };
            if (timeoutMs !== null) {
                pending.timer = setTimeout(() => {
                    // failAll rejects this pending too, so the caller is woken.
                    this.socket?.destroy();
                    this.failAll(
                        new MpdError(`MPD did not answer '${command}' within ${timeoutMs}ms`),
                    );
                }, timeoutMs);
            }
            this.queue.push(pending);
            this.socket.write(`${command}\n`);
        });
    }

    /**
     * Cancel a blocking `idle` without waiting for a change. MPD answers the
     * outstanding idle immediately with an empty change list.
     */
    noidle(): void {
        if (this.socket && !this.socket.destroyed) this.socket.write('noidle\n');
    }

    get connected(): boolean {
        return this.socket !== null && !this.socket.destroyed && this.greeted;
    }

    close(): void {
        this.socket?.destroy();
        this.socket = null;
        this.greeted = false;
        this.failAll(new MpdError('connection closed locally'));
    }
}
