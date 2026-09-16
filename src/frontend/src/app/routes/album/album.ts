import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideChevronLeft, LucideDisc3, LucideListPlus, LucidePlay } from '@lucide/angular';
import type { AlbumResponse, Track } from '@musicbox/shared';
import { AppHistory } from '../../services/app-history';
import { LibraryStore } from '../../services/library-store';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { Preferences } from '../../services/preferences';
import { clock } from '../../components/now-playing/now-playing';

/*
  One album: its cover as a hero, two buttons, and the tracks.

  PLAY REPLACES, QUEUE APPENDS, and they are two buttons rather than one with a
  modifier because they are two different intentions — one of them throws away
  what you were listening to. The backend keeps them as two routes for the same
  reason.

  Neither does an optimistic update. The result arrives on the next snapshot,
  which is the rule everywhere in this UI: guessing shows the wrong state
  confidently whenever a command is genuinely refused.

  THE TRACK LIST IS FLAT even for a multi-disc album, but ordered by directory
  before track number — 149 albums here keep their tracks in `CD 01`/`CD 02`
  subdirectories where both discs start at 1. The backend does that sorting.

  Rows are not tappable. These tracks have no MPD song id — they are library
  songs, not queue entries — so there is nothing for `POST /api/queue/play/:id`
  to address. Play the album.
*/
@Component({
    selector: 'app-album',
    imports: [LucideChevronLeft, LucideDisc3, LucideListPlus, LucidePlay],
    templateUrl: './album.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Album {
    private readonly library = inject(LibraryStore);
    private readonly sheet = inject(NowPlayingSheet);
    private readonly prefs = inject(Preferences);
    private readonly router = inject(Router);
    private readonly history = inject(AppHistory);

    /** Bound from `?artist=` and `?album=` by withComponentInputBinding(). */
    readonly artist = input<string>('');
    readonly album = input<string>('');

    readonly data = signal<AlbumResponse | null>(null);
    readonly error = signal<string | null>(null);

    readonly loading = computed(() => this.data() === null && this.error() === null);
    readonly tracks = computed(() => this.data()?.tracks ?? []);

    /** True while a Play or Queue request is in flight, so it cannot be double-sent. */
    readonly busy = signal(false);

    private readonly artFailed = signal<string | null>(null);

    readonly cover = computed(() => {
        const image = this.data()?.album.image ?? null;
        if (!image) return null;
        const uri = this.library.resolve(image);
        // Compare the RESOLVED url, because that is what onArtError() is handed.
        return uri === this.artFailed() ? null : uri;
    });

    readonly year = computed(() => {
        const date = this.data()?.album.date ?? null;
        const match = date === null ? null : /^(\d{4})/.exec(date);
        return match ? match[1] : null;
    });

    /** "9 tracks · 42:17" — the second line under the title. */
    readonly summary = computed(() => {
        const tracks = this.tracks();
        if (tracks.length === 0) return null;
        const count = tracks.length === 1 ? '1 track' : `${tracks.length} tracks`;
        const total = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
        // Only claim a running time when every track has one. A partial sum
        // stated as the album's length would simply be wrong.
        if (tracks.some((t) => t.duration === undefined)) return count;
        return `${count} · ${runtime(total)}`;
    });

    /** Sequence guard against two overlapping loads — see Artist for the case. */
    private request = 0;

    constructor() {
        effect(() => {
            const artist = this.artist();
            const album = this.album();
            this.data.set(null);
            this.error.set(null);
            if (artist !== '' && album !== '') void this.load(artist, album);
        });
    }

    private async load(artist: string, album: string): Promise<void> {
        const request = ++this.request;
        try {
            const data = await this.library.fetchAlbum(artist, album);
            if (request === this.request) this.data.set(data);
        } catch (err) {
            if (request === this.request) this.error.set((err as Error).message);
        }
    }

    onArtError(uri: string): void {
        this.artFailed.set(uri);
    }

    titleOf(track: Track): string {
        return track.title || track.file || 'Unknown track';
    }

    durationOf(track: Track): string {
        return clock(track.duration ?? null);
    }

    /** Clear the queue, load this album, play it — and show what is playing. */
    async play(): Promise<void> {
        await this.send(() => this.library.playAlbum(this.ref()));
        // Only on success: raising now-playing over a request that was refused
        // would show a stale screen as though the button had worked. Whether it
        // is raised at all is the user's, on the Interface tab.
        if (this.error() === null && this.prefs.openNowPlayingOnPlay()) this.sheet.show();
    }

    /** Append to the queue, and show where it landed if that is wanted. */
    async queue(): Promise<void> {
        await this.send(() => this.library.queueAlbum(this.ref()));
        if (this.error() === null && this.prefs.openQueueOnAdd()) this.sheet.showQueue();
    }

    private ref() {
        return { albumArtist: this.artist(), album: this.album() };
    }

    private async send(action: () => Promise<void>): Promise<void> {
        if (this.busy()) return;
        this.busy.set(true);
        this.error.set(null);
        try {
            await action();
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.busy.set(false);
        }
    }

    back(): void {
        // Real history back, with the artist as the fallback for a screen that
        // was loaded straight into. See AppHistory.
        this.history.back(['/library/artist'], { queryParams: { name: this.artist() } });
    }
}

/**
 * A whole album's length, as h:mm:ss or m:ss.
 *
 * Not `clock()`, which is the per-track m:ss and would render an 82 minute album
 * as "82:14". Albums routinely run past an hour here.
 */
function runtime(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const ss = String(secs).padStart(2, '0');
    return hours > 0 ? `${hours}:${String(mins).padStart(2, '0')}:${ss}` : `${mins}:${ss}`;
}
