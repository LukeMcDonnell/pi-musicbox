import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { VirtualScrollerComponent, VirtualScrollerModule } from '@iharbeck/ngx-virtual-scroller';
import { LucideChevronLeft } from '@lucide/angular';
import type { RecentPlayAlbum } from '@musicbox/shared';
import { ALBUM_ROW_HEIGHT, AlbumRow } from '../../../components/album-row/album-row';
import { ago } from '../../../services/ago';
import { AppHistory } from '../../../services/app-history';
import { LibraryStore } from '../../../services/library-store';
import { NowPlayingSheet } from '../../../services/now-playing-sheet';
import { PlaysStore } from '../../../services/plays-store';
import { Preferences } from '../../../services/preferences';
import { ScrollFrame } from '../../../services/scroll-frame';

/*
  The albums the box has played, most recent first.

  NOTHING IS FETCHED. The list arrives on the stream, so this screen has no
  loader and no error of its own — null is "the stream has not answered yet".

  WHAT COUNTS AS A PLAY is decided on the box, not here: thirty seconds of
  playing, MPD only. See src/backend/src/play-watch.ts and the note in api.ts.

  The row reads "Artist · 2 hours ago". The list is already in time order, so the
  release year the other album lists show would say nothing here.
*/
@Component({
    selector: 'app-recent-plays',
    imports: [AlbumRow, LucideChevronLeft, VirtualScrollerModule],
    templateUrl: './recent-plays.html',
    // Replaces the scroller's 1Hz resize polling, as on the Library.
    host: { '(window:resize)': 'onResize()' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecentPlays {
    private readonly plays = inject(PlaysStore);
    private readonly library = inject(LibraryStore);
    private readonly sheet = inject(NowPlayingSheet);
    private readonly prefs = inject(Preferences);
    private readonly router = inject(Router);
    private readonly history = inject(AppHistory);

    /** Null until the first frame, which is not the same as none. */
    readonly albums = this.plays.albums;
    readonly loading = computed(() => this.albums() === null);

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
    readonly visible = signal<RecentPlayAlbum[]>([]);
    readonly firstIndex = signal(0);

    private readonly scroller = viewChild(VirtualScrollerComponent);

    back(): void {
        // Real history back, with Home as the fallback for a screen that was
        // loaded straight into. See AppHistory.
        this.history.back(['/home']);
    }

    onViewport(items: RecentPlayAlbum[]): void {
        this.visible.set(items);
        this.firstIndex.set(this.scroller()?.viewPortInfo.startIndexWithBuffer ?? 0);
    }

    onResize(): void {
        this.scroller()?.refresh();
    }

    coverOf(album: RecentPlayAlbum): string | null {
        if (!album.image) return null;
        const uri = this.library.resolve(album.image);
        return this.failedCovers().has(uri) ? null : uri;
    }

    onCoverError(uri: string): void {
        this.failedCovers.update((failed) => new Set(failed).add(uri));
    }

    trackKey(album: RecentPlayAlbum): string {
        return JSON.stringify([album.albumArtist, album.album]);
    }

    /** "Radiohead · 20 minutes ago". */
    subtitleOf(album: RecentPlayAlbum): string {
        return `${album.albumArtist} · ${ago(album.playedAt, Date.now())}`;
    }

    open(album: RecentPlayAlbum): void {
        void this.router.navigate(['/library/album'], {
            queryParams: { artist: album.albumArtist, album: album.album },
        });
    }

    async play(album: RecentPlayAlbum): Promise<void> {
        const ok = await this.send(() => this.library.playAlbum(refOf(album)));
        if (ok && this.prefs.openNowPlayingOnPlay()) this.sheet.show();
    }

    async queue(album: RecentPlayAlbum): Promise<void> {
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

function refOf(album: RecentPlayAlbum) {
    return { albumArtist: album.albumArtist, album: album.album };
}
