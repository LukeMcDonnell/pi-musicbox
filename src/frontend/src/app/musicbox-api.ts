/**
 * The one place that talks to the backend.
 *
 * SSE carries state, REST carries commands. Every SSE message is a COMPLETE
 * snapshot, so this service never merges or patches — it replaces. That is why a
 * dropped, duplicated or out-of-order event is harmless.
 *
 * EventSource reconnects on its own, and the server sends a snapshot immediately
 * on connect, so recovery from a dropped connection needs no code here.
 */

import { Injectable, computed, signal, DestroyRef, inject } from '@angular/core';
import type { Snapshot, PlaybackCommand, QueueResponse } from '@musicbox/shared';
import { SSE_SNAPSHOT_EVENT } from '@musicbox/shared';

/** How the browser is getting on with the server (not with MPD — that is snapshot.status). */
export type StreamState = 'connecting' | 'live' | 'offline';

@Injectable({ providedIn: 'root' })
export class MusicboxApi {
    private readonly destroyRef = inject(DestroyRef);

    private readonly _snapshot = signal<Snapshot | null>(null);
    private readonly _stream = signal<StreamState>('connecting');

    /** Latest complete state, or null before the first frame arrives. */
    readonly snapshot = this._snapshot.asReadonly();
    readonly stream = this._stream.asReadonly();

    readonly mpdAvailable = computed(() => this._snapshot()?.status === 'ok');

    private source: EventSource | null = null;

    /**
     * Client-clock reference captured when the snapshot arrived, so elapsed time
     * can be advanced locally. MPD does not push progress continuously and
     * polling for a smooth progress bar is the wrong answer.
     *
     * This is the CLIENT's clock, deliberately, not snapshot.serverTime — using
     * the server's timestamp would require a phone's clock to agree with the
     * Pi's. It is only correct because the server sends a freshly queried
     * snapshot on connect; if that ever regresses, a page load will show the
     * position as at the last MPD event instead of now.
     */
    private receivedAt = 0;

    constructor() {
        this.connect();
        this.destroyRef.onDestroy(() => this.source?.close());
    }

    private connect(): void {
        this.source = new EventSource('/api/events');

        this.source.addEventListener(SSE_SNAPSHOT_EVENT, (event) => {
            const snapshot = JSON.parse((event as MessageEvent<string>).data) as Snapshot;
            this.receivedAt = Date.now();
            // Replace wholesale. Never merge — see the header.
            this._snapshot.set(snapshot);
            this._stream.set('live');
        });

        this.source.addEventListener('open', () => this._stream.set('live'));

        // EventSource retries by itself; reflect the gap rather than reconnecting
        // manually, which would fight its backoff.
        this.source.addEventListener('error', () => this._stream.set('offline'));
    }

    /**
     * Elapsed seconds, interpolated from the last snapshot. Call this from a
     * ticker for a smooth progress bar with no polling.
     */
    elapsedNow(): number | null {
        const snap = this._snapshot();
        if (!snap || snap.elapsed === null) return null;
        if (snap.state !== 'play') return snap.elapsed;
        const advanced = snap.elapsed + (Date.now() - this.receivedAt) / 1000;
        return snap.duration !== null ? Math.min(advanced, snap.duration) : advanced;
    }

    async playback(command: PlaybackCommand): Promise<void> {
        await this.post(`/api/playback/${command}`);
    }

    async queue(): Promise<QueueResponse> {
        const response = await fetch('/api/queue');
        if (!response.ok) throw new Error(`queue: HTTP ${response.status}`);
        return (await response.json()) as QueueResponse;
    }

    private async post(url: string, body?: unknown): Promise<void> {
        const response = await fetch(url, {
            method: 'POST',
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!response.ok) {
            let detail = `HTTP ${response.status}`;
            try {
                const parsed = (await response.json()) as { error?: string };
                if (parsed.error) detail = parsed.error;
            } catch {
                // Non-JSON error body; the status code is enough.
            }
            throw new Error(detail);
        }
        // No state update here: the command changes MPD, MPD's idle fires, and the
        // snapshot arrives over SSE. One source of truth.
    }
}
