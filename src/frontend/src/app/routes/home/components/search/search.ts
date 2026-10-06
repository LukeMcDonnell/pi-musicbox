import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, model, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideMusic, LucideEllipsisVertical, LucideSearch, LucideX } from '@lucide/angular';
import type { AlbumIdentity, ArtistSummary, SearchAlbum, SearchGroup, SearchResponse, Track } from '@musicbox/shared';
import { SEARCH_MIN_LENGTH } from '@musicbox/shared';
import { AlbumRow } from '../../../../components/album-row/album-row';
import { ArtistRow } from '../../../../components/artist-row/artist-row';
import { CoverArt } from '../../../../components/cover-art/cover-art';
import { TrackMenu, type TrackAction } from '../../../../components/track-menu/track-menu';
import { LibraryStore } from '../../../../services/library-store';
import { MusicboxApi } from '../../../../services/musicbox-api';
import { NowPlayingSheet } from '../../../../services/now-playing-sheet';
import { Preferences } from '../../../../services/preferences';

/** How long typing must pause before a search is sent. */
export const SEARCH_DEBOUNCE_MS = 250;

const HEADINGS: Record<SearchGroup['kind'], string> = {
    artist: 'Artists',
    album: 'Albums',
    track: 'Tracks',
};

/** The field at the top of Home, and the results that stand in for the shelves. */
@Component({
    selector: 'app-home-search',
    imports: [
        AlbumRow,
        ArtistRow,
        CoverArt,
        LucideMusic,
        LucideEllipsisVertical,
        LucideSearch,
        LucideX,
        TrackMenu,
    ],
    templateUrl: './search.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeSearch {
    private readonly library = inject(LibraryStore);
    private readonly api = inject(MusicboxApi);
    private readonly sheet = inject(NowPlayingSheet);
    private readonly prefs = inject(Preferences);
    private readonly router = inject(Router);

    /** The field's text. Home owns it, because it also decides whether the shelves show. */
    readonly query = model('');

    readonly results = signal<SearchResponse | null>(null);
    readonly searching = signal(false);
    readonly error = signal<string | null>(null);
    readonly busy = signal(false);
    readonly notice = signal<string | null>(null);
    readonly menuTrack = signal<Track | null>(null);
    readonly trackActions: readonly TrackAction[] = ['play', 'queue', 'playNext', 'playlist', 'artist'];

    private timer: ReturnType<typeof setTimeout> | null = null;
    /** Bumped per search, so a slow answer to an older query cannot replace a newer one. */
    private sequence = 0;

    constructor() {
        effect(() => {
            const term = this.query().trim();
            this.cancel();
            if (term.length < SEARCH_MIN_LENGTH) {
                this.results.set(null);
                this.error.set(null);
                this.searching.set(false);
                return;
            }
            this.searching.set(true);
            this.timer = setTimeout(() => void this.run(term), SEARCH_DEBOUNCE_MS);
        });
        inject(DestroyRef).onDestroy(() => this.cancel());
    }

    private cancel(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.sequence += 1;
    }

    async run(term: string): Promise<void> {
        this.timer = null;
        const mine = ++this.sequence;
        this.searching.set(true);
        this.error.set(null);
        try {
            const results = await this.library.search(term);
            if (mine === this.sequence) this.results.set(results);
        } catch (err) {
            if (mine === this.sequence) this.error.set((err as Error).message);
        } finally {
            if (mine === this.sequence) this.searching.set(false);
        }
    }

    retry(): void {
        const term = this.query().trim();
        if (term.length >= SEARCH_MIN_LENGTH) void this.run(term);
    }

    setQuery(value: string): void {
        this.notice.set(null);
        this.query.set(value);
    }

    headingOf(group: SearchGroup): string {
        return HEADINGS[group.kind];
    }

    // Narrowing helpers: a template cannot narrow a union on `kind`.
    artistsOf(group: SearchGroup): ArtistSummary[] {
        return group.kind === 'artist' ? group.items : [];
    }

    albumsOf(group: SearchGroup): SearchAlbum[] {
        return group.kind === 'album' ? group.items : [];
    }

    tracksOf(group: SearchGroup): Track[] {
        return group.kind === 'track' ? group.items : [];
    }

    // Covers that 404ed, keyed by resolved URI, as on Home.
    private readonly failedCovers = signal<ReadonlySet<string>>(new Set());

    coverOf(item: { image?: string | null }): string | null {
        if (!item.image) return null;
        const uri = this.library.resolve(item.image);
        return this.failedCovers().has(uri) ? null : uri;
    }

    onCoverError(uri: string): void {
        this.failedCovers.update((failed) => new Set(failed).add(uri));
    }

    albumsLabel(artist: ArtistSummary): string {
        return artist.albumCount === 1 ? '1 album' : `${artist.albumCount} albums`;
    }

    yearOf(album: SearchAlbum): string {
        const match = album.date === null ? null : /^(\d{4})/.exec(album.date);
        return match ? `${album.albumArtist} · ${match[1]}` : album.albumArtist;
    }

    trackSubtitle(track: Track): string {
        return [track.artist ?? track.albumArtist, track.album].filter(Boolean).join(' · ');
    }

    openArtist(artist: ArtistSummary): void {
        void this.router.navigate(['/library/artist'], { queryParams: { name: artist.name } });
    }

    openAlbum(album: AlbumIdentity): void {
        void this.router.navigate(['/library/album'], {
            queryParams: { artist: album.albumArtist, album: album.album, release: album.release },
        });
    }

    /** A track opens on its album; null when it has nothing to open on. */
    albumOfTrack(track: Track): AlbumIdentity | null {
        const { albumArtist, album, release } = track;
        if (albumArtist === undefined || album === undefined || release === undefined) return null;
        return { albumArtist, album, release };
    }

    openTrack(track: Track): void {
        const album = this.albumOfTrack(track);
        if (album !== null) this.openAlbum(album);
    }

    async playAlbum(album: AlbumIdentity): Promise<void> {
        const ok = await this.send(() => this.library.playAlbum(refOf(album)));
        if (ok && this.prefs.openNowPlayingOnPlay()) this.sheet.show();
    }

    async queueAlbum(album: AlbumIdentity): Promise<void> {
        const ok = await this.send(() => this.library.queueAlbum(refOf(album)));
        if (ok && this.prefs.openQueueOnAdd()) this.sheet.showQueue();
    }

    /** The track's whole album, starting at it — as on the album screen. */
    async playTrack(track: Track): Promise<void> {
        const album = this.albumOfTrack(track);
        if (album === null) return;
        const ok = await this.send(() => this.library.playAlbum(refOf(album), track.file));
        if (ok && this.prefs.openNowPlayingOnPlay()) this.sheet.show();
    }

    queueTrack(track: Track): Promise<void> {
        return this.insert(track, (file) => this.library.queueTrack(file));
    }

    playNext(track: Track): Promise<void> {
        return this.insert(track, (file) => this.library.playTrackNext(file));
    }

    private async insert(track: Track, add: (file: string) => Promise<void>): Promise<void> {
        const file = track.file;
        if (!file) return;
        // Read before sending: the server starts playback only into an empty queue.
        const starts = this.api.snapshot()?.queueLength === 0;
        if (!(await this.send(() => add(file)))) return;
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
}

function refOf(album: AlbumIdentity) {
    return { albumArtist: album.albumArtist, album: album.album, release: album.release };
}
