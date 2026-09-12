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

interface Pending {
    resolve: (reply: Reply) => void;
    reject: (err: Error) => void;
    pairs: Array<[string, string]>;
}

/**
 * One MPD connection. Not automatically reconnecting — that policy lives in
 * the bridge, which owns two of these for different purposes.
 */
export class MpdConnection {
    private socket: Socket | null = null;
    private buffer = '';
    private queue: Pending[] = [];
    private greeted = false;

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
                pending.resolve({ pairs: pending.pairs });
            } else if (line.startsWith('ACK ')) {
                this.queue.shift();
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
        for (const p of queued) p.reject(err);
    }

    send(command: string): Promise<Reply> {
        return new Promise((resolve, reject) => {
            if (!this.socket || this.socket.destroyed) {
                reject(new MpdError('not connected'));
                return;
            }
            this.queue.push({ resolve, reject, pairs: [] });
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
