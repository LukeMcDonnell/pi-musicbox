import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { AlbumSummary } from '@musicbox/shared';
import { FavouritePicks } from '../../services/favourite-picks';
import { FavouritesStore } from '../../services/favourites-store';
import { LibraryStore } from '../../services/library-store';
import { AlbumCard } from './components/album-card/album-card';
import { Shelf } from './components/shelf/shelf';

/*
  The screen the box opens on. One shelf so far: ten of your favourites, the same
  ten for as long as the page is loaded — see favourite-picks.ts.
*/
@Component({
    selector: 'app-home',
    imports: [AlbumCard, Shelf],
    templateUrl: './home.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
    private readonly favourites = inject(FavouritesStore);
    private readonly library = inject(LibraryStore);
    private readonly router = inject(Router);

    readonly albums = inject(FavouritePicks).albums;

    /** Null is "the stream has not answered yet", which is not an empty list. */
    readonly loading = computed(() => this.favourites.albums() === null);
    readonly empty = computed(() => this.favourites.albums()?.length === 0);

    // Covers that 404ed. A Set: they fail independently, as on the favourites list.
    private readonly failedCovers = signal<ReadonlySet<string>>(new Set());

    coverOf(album: AlbumSummary): string | null {
        if (!album.image) return null;
        const uri = this.library.resolve(album.image);
        return this.failedCovers().has(uri) ? null : uri;
    }

    onCoverError(uri: string): void {
        this.failedCovers.update((failed) => new Set(failed).add(uri));
    }

    trackKey(album: AlbumSummary): string {
        return JSON.stringify([album.albumArtist, album.album]);
    }

    open(album: AlbumSummary): void {
        void this.router.navigate(['/library/album'], {
            queryParams: { artist: album.albumArtist, album: album.album },
        });
    }
}
