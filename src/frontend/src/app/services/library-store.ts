/**
 * The browse catalogue: artists, an artist's albums, an album's tracks.
 *
 * SEPARATE FROM MusicboxApi ON PURPOSE. That service mirrors what is playing
 * right now — an SSE stream it replaces wholesale on every frame. This is a
 * catalogue: fetched on demand, changed only by someone running `mpc update` on
 * the box, and of no interest to the now-playing screen. They share a transport
 * (ApiClient) and nothing else.
 *
 * WHY THE ARTIST LIST IS CACHED AND THE REST IS NOT
 *   The artist list is ~487 rows, it is re-entered every time someone comes back
 *   from an album, and MPD runs `auto_update "no"` — the library genuinely
 *   cannot change without a person typing a command on the device. So a
 *   session-lifetime cache cannot go meaningfully stale, and the alternative is
 *   making the backend redo its index lookup on every back navigation.
 *
 *   Album and track listings are not cached. Each is one ~17ms `find` on the
 *   backend, and holding 487 artists' worth of track lists in a browser on a
 *   panel would be a lot of memory to avoid a cheap request.
 */

import { Injectable, inject, signal } from '@angular/core';
import type {
    AlbumRef,
    AlbumResponse,
    AlbumsResponse,
    ArtistSummary,
    ArtistsResponse,
} from '@musicbox/shared';
import { ApiClient } from './api-client';

@Injectable({ providedIn: 'root' })
export class LibraryStore {
    private readonly api = inject(ApiClient);

    private readonly _artists = signal<ArtistSummary[] | null>(null);

    /** The artist list once it has been fetched, or null before that. */
    readonly artists = this._artists.asReadonly();

    /** Shared between concurrent callers so a double navigation fetches once. */
    private artistsRequest: Promise<ArtistSummary[]> | null = null;

    async loadArtists(): Promise<ArtistSummary[]> {
        const cached = this._artists();
        if (cached !== null) return cached;
        if (this.artistsRequest === null) {
            this.artistsRequest = this.api
                .getJson<ArtistsResponse>('/api/library/artists')
                .then(({ artists }) => {
                    this._artists.set(artists);
                    return artists;
                })
                .finally(() => {
                    // Cleared on failure too, so MPD being down while the screen
                    // was first opened does not wedge the list forever.
                    this.artistsRequest = null;
                });
        }
        return this.artistsRequest;
    }

    async fetchAlbums(albumArtist: string): Promise<AlbumsResponse> {
        return this.api.getJson<AlbumsResponse>(
            `/api/library/albums?artist=${encodeURIComponent(albumArtist)}`,
        );
    }

    async fetchAlbum(albumArtist: string, album: string): Promise<AlbumResponse> {
        return this.api.getJson<AlbumResponse>(
            `/api/library/album?artist=${encodeURIComponent(albumArtist)}` +
                `&album=${encodeURIComponent(album)}`,
        );
    }

    /** Append an album to the queue. */
    async queueAlbum(ref: AlbumRef): Promise<void> {
        await this.api.post('/api/library/queue', ref);
    }

    /** Replace the queue with an album and start playing it. */
    async playAlbum(ref: AlbumRef): Promise<void> {
        await this.api.post('/api/library/play', ref);
    }

    /** Resolve a server-supplied path. See ApiClient.resolve — never bypass it. */
    resolve(path: string): string {
        return this.api.resolve(path);
    }
}
