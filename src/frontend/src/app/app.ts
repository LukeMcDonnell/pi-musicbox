import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
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

    /** Shown when there is no track; also covers MPD being down. */
    readonly statusLine = computed(() => {
        if (this.stream() === 'offline') return 'Reconnecting to musicbox…';
        if (this.stream() === 'connecting') return 'Connecting…';
        if (!this.mpdAvailable()) return 'MPD is not running';
        const snap = this.snapshot();
        if (!snap?.track) return snap?.queueLength ? 'Stopped' : 'Nothing queued';
        return null;
    });

    readonly error = signal<string | null>(null);

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

    async command(name: 'play' | 'pause' | 'stop' | 'next' | 'previous'): Promise<void> {
        this.error.set(null);
        try {
            await this.api.playback(name);
        } catch (err) {
            this.error.set((err as Error).message);
        }
    }

    async toggle(): Promise<void> {
        await this.command(this.playing() ? 'pause' : 'play');
    }
}
