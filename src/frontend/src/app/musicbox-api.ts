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

import { Injectable, computed, effect, signal, DestroyRef, inject } from '@angular/core';
import type { Snapshot, PlaybackCommand, QueueResponse, Track, BuildInfo } from '@musicbox/shared';
import { SSE_SNAPSHOT_EVENT, SSE_BUILD_EVENT } from '@musicbox/shared';
import { environment } from '../environments/environment';

/** How the browser is getting on with the server (not with MPD — that is snapshot.status). */
export type StreamState = 'connecting' | 'live' | 'offline';

@Injectable({ providedIn: 'root' })
export class MusicboxApi {
    private readonly destroyRef = inject(DestroyRef);

    private readonly _snapshot = signal<Snapshot | null>(null);
    private readonly _stream = signal<StreamState>('connecting');
    private readonly _queue = signal<Track[]>([]);

    /** Latest complete state, or null before the first frame arrives. */
    readonly snapshot = this._snapshot.asReadonly();
    readonly stream = this._stream.asReadonly();

    /**
     * The current queue listing, refetched when `queueVersion` changes.
     *
     * The one piece of state that does NOT arrive on the snapshot — see the
     * contract header in src/shared/api.ts for why 37,000 songs' worth of queue
     * is referenced by version instead of embedded. It lives on the service
     * rather than in a component so that the fetch happens once however many
     * views show it, and so it survives a component being destroyed.
     */
    readonly queue = this._queue.asReadonly();

    /**
     * The queue version, as a computed so it changes by VALUE.
     *
     * The effect below must not read `_snapshot` directly: that signal is
     * replaced on every SSE frame — including one per second of elapsed time —
     * and a new object is never equal to the old one, so the effect would rerun
     * and refetch constantly. A computed only notifies when its result actually
     * differs, which is the whole point of the version field.
     */
    private readonly queueVersion = computed(() => this._snapshot()?.queueVersion ?? -1);

    readonly mpdAvailable = computed(() => this._snapshot()?.status === 'ok');

    /**
     * Whether there is a queue listing worth showing.
     *
     * Here rather than in the queue component because two views need the same
     * answer: the queue decides whether to render itself, and the now-playing
     * screen decides whether to offer the scroll hint. They must never disagree
     * — a hint pointing at nothing is worse than no hint.
     */
    readonly hasQueue = computed(() => {
        const snap = this._snapshot();
        if (!snap || snap.status !== 'ok' || snap.queueVersion < 0) return false;
        return this._queue().length > 0;
    });

    /**
     * The connected Bluetooth device, or null.
     *
     * Nothing else is needed here: the service replaces the whole Snapshot on
     * every frame, so a new backend field is readable the moment it exists. This
     * is a convenience, not plumbing.
     */
    readonly bluetooth = computed(() => this._snapshot()?.bluetooth ?? null);

    private source: EventSource | null = null;

    /**
     * The server build this page was loaded against, learned from the first
     * `build` event. A later, different value means a new version has been
     * deployed and this page is stale.
     */
    private build: string | null = null;
    /** Reload exactly once, however many events arrive. */
    private reloading = false;

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

