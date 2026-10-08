import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import {
    DECADE_PRESETS,
    GENERATOR_PRESETS,
    type AlbumIdentity,
    type AlbumSummary,
    type MostPlayedArtist,
    type RecentlyAddedAlbum,
} from '@musicbox/shared';
import { PresetCard } from '../../components/preset-card/preset-card';
import { FavouritePicks, SHELF_SIZE } from '../../services/favourite-picks';
import { FavouritesStore } from '../../services/favourites-store';
import { LibraryStore } from '../../services/library-store';
import { PlaysStore } from '../../services/plays-store';
import { PresetPlayer } from '../../services/preset-player';
import { AlbumCard } from './components/album-card/album-card';
import { ArtistCard } from './components/artist-card/artist-card';
import { CdCard } from './components/cd-card/cd-card';
import { HomeSearch } from './components/search/search';
import { Shelf } from './components/shelf/shelf';
import { ShelfSkeleton } from './components/shelf-skeleton/shelf-skeleton';

/*
  The screen the box opens on. Six shelves: ten of your favourites — the same
  ten for as long as the page is loaded, see favourite-picks.ts — what was played
  lately, the radio and decade presets, who has been played most, and the newest
  albums. Only the favourites are picked at random; the rest are the first ten of
  the lists their own screens show.

  A CD IN THE DRIVE COMES FIRST of all, above the shelves: it is the one thing
  here that someone just physically did.

  FAVOURITES LEAD, then Recent Plays: picking up where you left off is the
  commonest reason to walk up to the box. The radio shelves follow, one tap to a
  fresh queue.

  A SEARCH REPLACES ALL OF IT while the field holds text; see search.ts.

  EACH SHELF SAYS ITS OWN PIECE. A box that has played nothing must not take the
  other two down with it, so loading and empty are per shelf rather than for the
  screen — and a shelf with nothing in it simply does not appear. While one is
  still waiting it holds its own shape open, see shelf-skeleton.ts; the three
  arrive at different times and the rows below must not walk up the screen.
*/
/** The query parameter carrying the search, so Back from a result returns to it. */
export const SEARCH_PARAM = 'q';

@Component({
    selector: 'app-home',
    imports: [AlbumCard, ArtistCard, CdCard, HomeSearch, PresetCard, Shelf, ShelfSkeleton],
    templateUrl: './home.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
    private readonly favourites = inject(FavouritesStore);
    private readonly library = inject(LibraryStore);
    private readonly plays = inject(PlaysStore);
    private readonly router = inject(Router);
    private readonly route = inject(ActivatedRoute);

    /** From the snapshot once, as Library's filter is: this screen also writes it. */
    readonly query = signal(this.route.snapshot.queryParamMap.get(SEARCH_PARAM) ?? '');
    readonly searching = computed(() => this.query().trim() !== '');

    readonly albums = inject(FavouritePicks).albums;

    readonly presets = GENERATOR_PRESETS;
    readonly decades = DECADE_PRESETS;
    readonly presetPlayer = inject(PresetPlayer);

    /** Null is "the stream has not answered yet", which is not an empty list. */
    readonly loading = computed(() => this.favourites.albums() === null);
    readonly empty = computed(() => this.favourites.albums()?.length === 0);

    /** What was played lately. On the stream, so there is nothing to fetch. */
    readonly played = computed(() => (this.plays.albums() ?? []).slice(0, SHELF_SIZE));
    readonly playedLoading = computed(() => this.plays.albums() === null);

    /** Who has been played most, cached in the store and shared with their own screen. */
    readonly artists = computed(() => (this.plays.artists() ?? []).slice(0, SHELF_SIZE));
    readonly artistsLoading = computed(() => this.plays.artists() === null);

    /** The newest albums, cached in the store and shared with the screen behind the shelf. */
    readonly recent = computed(() => (this.library.recentlyAdded() ?? []).slice(0, SHELF_SIZE));
    readonly recentLoading = computed(() => this.library.recentlyAdded() === null);

    constructor() {
        // On each store's generation, so a play or a scan dropping a list while
        // Home is open refetches it instead of leaving the shelf on its skeleton.
        // Errors are the See-all screens' to report; an empty shelf just hides.
        effect(() => {
            this.plays.generation();
            void this.plays.loadArtists().catch(() => {});
        });
        effect(() => {
            this.library.generation();
            void this.library.loadRecentlyAdded().catch(() => {});
        });
    }

    setQuery(value: string): void {
        this.query.set(value);
        // replaceUrl: a keystroke is not a place to go back to.
        void this.router.navigate(['/home'], {
            queryParams: { [SEARCH_PARAM]: value === '' ? null : value },
            replaceUrl: true,
        });
    }

    // Covers that 404ed. A Set: they fail independently, as on the favourites list.
    private readonly failedCovers = signal<ReadonlySet<string>>(new Set());

    // One set for both card types: it is keyed by the resolved URI, and an album
    // cover and an artist picture never share one.
    coverOf(item: { image: string | null }): string | null {
        if (!item.image) return null;
        const uri = this.library.resolve(item.image);
        return this.failedCovers().has(uri) ? null : uri;
    }

    onCoverError(uri: string): void {
        this.failedCovers.update((failed) => new Set(failed).add(uri));
    }

    trackKey(album: AlbumIdentity): string {
        return album.release;
    }

    open(album: AlbumIdentity): void {
        void this.router.navigate(['/library/album'], {
            queryParams: { artist: album.albumArtist, album: album.album, release: album.release },
        });
    }

    openArtist(artist: MostPlayedArtist): void {
        void this.router.navigate(['/library/artist'], { queryParams: { name: artist.name } });
    }
}
