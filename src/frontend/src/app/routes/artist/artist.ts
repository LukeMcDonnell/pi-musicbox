import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
    LucideChevronLeft,
    LucideDisc3,
    LucideEllipsisVertical,
    LucideListEnd,
    LucideListPlus,
    LucidePlay,
    LucideUserRound,
} from '@lucide/angular';
import type { AlbumSummary, ArtistSummary, Track } from '@musicbox/shared';
import { AppHistory } from '../../services/app-history';
import { LibraryStore } from '../../services/library-store';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { Preferences } from '../../services/preferences';
import { Rating } from '../../components/rating/rating';
import { FavouriteButton } from '../../components/favourite-button/favourite-button';
import { CoverArt } from '../../components/cover-art/cover-art';
import { AlbumMenu } from '../../components/album-menu/album-menu';
import { MusicboxApi } from '../../services/musicbox-api';
import { TrackMenu } from '../../components/track-menu/track-menu';
import { AboutText } from '../../components/about-text/about-text';
import { PlaylistAdd } from '../../components/playlist-add/playlist-add';
import { clock } from '../../components/now-playing/now-playing';

/** Popular tracks shown before "Show more". */
export const POPULAR_FOLDED = 5;

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
        AboutText,
        AlbumMenu,
        PlaylistAdd,
        TrackMenu,
        CoverArt,
        FavouriteButton,
        Rating,
        LucideChevronLeft,
        LucideDisc3,
        LucideEllipsisVertical,
        LucideListEnd,
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
    private readonly api = inject(MusicboxApi);

    /** Bound from `?name=` by withComponentInputBinding(). */
    readonly name = input<string>('');

    readonly albums = signal<AlbumSummary[] | null>(null);
    readonly error = signal<string | null>(null);

    /** True while a Play or Queue request is in flight, so it cannot be double-sent. */
    readonly busy = signal(false);

    /** The album whose ⋮ menu is open, or null. */
    readonly menuAlbum = signal<AlbumSummary | null>(null);
    readonly notice = signal<string | null>(null);

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
     * The share's `.nfo` biography, else Wikipedia's; null until harvested, so
     * the hero must read well without one. The response's RATING is read by
     * nothing: only albums show one. See decisions.md.
     */
    readonly biography = signal<string | null>(null);

    /** Set when the biography is Wikipedia's rather than the share's. */
    readonly biographyUrl = signal<string | null>(null);

    /** MusicBrainz's genres, most voted first. */
    readonly genres = signal<string[]>([]);
    readonly genreLine = computed(() => {
        const genres = this.genres();
        return genres.length === 0 ? null : genres.map(titleCase).join(', ');
    });

    /** The artist's most-listened tracks in the library, per ListenBrainz. */
    readonly popular = signal<Track[]>([]);
    readonly popularOpen = signal(false);
    readonly popularShown = computed(() =>
        this.popularOpen() ? this.popular() : this.popular().slice(0, POPULAR_FOLDED),
    );

    /** Similar artists the library also holds. */
    readonly similar = signal<ArtistSummary[]>([]);

    /** Every popular track's file, not only the ones unfolded. */
    readonly popularFiles = computed(() => this.popular().flatMap((t) => (t.file === undefined ? [] : [t.file])));

    /** The files being added to a playlist, while that dialog is open. */
    readonly playlistFiles = signal<string[] | null>(null);

    /** The popular track whose ⋮ menu is open, or null. */
    readonly menuTrack = signal<Track | null>(null);

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
            this.biographyUrl.set(null);
            this.genres.set([]);
            this.popular.set([]);
            this.popularOpen.set(false);
            this.similar.set([]);
            this.error.set(null);
            this.notice.set(null);
            if (name !== '') void this.load(name);
        });
    }

    private async load(name: string): Promise<void> {
        const request = ++this.request;
        try {
            const body = await this.library.fetchAlbums(name);
            if (request === this.request) {
                this.artistImage.set(body.image);
                this.biography.set(body.biography);
                this.biographyUrl.set(body.biographyUrl ?? null);
                this.genres.set(body.artistGenres ?? []);
                this.popular.set(body.popular ?? []);
                this.similar.set(body.similar ?? []);
                this.albums.set(body.albums);
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

    pictureOf(artist: ArtistSummary): string | null {
        if (!artist.image) return null;
        const uri = this.library.resolve(artist.image);
        return this.coverFailed().has(uri) ? null : uri;
    }

    durationOf(track: Track): string {
        return clock(track.duration ?? null);
    }

    /** The track's own album, from that track — the same as Play on the album screen. */
    async playPopular(track: Track): Promise<void> {
        if (track.albumArtist === undefined || track.album === undefined || track.release === undefined) return;
        const ref = { albumArtist: track.albumArtist, album: track.album, release: track.release };
        const ok = await this.send(() => this.library.playAlbum(ref, track.file));
        if (ok && this.prefs.openNowPlayingOnPlay()) this.sheet.show();
    }

    async queueTrack(track: Track): Promise<void> {
        const file = track.file;
        if (file === undefined) return;
        const ok = await this.send(() => this.library.queueTrack(file));
        if (ok && this.prefs.openQueueOnAdd()) this.sheet.showQueue();
    }

    async playTrackNext(track: Track): Promise<void> {
        const file = track.file;
        if (file === undefined) return;
        const starts = this.api.snapshot()?.queueLength === 0;
        if (!(await this.send(() => this.library.playTrackNext(file)))) return;
        if (starts) {
            if (this.prefs.openNowPlayingOnPlay()) this.sheet.show();
        } else if (this.prefs.openQueueOnAdd()) {
            this.sheet.showQueue();
        }
    }

    async playPopularAll(): Promise<void> {
        const files = this.popularFiles();
        if (files.length === 0) return;
        const ok = await this.send(() => this.library.playTracks(files));
        if (ok && this.prefs.openNowPlayingOnPlay()) this.sheet.show();
    }

    async queuePopularAll(): Promise<void> {
        const files = this.popularFiles();
        if (files.length === 0) return;
        // Read before sending: the server starts playback only into an empty queue.
        const starts = this.api.snapshot()?.queueLength === 0;
        if (!(await this.send(() => this.library.queueTracks(files)))) return;
        if (starts) {
            if (this.prefs.openNowPlayingOnPlay()) this.sheet.show();
        } else if (this.prefs.openQueueOnAdd()) {
            this.sheet.showQueue();
        }
    }

    openAlbumOf(track: Track): void {
        if (track.albumArtist === undefined || track.album === undefined || track.release === undefined) return;
        void this.router.navigate(['/library/album'], {
            queryParams: { artist: track.albumArtist, album: track.album, release: track.release },
        });
    }

    openArtist(name: string): void {
        void this.router.navigate(['/library/artist'], { queryParams: { name } });
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

    /** Play, Queue and Play next as on the album screen, including whether now-playing is raised. */
    async play(album: AlbumSummary): Promise<void> {
        const ok = await this.send(() => this.library.playAlbum(refOf(album)));
        if (ok && this.prefs.openNowPlayingOnPlay()) this.sheet.show();
    }

    async queue(album: AlbumSummary): Promise<void> {
        const ok = await this.send(() => this.library.queueAlbum(refOf(album)));
        if (ok && this.prefs.openQueueOnAdd()) this.sheet.showQueue();
    }

    async playNext(album: AlbumSummary): Promise<void> {
        // Read before sending: the server starts playback only into an empty queue.
        const starts = this.api.snapshot()?.queueLength === 0;
        if (!(await this.send(() => this.library.playAlbumNext(refOf(album))))) return;
        if (starts) {
            if (this.prefs.openNowPlayingOnPlay()) this.sheet.show();
        } else if (this.prefs.openQueueOnAdd()) {
            this.sheet.showQueue();
        }
    }

    private async send(action: () => Promise<void>): Promise<boolean> {
        if (this.busy()) return false;
        this.busy.set(true);
        this.error.set(null);
        this.notice.set(null);
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

/** MusicBrainz genres are lower case: "alternative rock" reads as "Alternative Rock", "r&b" as "R&B". */
export function titleCase(genre: string): string {
    return genre
        .split(' ')
        .map((word) => (word.includes('&') ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
        .join(' ');
}

function refOf(album: AlbumSummary) {
    return { albumArtist: album.albumArtist, album: album.album, release: album.release };
}
