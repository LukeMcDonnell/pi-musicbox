import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { AlbumIdentity, AlbumSummary, MostPlayedArtist, RecentlyAddedAlbum } from '@musicbox/shared';
import { FavouritePicks, SHELF_SIZE } from '../../services/favourite-picks';
import { FavouritesStore } from '../../services/favourites-store';
import { LibraryStore } from '../../services/library-store';
import { PlaysStore } from '../../services/plays-store';
import { AlbumCard } from './components/album-card/album-card';
import { ArtistCard } from './components/artist-card/artist-card';
import { Shelf } from './components/shelf/shelf';
import { ShelfSkeleton } from './components/shelf-skeleton/shelf-skeleton';

/*
  The screen the box opens on. Four shelves: what was played lately, who has been
  played most, the newest albums, then ten of your favourites — the same ten for
  as long as the page is loaded, see favourite-picks.ts. Only the favourites are
  picked at random; the rest are the first ten of the lists their own screens
  show.

  RECENT PLAYS LEADS because picking up where you left off is the commonest
  reason to walk up to the box, and it is the shelf that changes most.

  EACH SHELF SAYS ITS OWN PIECE. A box that has played nothing must not take the
  other two down with it, so loading and empty are per shelf rather than for the
  screen — and a shelf with nothing in it simply does not appear. While one is
  still waiting it holds its own shape open, see shelf-skeleton.ts; the three
  arrive at different times and the rows below must not walk up the screen.
*/
@Component({
    selector: 'app-home',
    imports: [AlbumCard, ArtistCard, Shelf, ShelfSkeleton],
    templateUrl: './home.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
    private readonly favourites = inject(FavouritesStore);
    private readonly library = inject(LibraryStore);
    private readonly plays = inject(PlaysStore);
    private readonly router = inject(Router);

    readonly albums = inject(FavouritePicks).albums;

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
        // Cached after the first visit, and dropped by the store when a scan
        // finishes, so coming back from an album costs the backend nothing.
        void this.library.loadRecentlyAdded().catch(() => {
            // Nothing to say on the shelf: the screen behind it reports errors,
            // and a shelf that cannot fill simply does not appear.
        });
        void this.plays.loadArtists().catch(() => {
            // Same again — and the counts are dropped when a play lands, so
            // coming back to Home after listening refetches them.
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
