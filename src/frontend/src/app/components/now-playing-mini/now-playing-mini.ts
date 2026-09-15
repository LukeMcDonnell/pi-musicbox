import { Component, computed, inject, output, signal } from '@angular/core';
import {
    LucideBluetooth,
    LucideMusic,
    LucidePause,
    LucidePlay,
    LucideSkipForward,
} from '@lucide/angular';
import type { PlaybackCommand } from '@musicbox/shared';
import { MusicboxApi } from '../../services/musicbox-api';

/*
  The mini now-playing bar along the bottom of every screen: cover, title,
  artist, play/pause and next. Tapping anything but the two controls opens the
  full now-playing view.

  The open target and the controls are SIBLING buttons, not a clickable bar with
  buttons inside it. Nested interactive elements are invalid HTML, and the
  alternative — stopPropagation on each control — silently opens the full view
  the day someone adds a third control and forgets it.

  No elapsed time and no progress bar, deliberately: those are the only things
  here that would change every second, and this bar is on screen all the time.
  Everything else changes once per track.

  The title and art fallbacks mirror now-playing.ts; see the comments there for
  why each one is the shape it is.
*/
@Component({
    selector: 'app-now-playing-mini',
    imports: [LucideBluetooth, LucideMusic, LucidePause, LucidePlay, LucideSkipForward],
    templateUrl: './now-playing-mini.html',
    // overflow-hidden clips the viewport-sized backdrop to the bar.
    host: { class: 'block overflow-hidden bg-surface' },
})
export class NowPlayingMini {
    private readonly api = inject(MusicboxApi);

    /** The user asked for the full now-playing view. */
    readonly open = output<void>();

    readonly track = computed(() => this.api.snapshot()?.track ?? null);
    readonly playing = computed(() => this.api.snapshot()?.state === 'play');
    readonly onBluetooth = computed(() => this.api.snapshot()?.source === 'bluetooth');

    readonly trackTitle = computed(() => {
        const track = this.track();
        if (!track) return null;
        return track.title || track.file || 'Unknown track';
    });

    /** What to say in place of a title when there is no track. */
    readonly statusLine = computed(() => {
        const stream = this.api.stream();
        if (stream === 'offline') return 'Reconnecting…';
        if (stream === 'connecting') return 'Connecting…';
        if (this.onBluetooth()) return 'Bluetooth connected';
        if (!this.api.mpdAvailable()) return 'MPD is not running';
        return 'Nothing playing';
    });

    /** Controls do nothing useful without a live stream, so they look it. */
    readonly controlsDisabled = computed(() => this.api.stream() !== 'live');

    readonly error = signal<string | null>(null);

    private readonly artFailed = signal<string | null>(null);

    readonly artUri = computed(() => {
        const image = this.track()?.image ?? null;
        if (!image) return null;
        const resolved = this.api.resolve(image);
        return resolved === this.artFailed() ? null : resolved;
    });

    onArtError(uri: string): void {
        this.artFailed.set(uri);
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
        await this.command(this.playing() ? 'pause' : 'play');
    }
}
