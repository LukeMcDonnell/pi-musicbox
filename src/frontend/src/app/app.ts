import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import type { PlaybackCommand } from '@musicbox/shared';
import { MusicboxApi } from './musicbox-api';

/** Seconds as m:ss, or a dash when there is nothing to show. */
function clock(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds)) return '–:––';
    const total = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(total / 60);
    return `${mins}:${String(total % 60).padStart(2, '0')}`;
}

@Component({
    selector: 'app-root',
    imports: [],
    templateUrl: './app.html',
    styleUrl: './app.scss',
})
export class App implements OnDestroy {
    private readonly api = inject(MusicboxApi);

    readonly snapshot = this.api.snapshot;
    readonly stream = this.api.stream;
    readonly mpdAvailable = this.api.mpdAvailable;

    /** Advanced locally between snapshots so the progress bar moves smoothly. */
    private readonly tick = signal(0);

    readonly elapsed = computed(() => {
        this.tick(); // re-evaluate on every tick
        return this.api.elapsedNow();
    });

    readonly elapsedLabel = computed(() => clock(this.elapsed()));
    readonly durationLabel = computed(() => clock(this.snapshot()?.duration ?? null));

    readonly progress = computed(() => {
        const duration = this.snapshot()?.duration ?? null;
        const elapsed = this.elapsed();
        if (duration === null || elapsed === null || duration <= 0) return 0;
        return Math.min(100, (elapsed / duration) * 100);
    });

    readonly playing = computed(() => this.snapshot()?.state === 'play');

    /** scaleX rather than width — see the comment in app.scss for why it matters. */
    readonly progressTransform = computed(() => `scaleX(${this.progress() / 100})`);

    /** The connected Bluetooth device, or null. */
    readonly bluetooth = this.api.bluetooth;

    /**
     * True when a phone owns the DAC.
     *
     * Used only to decide what EXTRA to show — the device chip and the disconnect
     * button. The now-playing block itself is source-agnostic, because the
     * snapshot's top-level fields describe whichever source is active.
     */
    readonly onBluetooth = computed(() => this.snapshot()?.source === 'bluetooth');

    /** "Luke's iPhone · aptX HD", or just the name until the codec is known. */
    readonly bluetoothLine = computed(() => {
        const bt = this.bluetooth();
        if (!bt) return null;
        return bt.codec ? `${bt.name} · ${bt.codec}` : bt.name;
    });

    /** Best available name for a track, whatever source it came from. */
    readonly trackTitle = computed(() => {
        const track = this.snapshot()?.track;
        if (!track) return null;
        // `file` is absent for a Bluetooth track, so it cannot be the fallback it
        // is for MPD. A phone that reports nothing at all still gets a row rather
        // than a blank.
        return track.title || track.file || 'Unknown track';
    });

    /**
     * Shown instead of the now-playing block when there is nothing to show.
     *
     * Bluetooth is checked before MPD's conditions: while a phone owns the DAC,
     * MPD being stopped or unreachable is not worth reporting — it is not what
     * you are listening to.
     */
    readonly statusLine = computed(() => {
        if (this.stream() === 'offline') return 'Reconnecting to musicbox…';
        if (this.stream() === 'connecting') return 'Connecting…';
        const snap = this.snapshot();
        if (this.onBluetooth()) {
            // A connected phone with nothing playing yet. The chip below still
            // names the device, so this only has to explain the silence.
            return snap?.track ? null : 'Connected — start playing on your phone';
        }
        if (!this.mpdAvailable()) return 'MPD is not running';
        if (!snap?.track) return snap?.queueLength ? 'Stopped' : 'Nothing queued';
        return null;
    });

    readonly error = signal<string | null>(null);

    /**
     * The one art URI that failed to load, if any.
     *
     * No explicit reset is needed: the URI is keyed by ALBUM, so moving to a
     * different album produces a different string and the comparison below stops
     * matching on its own. Within an album a failed cover stays hidden instead of
     * being retried on every track.
     */
    private readonly artFailed = signal<string | null>(null);

    /**
     * Cover art URI, or null when there is none to show.
     *
     * About 7.5% of the library has no cover file, so the 404 path is normal
     * rather than exceptional — hence a placeholder rather than an error.
     *
     * Because this value is identical for every track on an album, Angular does
     * not touch the <img> when the track changes: no refetch, and no repaint of
     * the image. That is deliberate — see the ticker comment below for why
     * repaints on this panel are something to spend care avoiding.
     */
    readonly artUri = computed(() => {
        const image = this.snapshot()?.track?.image ?? null;
        if (!image) return null;
        // Through the API resolver, not raw: the server sends a root-relative
        // path, and an <img> would resolve it against the PAGE's origin. With
        // environment.apiUrl pointed at the real box, raw binding fetches the art
        // from the dev server instead, and 404s.
        const resolved = this.api.resolve(image);
        // Compare the RESOLVED url, because that is what onArtError() is handed
        // by the template — comparing the raw path would never match and a failed
        // cover would flicker back on every snapshot.
        return resolved === this.artFailed() ? null : resolved;
    });

    onArtError(uri: string): void {
        this.artFailed.set(uri);
    }

    /*
     * 1Hz, and only while playing.
     *
     * This is not a style preference. Every repaint on the DSI panel becomes a
     * vc4 atomic commit, which calls the GPU firmware over the mailbox while
     * holding the kernel clock mutex — a path that has hard-locked this box.
     * At 1Hz with no CSS transition the panel commits about once a second
     * instead of ~60 times a second, which is a ~60x reduction in traffic
     * through it.
     *
     * A second of granularity is invisible on a progress bar for a 4-6 minute
     * track: one step is well under half a percent of its width. The elapsed
     * time readout only has second resolution anyway.
     */
    private readonly ticker = setInterval(() => {
        if (this.playing()) this.tick.update((n) => n + 1);
    }, 1000);

    ngOnDestroy(): void {
        clearInterval(this.ticker);
    }

    async command(name: PlaybackCommand): Promise<void> {
        this.error.set(null);
        try {
            await this.api.playback(name);
        } catch (err) {
            this.error.set((err as Error).message);
        }
    }

    async toggle(): Promise<void> {
        // Works unchanged for both sources now that `state` describes the active
        // one. It used to be the mechanism for taking the speaker back from a
        // phone — `playing()` was always false during a session, so this always
        // sent `play`, which started MPD and made the arbiter disconnect. That is
        // now an explicit Disconnect button.
        await this.command(this.playing() ? 'pause' : 'play');
    }

    /** Hand the DAC back to MPD. Leaves MPD paused where it was. */
    async disconnectBluetooth(): Promise<void> {
        this.error.set(null);
        try {
            await this.api.disconnectBluetooth();
        } catch (err) {
            this.error.set((err as Error).message);
        }
    }
}
