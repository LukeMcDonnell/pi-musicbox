import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { VirtualScrollerComponent, VirtualScrollerModule } from '@iharbeck/ngx-virtual-scroller';
import { LucideArrowDownWideNarrow, LucideArrowUpNarrowWide, LucideSearch, LucideX } from '@lucide/angular';
import type { FavouriteAlbum } from '@musicbox/shared';
import { ALBUM_ROW_HEIGHT, AlbumRow } from '../../components/album-row/album-row';
import { FavouritesStore } from '../../services/favourites-store';
import { LibraryStore } from '../../services/library-store';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { ScrollFrame } from '../../services/scroll-frame';
import { fold, squeeze } from '../../services/text-match';
import {
    FAVOURITES_SORT_OPTIONS,
    Preferences,
    type FavouritesSortBy,
} from '../../services/preferences';
import { SettingSelect, type SettingOption } from '../settings/components/setting-select/setting-select';

/** The favourite albums, sorted as this device last asked. Play and Queue as on the album screen. */
@Component({
    selector: 'app-favourites',
    imports: [
        AlbumRow,
        LucideArrowDownWideNarrow,
        LucideArrowUpNarrowWide,
        LucideSearch,
        LucideX,
        SettingSelect,
        VirtualScrollerModule,
    ],
    templateUrl: './favourites.html',
    // Replaces the scroller's 1Hz resize polling, as on the Library.
    host: { '(window:resize)': 'onResize()' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Favourites {
    private readonly favourites = inject(FavouritesStore);
    private readonly library = inject(LibraryStore);
    private readonly sheet = inject(NowPlayingSheet);
    readonly prefs = inject(Preferences);
    private readonly router = inject(Router);
    private readonly route = inject(ActivatedRoute);

    // SettingSelect speaks numbers, so the dropdown's value is the option's index.
    readonly sortOptions: readonly SettingOption[] = FAVOURITES_SORT_OPTIONS.map((o, i) => ({
        value: i,
        label: o.label,
    }));
    readonly sortIndex = computed(() =>
        FAVOURITES_SORT_OPTIONS.findIndex((o) => o.value === this.prefs.favouritesSortBy()),
    );

    /** Seeded from `?filter=` once, as the Library's is, so Back restores it. */
    readonly query = signal(this.route.snapshot.queryParamMap.get('filter') ?? '');

    readonly loading = computed(() => this.favourites.albums() === null);
    readonly total = computed(() => this.favourites.albums()?.length ?? 0);
    readonly albums = computed(() =>
        sortFavourites(
            filterFavourites(this.favourites.albums() ?? [], this.query()),
            this.prefs.favouritesSortBy(),
            this.prefs.favouritesSortDescending(),
        ),
    );

    /** "22 Albums", or "3 of 22 Albums" while a filter narrows it. */
    readonly countLabel = computed(() => {
        const total = this.total();
        const shown = this.albums().length;
        const noun = total === 1 ? 'Album' : 'Albums';
        return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
    });

    /** The <main> element, or null before App's view exists. See ScrollFrame. */
    readonly frame = inject(ScrollFrame).element;
    readonly rowHeight = ALBUM_ROW_HEIGHT;

    /** The rows the scroller has on screen, plus its buffer, and where they start. */
    readonly visible = signal<FavouriteAlbum[]>([]);
    readonly firstIndex = signal(0);

    private readonly scroller = viewChild(VirtualScrollerComponent);

    onViewport(items: FavouriteAlbum[]): void {
        this.visible.set(items);
        this.firstIndex.set(this.scroller()?.viewPortInfo.startIndexWithBuffer ?? 0);
    }

    onResize(): void {
        this.scroller()?.refresh();
    }

    /** Back to the top before the rows change, so the scroller refreshes from there. */
    private toTop(): void {
        const frame = this.frame();
        if (frame && frame.scrollTop > 0) frame.scrollTop = 0;
    }

    readonly busy = signal(false);
    readonly error = signal<string | null>(null);
    private readonly failedCovers = signal<ReadonlySet<string>>(new Set());

    setQuery(value: string): void {
        this.toTop();
        this.query.set(value);
        // replaceUrl: a keystroke is not a place to go back to.
        void this.router.navigate(['/favourites'], {
            queryParams: { filter: value === '' ? null : value },
            replaceUrl: true,
        });
    }

    setSort(index: number): void {
        const option = FAVOURITES_SORT_OPTIONS[index];
        if (!option) return;
        this.toTop();
        this.prefs.set('favouritesSortBy', option.value);
    }

    toggleDirection(): void {
        this.toTop();
        this.prefs.set('favouritesSortDescending', !this.prefs.favouritesSortDescending());
    }

    coverOf(album: FavouriteAlbum): string | null {
        if (!album.image) return null;
        const uri = this.library.resolve(album.image);
        return this.failedCovers().has(uri) ? null : uri;
    }

    onCoverError(uri: string): void {
        this.failedCovers.update((failed) => new Set(failed).add(uri));
    }

    trackKey(album: FavouriteAlbum): string {
        return album.release;
    }

    subtitleOf(album: FavouriteAlbum): string {
        const year = yearOf(album.date);
        return year === null ? album.albumArtist : `${album.albumArtist} · ${year}`;
    }

    open(album: FavouriteAlbum): void {
        void this.router.navigate(['/library/album'], {
            queryParams: { artist: album.albumArtist, album: album.album, release: album.release },
        });
    }

    async play(album: FavouriteAlbum): Promise<void> {
        const ok = await this.send(() => this.library.playAlbum(refOf(album)));
        if (ok && this.prefs.openNowPlayingOnPlay()) this.sheet.show();
    }

    async queue(album: FavouriteAlbum): Promise<void> {
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

function refOf(album: FavouriteAlbum) {
    return { albumArtist: album.albumArtist, album: album.album, release: album.release };
}

function yearOf(date: string | null): number | null {
    const match = date === null ? null : /^(\d{4})/.exec(date);
    return match ? Number(match[1]) : null;
}

/** Albums whose artist or title contains the term, accents and punctuation ignored like the Library's. */
export function filterFavourites(albums: readonly FavouriteAlbum[], query: string): readonly FavouriteAlbum[] {
    const needle = fold(query.trim());
    if (needle === '') return albums;
    // `!!!` squeezes to '', which would match everything.
    const squeezed = squeeze(needle);
    return albums.filter((album) =>
        [album.albumArtist, album.album].some((text) => {
            const folded = fold(text);
            return folded.includes(needle) || (squeezed !== '' && squeeze(folded).includes(squeezed));
        }),
    );
}

/** Undated albums go last in both directions, as they do on the artist screen. */
function compareReleased(a: FavouriteAlbum, b: FavouriteAlbum, descending: boolean): number {
    const ya = yearOf(a.date);
    const yb = yearOf(b.date);
    if (ya === null || yb === null) return ya === yb ? 0 : ya === null ? 1 : -1;
    const sign = descending ? -1 : 1;
    if (ya !== yb) return sign * (ya - yb);
    return a.date === b.date ? 0 : sign * (a.date! < b.date! ? -1 : 1);
}

export function sortFavourites(
    albums: readonly FavouriteAlbum[],
    by: FavouritesSortBy,
    descending: boolean,
): FavouriteAlbum[] {
    const sign = descending ? -1 : 1;
    const title = (a: FavouriteAlbum, b: FavouriteAlbum) => a.album.localeCompare(b.album);
    const artist = (a: FavouriteAlbum, b: FavouriteAlbum) => a.albumArtist.localeCompare(b.albumArtist);
    const compare = (a: FavouriteAlbum, b: FavouriteAlbum): number => {
        switch (by) {
            case 'added':
                return sign * (a.addedAt - b.addedAt) || artist(a, b) || title(a, b);
            case 'released':
                return compareReleased(a, b, descending) || artist(a, b) || title(a, b);
            case 'title':
                return sign * title(a, b) || artist(a, b);
            case 'artist':
                // An artist's albums stay oldest first whichever way the artists run.
                return sign * artist(a, b) || compareReleased(a, b, false) || title(a, b);
        }
    };
    return [...albums].sort(compare);
}
