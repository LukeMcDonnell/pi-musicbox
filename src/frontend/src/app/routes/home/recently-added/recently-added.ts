import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { VirtualScrollerComponent, VirtualScrollerModule } from '@iharbeck/ngx-virtual-scroller';
import { LucideChevronLeft } from '@lucide/angular';
import type { RecentlyAddedAlbum } from '@musicbox/shared';
import { ALBUM_ROW_HEIGHT, AlbumRow } from '../../../components/album-row/album-row';
import { AppHistory } from '../../../services/app-history';
import { LibraryStore } from '../../../services/library-store';
import { NowPlayingSheet } from '../../../services/now-playing-sheet';
import { Preferences } from '../../../services/preferences';
import { ScrollFrame } from '../../../services/scroll-frame';

/*
  The albums MPD saw most recently, newest first.

  THE SERVER'S ORDER IS THE ORDER. No filter and no sort control, unlike
  Favourites: this screen answers one question, and a sort that could reorder it
  would take away the only thing it says. The list is capped at
  RECENTLY_ADDED_LIMIT by the backend and there is no pagination behind it.

  NO TRACK COUNT ON A ROW. The backend groups these out of a window of songs
  sorted by `Added`, which cuts albums off part way — see the note in api.ts.
  The row reads "Artist · year", exactly as the Favourites rows do.
*/
@Component({
    selector: 'app-recently-added',
    imports: [AlbumRow, LucideChevronLeft, VirtualScrollerModule],
    templateUrl: './recently-added.html',
    // Replaces the scroller's 1Hz resize polling, as on the Library.
    host: { '(window:resize)': 'onResize()' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecentlyAdded {
    private readonly library = inject(LibraryStore);
    private readonly sheet = inject(NowPlayingSheet);
    private readonly prefs = inject(Preferences);
    private readonly router = inject(Router);
    private readonly history = inject(AppHistory);

    /** Null until the first fetch lands, which is not the same as none. */
    readonly albums = this.library.recentlyAdded;
    readonly loading = computed(() => this.albums() === null && this.error() === null);

    /** "100 Albums", or "1 Album". */
    readonly countLabel = computed(() => {
        const count = this.albums()?.length ?? 0;
        return `${count} ${count === 1 ? 'Album' : 'Albums'}`;
    });

    readonly busy = signal(false);
    readonly error = signal<string | null>(null);
    private readonly failedCovers = signal<ReadonlySet<string>>(new Set());

    /** The <main> element, or null before App's view exists. See ScrollFrame. */
    readonly frame = inject(ScrollFrame).element;
    readonly rowHeight = ALBUM_ROW_HEIGHT;

    /** The rows the scroller has on screen, plus its buffer, and where they start. */
    readonly visible = signal<RecentlyAddedAlbum[]>([]);
    readonly firstIndex = signal(0);

    private readonly scroller = viewChild(VirtualScrollerComponent);

    constructor() {
        void this.load();
    }

    async load(): Promise<void> {
        this.error.set(null);
        try {
            await this.library.loadRecentlyAdded();
        } catch (err) {
            this.error.set((err as Error).message);
        }
    }

    back(): void {
        // Real history back, with Home as the fallback for a screen that was
        // loaded straight into. See AppHistory.
        this.history.back(['/home']);
    }

    onViewport(items: RecentlyAddedAlbum[]): void {
        this.visible.set(items);
        this.firstIndex.set(this.scroller()?.viewPortInfo.startIndexWithBuffer ?? 0);
    }

    onResize(): void {
        this.scroller()?.refresh();
    }

    coverOf(album: RecentlyAddedAlbum): string | null {
        if (!album.image) return null;
        const uri = this.library.resolve(album.image);
        return this.failedCovers().has(uri) ? null : uri;
    }

    onCoverError(uri: string): void {
        this.failedCovers.update((failed) => new Set(failed).add(uri));
    }

    trackKey(album: RecentlyAddedAlbum): string {
        return JSON.stringify([album.albumArtist, album.album]);
    }

    /** "Radiohead · 1997", or just the artist when the album carries no date. */
    subtitleOf(album: RecentlyAddedAlbum): string {
        const match = album.date === null ? null : /^(\d{4})/.exec(album.date);
        return match ? `${album.albumArtist} · ${match[1]}` : album.albumArtist;
    }

    open(album: RecentlyAddedAlbum): void {
        void this.router.navigate(['/library/album'], {
            queryParams: { artist: album.albumArtist, album: album.album },
        });
    }

    async play(album: RecentlyAddedAlbum): Promise<void> {
        const ok = await this.send(() => this.library.playAlbum(refOf(album)));
        if (ok && this.prefs.openNowPlayingOnPlay()) this.sheet.show();
    }

    async queue(album: RecentlyAddedAlbum): Promise<void> {
        const ok = await this.send(() => this.library.queueAlbum(refOf(album)));
        if (ok && this.prefs.openQueueOnAdd()) this.sheet.showQueue();
    }

    private async send(action: () => Promise<void>): Promise<boolean> {
        if (this.busy()) return false;
        this.busy.set(true);
        this.error.set(null);
        try {
            await action();
            return true;
        } catch (err) {
            this.error.set((err as Error).message);
            return false;
        } finally {
            this.busy.set(false);
        }
    }
}

function refOf(album: RecentlyAddedAlbum) {
    return { albumArtist: album.albumArtist, album: album.album };
}
