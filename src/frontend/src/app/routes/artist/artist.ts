import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideChevronLeft, LucideDisc3, LucideListPlus, LucidePlay, LucideUserRound } from '@lucide/angular';
import type { AlbumSummary } from '@musicbox/shared';
import { AppHistory } from '../../services/app-history';
import { LibraryStore } from '../../services/library-store';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { Preferences } from '../../services/preferences';
import { Rating } from '../../components/rating/rating';
import { FavouriteButton } from '../../components/favourite-button/favourite-button';
import { CoverArt } from '../../components/cover-art/cover-art';

/*
  One artist: their picture as a hero, then their albums oldest first.

  THE YEAR IS THE RELEASE YEAR, NOT THE PRESSING. The backend prefers the
  `OriginalDate` tag over `Date` — 940 of this library's 2,758 albums are
  remasters whose `Date` is decades after the record, which would date `Back in
  Black` to 2003 and put AC/DC's whole catalogue in 2020. See library.ts there.

  `name` arrives as a QUERY PARAMETER because `AC/DC` is a real artist and a
  slash cannot travel in a path segment. See app.routes.ts.
*/
@Component({
    selector: 'app-artist',
    imports: [
        CoverArt,
        FavouriteButton,
        Rating,
        LucideChevronLeft,
        LucideDisc3,
        LucideListPlus,
        LucidePlay,
        LucideUserRound,
    ],
    templateUrl: './artist.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Artist {
    private readonly library = inject(LibraryStore);
    private readonly router = inject(Router);
    private readonly history = inject(AppHistory);
    private readonly sheet = inject(NowPlayingSheet);
    private readonly prefs = inject(Preferences);

    /** Bound from `?name=` by withComponentInputBinding(). */
    readonly name = input<string>('');

    readonly albums = signal<AlbumSummary[] | null>(null);
    readonly error = signal<string | null>(null);

    /** True while a Play or Queue request is in flight, so it cannot be double-sent. */
    readonly busy = signal(false);

    readonly loading = computed(() => this.albums() === null && this.error() === null);

    /**
     * The artist's picture, from the response this screen fetched itself.
     *
     * NOT FROM THE CACHED ARTIST LIST, which is what it read at first. That
     * worked when the screen was reached by tapping a row and failed silently
     * otherwise — the kiosk reloads the page on every deploy and a phone can
     * hold a bookmark, and in both cases the list is empty and the hero fell
     * back to the placeholder. Caught in a screenshot of the real device.
     */
    readonly image = computed(() => {
        const path = this.artistImage();
        if (path === null) return null;
        const uri = this.library.resolve(path);
        return uri === this.artFailed() ? null : uri;
    });

    private readonly artistImage = signal<string | null>(null);

    /**
     * The artist's biography, from the same response as the picture.
     *
     * EXPECT IT TO BE NULL: 446 of this library's 506 artists have none the box
     * can reach, so the hero has to read well without one. It comes from the
     * NAS's `.nfo` files by way of the backend's harvest, never from MPD.
     *
     * The response carries the artist's RATING too, and nothing reads it: only
     * albums show a rating. See decisions.md.
     */
    readonly biography = signal<string | null>(null);

    /**
     * Whether the biography is expanded. Collapsed to three lines by default:
     * they run to ~1,000 characters and the hero is the top of the screen, not
     * the point of it.
     */
    readonly bioOpen = signal(false);

    toggleBio(): void {
        this.bioOpen.update((open) => !open);
    }

    private readonly artFailed = signal<string | null>(null);

    /**
     * Sequence number of the most recent load.
     *
     * Navigating artist → back → a different artist quickly means two fetches in
     * flight, and the responses can land in either order. Rendering the older
     * one would show the wrong artist's albums under the right artist's name.
     * Same guard as MusicboxApi uses for the queue.
     */
    private request = 0;

    constructor() {
        // Refetches when `name` changes, which includes navigating from one
        // artist to another without the component being destroyed.
        effect(() => {
            const name = this.name();
            this.albums.set(null);
            this.artistImage.set(null);
            this.biography.set(null);
            this.bioOpen.set(false);
            this.error.set(null);
            if (name !== '') void this.load(name);
        });
    }

    private async load(name: string): Promise<void> {
        const request = ++this.request;
        try {
            const { albums, image, biography } = await this.library.fetchAlbums(name);
            if (request === this.request) {
                this.artistImage.set(image);
                this.biography.set(biography);
                this.albums.set(albums);
            }
        } catch (err) {
            if (request === this.request) this.error.set((err as Error).message);
        }
    }

    onArtError(uri: string): void {
        this.artFailed.set(uri);
    }

    /** Covers that 404ed. A Set: 13 albums here have none, independently. */
    private readonly coverFailed = signal<ReadonlySet<string>>(new Set());

    coverOf(album: AlbumSummary): string | null {
        if (!album.image) return null;
        const uri = this.library.resolve(album.image);
        return this.coverFailed().has(uri) ? null : uri;
    }

    onCoverError(uri: string): void {
        this.coverFailed.update((failed) => new Set(failed).add(uri));
    }

    /**
     * The year, or an em dash.
     *
     * The leading four digits, because `date` is free text on the wire — it
     * arrives as `1997`, `1997-06-16` and occasionally worse, and parsing it
     * server-side would throw away information a later screen might want.
     */
    yearOf(album: AlbumSummary): string {
        const match = album.date === null ? null : /^(\d{4})/.exec(album.date);
        return match ? match[1] : '—';
    }

    tracksLabel(album: AlbumSummary): string {
        return album.trackCount === 1 ? '1 track' : `${album.trackCount} tracks`;
    }

    /** "12 tracks · 1995" — the year left off, not dashed, when undated. */
    detailsOf(album: AlbumSummary): string {
        const year = this.yearOf(album);
        return year === '—' ? this.tracksLabel(album) : `${this.tracksLabel(album)} · ${year}`;
    }

    /** Play and Queue as on the album screen, including whether now-playing is raised. */
    async play(album: AlbumSummary): Promise<void> {
        const ok = await this.send(() => this.library.playAlbum(refOf(album)));
        if (ok && this.prefs.openNowPlayingOnPlay()) this.sheet.show();
    }

    async queue(album: AlbumSummary): Promise<void> {
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

    open(album: AlbumSummary): void {
        void this.router.navigate(['/library/album'], {
            queryParams: { artist: album.albumArtist, album: album.album, release: album.release },
        });
    }

    back(): void {
        // Back, not up — it used to be the other way round. The library is worth
        // returning to where you left it, filter and scroll position both, and
        // only real history does that. See decisions.md.
        this.history.back(['/library']);
    }
}

function refOf(album: AlbumSummary) {
    return { albumArtist: album.albumArtist, album: album.album, release: album.release };
}