        /*
         * Watch the version, not the snapshot: a snapshot arrives on every
         * elapsed-time change and refetching the queue for each of those is
         * exactly what the version field exists to avoid.
         *
         * -1 means there is no listing to fetch and is the signal not to try —
         * a Bluetooth source, where GET /api/queue answers 409. Clearing rather
         * than keeping the last MPD queue is deliberate: while a phone is
         * playing, MPD's queue is not what anyone is looking at.
         */
        effect(() => {
            if (this.queueVersion() < 0) {
                this.queueRequest += 1; // cancel any listing still in flight
                this._queue.set([]);
                return;
            }
            void this.loadQueue();
        });
    }

    /**
     * Sequence number of the most recent queue fetch.
     *
     * Two versions in quick succession — adding an album queues one track at a
     * time — mean two overlapping fetches, and the responses can land in either
     * order. Rendering the older one would leave the list disagreeing with
     * `queuePosition`, which is what splits it into Back to and Up next.
     */
    private queueRequest = 0;

    private async loadQueue(): Promise<void> {
        const request = ++this.queueRequest;
        try {
            const { tracks } = await this.fetchQueue();
            if (request === this.queueRequest) this._queue.set(tracks);
        } catch {
            // Nothing to report and nothing to do: the queue is one snapshot
            // away from being asked for again, and a transport error here is
            // already visible as the stream going offline.
        }
    }

    private connect(): void {
        this.source = new EventSource(this.resolve('/api/events'));

        this.source.addEventListener(SSE_SNAPSHOT_EVENT, (event) => {
            const snapshot = JSON.parse((event as MessageEvent<string>).data) as Snapshot;
            this.receivedAt = Date.now();
            // Replace wholesale. Never merge — see the header.
            this._snapshot.set(snapshot);
            this._stream.set('live');
        });

        /*
         * Self-update.
         *
         * The panel loads this page once at boot and never navigates again — no
         * keyboard, nobody to press reload — so a deployed frontend would
         * otherwise never reach it. It was observed running a 14-hour-old bundle
         * while the new files sat on disk being served correctly.
         *
         * The server restarts on any deploy (musicbox-server.path watches both
         * the backend bundle and frontend/index.html), which drops this stream;
         * EventSource reconnects on its own and the build arrives again. A
         * changed value means reload.
         *
         * Safe to do unconditionally: this UI holds no state worth keeping —
         * everything comes from the next snapshot.
         */
        this.source.addEventListener(SSE_BUILD_EVENT, (event) => {
            const { build } = JSON.parse((event as MessageEvent<string>).data) as BuildInfo;
            if (this.build === null) {
                this.build = build;
                return;
            }
            if (build !== this.build && !this.reloading) {
                this.reloading = true;
                location.reload();
            }
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
        await this.post(this.resolve(`/api/playback/${command}`));
    }

    /**
     * End the Bluetooth session and hand the DAC back to MPD.
     *
     * MPD stays paused at its position — this gives the speaker back, it does not
     * start playing. See .claude/docs/bluetooth.md.
     */
    async disconnectBluetooth(): Promise<void> {
        await this.post(this.resolve('/api/bluetooth/disconnect'));
    }

    /** One-shot GET. Prefer the `queue` signal, which keeps itself current. */
    async fetchQueue(): Promise<QueueResponse> {
        const response = await fetch(this.resolve('/api/queue'));
        if (!response.ok) throw new Error(`queue: HTTP ${response.status}`);
        return (await response.json()) as QueueResponse;
    }

    /**
     * Start playing one track from the queue.
     *
     * Addressed by MPD's song id, which survives a reorder — a position does
     * not, and the listing under a finger may be seconds old. See
     * src/shared/api.ts.
     */
    async playQueueId(id: number): Promise<void> {
        await this.post(this.resolve(`/api/queue/play/${id}`));
    }

    /**
     * Prefix an API path with the configured origin.
     *
     * Blank apiUrl — production, and dev by default — returns the path untouched,
     * so the request stays root-relative and same-origin, exactly as the
     * hardcoded literals this replaced did. A configured value makes the URL
     * absolute, for pointing a dev frontend at a real box; the backend allows any
     * origin on /api, so that needs no configuration there.
     *
     * PUBLIC because paths also arrive FROM the server — `Track.image` is a
     * root-relative `/api/art?...`. Anything binding one of those into the DOM
     * must send it through here: the browser would otherwise resolve it against
     * the page's own origin, so with apiUrl set to a real box the art would be
     * fetched from the dev server and 404. Images need no CORS, so this works
     * cross-origin as-is.
     */
    resolve(path: string): string {
        return environment.apiUrl.replace(/\/+$/, '') + path;
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
        // No state update here. For MPD the command lands, MPD's idle fires, and
        // the snapshot arrives over SSE. For Bluetooth the arbiter acts and its
        // next published state does the same. One source of truth either way.
        //
        // Deliberately no optimistic local update, even though AVRCP takes a few
        // seconds to report a new status: guessing would show the wrong state
        // confidently whenever a command is genuinely ignored, and phones do
        // ignore them.
    }
}
