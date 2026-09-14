import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideUserRound } from '@lucide/angular';
import type { ArtistSummary } from '@musicbox/shared';
import { LibraryStore } from '../../library-store';

/*
  The Library screen: every artist in the library, in one list.

  A LIST, NOT A GRID. The row carries three things — picture, name, and how many
  albums — and a grid of 487 square covers gives up the last two to fit more of
  the first. This is the same row the queue uses, for the same reasons.

  MPD'S ORDER, UNCHANGED. The backend returns `list album group albumartist`,
  which MPD sorts by AlbumArtist, and that is what is rendered. No letter
  headers, no index rail, no stripping of a leading "The" — `!!!` and `2Pac` sit
  ahead of the letters and `The Panics` sits under T, because those are MPD's
  answers and a second opinion about sorting is a thing to maintain forever.

  REPAINTS: no transitions, no animations, every picture `loading="lazy"` in a
  fixed box. This is the longest list in the UI and scrolling it is the most
  repaint-heavy thing here; on the DSI panel every repaint is a vc4 atomic
  commit. See .claude/docs/clock-deadlock.md.
*/
@Component({
    selector: 'app-library',
    imports: [LucideUserRound],
    templateUrl: './library.html',
    // 487 rows that depend on nothing but signals. There is no reason to
    // re-check them when the 1Hz now-playing ticker fires.
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Library {
    private readonly library = inject(LibraryStore);
    private readonly router = inject(Router);

    /**
     * The list, from the store's cache.
     *
     * Null until the first fetch lands — which is a different state from an
     * empty library, and the template says so.
     */
    readonly artists = this.library.artists;

    readonly error = signal<string | null>(null);

    readonly loading = computed(() => this.artists() === null && this.error() === null);

    constructor() {
        // Cached after the first visit, so coming back from an album is instant
        // and costs the backend nothing. See LibraryStore.
        void this.load();
    }

    async load(): Promise<void> {
        this.error.set(null);
        try {
            await this.library.loadArtists();
        } catch (err) {
            this.error.set((err as Error).message);
        }
    }

    /**
     * Pictures that 404ed, by resolved URI.
     *
     * A Set, like the queue's: many rows fail independently, and 16 of this
     * library's artists have no image file. One miss hides the placeholder for
     * that artist and never retries.
     */
    private readonly artFailed = signal<ReadonlySet<string>>(new Set());

    /** The picture for a row, or null when there is none to show. */
    artOf(artist: ArtistSummary): string | null {
        if (!artist.image) return null;
        // Through the resolver: the server sends a root-relative path and an
        // <img> would otherwise resolve it against the PAGE's origin.
        const uri = this.library.resolve(artist.image);
        return this.artFailed().has(uri) ? null : uri;
    }

    onArtError(uri: string): void {
        this.artFailed.update((failed) => new Set(failed).add(uri));
    }

    albumsLabel(artist: ArtistSummary): string {
        return artist.albumCount === 1 ? '1 album' : `${artist.albumCount} albums`;
    }

    /**
     * Open an artist.
     *
     * The name travels as a QUERY PARAMETER, not a path segment: `AC/DC` is a
     * real artist here, and carrying that in a path means `%2F`, which routers
     * and proxies are entitled to normalise back. Same reason /api/art uses one.
     */
    open(artist: ArtistSummary): void {
        void this.router.navigate(['/library/artist'], { queryParams: { name: artist.name } });
    }
}
