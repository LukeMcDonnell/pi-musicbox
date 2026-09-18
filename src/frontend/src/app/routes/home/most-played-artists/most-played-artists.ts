import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { VirtualScrollerComponent, VirtualScrollerModule } from '@iharbeck/ngx-virtual-scroller';
import { LucideChevronLeft } from '@lucide/angular';
import type { MostPlayedArtist } from '@musicbox/shared';
import { ARTIST_ROW_HEIGHT, ArtistRow } from '../../../components/artist-row/artist-row';
import { LibraryStore } from '../../../services/library-store';
import { AppHistory } from '../../../services/app-history';
import { PlaysStore } from '../../../services/plays-store';
import { ScrollFrame } from '../../../services/scroll-frame';
import { playsLabel } from '../components/artist-card/artist-card';

/*
  The artists the box has played most, all time.

  A LIST, NOT A GRID, for the reason the Library gives: a row carries the
  picture, the name and the count, where a grid of squares gives up the last two
  to fit more of the first.

  NO PLAY OR QUEUE on a row. The library's play and queue take an album, so there
  is nothing an artist row could send; tapping one opens the artist.

  Fetched rather than read off the stream — an all-time count does not reorder on
  one play. PlaysStore drops its cache when a play lands, so coming back here
  after listening to something shows the new counts.
*/
@Component({
    selector: 'app-most-played-artists',
    imports: [ArtistRow, LucideChevronLeft, VirtualScrollerModule],
    templateUrl: './most-played-artists.html',
    // Replaces the scroller's 1Hz resize polling, as on the Library.
    host: { '(window:resize)': 'onResize()' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MostPlayedArtists {
    private readonly plays = inject(PlaysStore);
    private readonly library = inject(LibraryStore);
    private readonly router = inject(Router);
    private readonly history = inject(AppHistory);

    /** Null until the first fetch lands, which is not the same as none. */
    readonly artists = this.plays.artists;
    readonly loading = computed(() => this.artists() === null && this.error() === null);

    /** "487 Artists", or "1 Artist". */
    readonly countLabel = computed(() => {
        const count = this.artists()?.length ?? 0;
        return `${count} ${count === 1 ? 'Artist' : 'Artists'}`;
    });

    readonly error = signal<string | null>(null);
    private readonly failedArt = signal<ReadonlySet<string>>(new Set());

    /** The <main> element, or null before App's view exists. See ScrollFrame. */
    readonly frame = inject(ScrollFrame).element;
    readonly rowHeight = ARTIST_ROW_HEIGHT;

    /** The rows the scroller has on screen, plus its buffer, and where they start. */
    readonly visible = signal<MostPlayedArtist[]>([]);
    readonly firstIndex = signal(0);

    private readonly scroller = viewChild(VirtualScrollerComponent);

    constructor() {
        void this.load();
    }

    async load(): Promise<void> {
        this.error.set(null);
        try {
            await this.plays.loadArtists();
        } catch (err) {
            this.error.set((err as Error).message);
        }
    }

    back(): void {
        // Real history back, with Home as the fallback for a screen that was
        // loaded straight into. See AppHistory.
        this.history.back(['/home']);
    }

    onViewport(items: MostPlayedArtist[]): void {
        this.visible.set(items);
        this.firstIndex.set(this.scroller()?.viewPortInfo.startIndexWithBuffer ?? 0);
    }

    onResize(): void {
        this.scroller()?.refresh();
    }

    artOf(artist: MostPlayedArtist): string | null {
        if (!artist.image) return null;
        const uri = this.library.resolve(artist.image);
        return this.failedArt().has(uri) ? null : uri;
    }

    onArtError(uri: string): void {
        this.failedArt.update((failed) => new Set(failed).add(uri));
    }

    detailOf(artist: MostPlayedArtist): string {
        return playsLabel(artist.plays);
    }

    open(artist: MostPlayedArtist): void {
        void this.router.navigate(['/library/artist'], { queryParams: { name: artist.name } });
    }
}
