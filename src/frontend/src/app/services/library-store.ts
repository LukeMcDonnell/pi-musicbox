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
 *   from an album, and MPD runs `auto_update "no"`, so the library changes only
 *   when a scan runs. That used to mean a person typing a command on the device,
 *   which is why this was cached for the session and never invalidated. Settings
 *   -> Library can now start a scan, and schedule one, so the cache is dropped
 *   when a scan finishes — see the effect below.
 *
 *   Album and track listings are not cached. Each is one ~17ms `find` on the
 *   backend, and holding 487 artists' worth of track lists in a browser on a
 *   panel would be a lot of memory to avoid a cheap request.
 */

import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type {
    AlbumRef,
    AlbumResponse,
    AlbumsResponse,
    ArtistSummary,
    ArtistsResponse,
} from '@musicbox/shared';
import { ApiClient } from './api-client';
import { MusicboxApi } from './musicbox-api';

@Injectable({ providedIn: 'root' })
export class LibraryStore {
    private readonly api = inject(ApiClient);
    private readonly box = inject(MusicboxApi);

    private readonly _artists = signal<ArtistSummary[] | null>(null);

    /**
     * When the last finished scan finished; 0 if none ever has; null before the
     * first library frame.
     *
     * A PRIMITIVE, not the LibraryState object: that is replaced wholesale on
     * every event, so its identity changes constantly and an effect reading it
     * would fire on every frame. Null is not folded into 0 because the two mean
     * different things to the effect below.
     */
    private readonly scannedAt = computed(() => {
        const state = this.box.library();
        return state === null ? null : (state.lastScan?.finishedAt ?? 0);
    });

    constructor() {
        // The first value is the baseline, not a change. The stream sends a
        // library frame on connect carrying the PREVIOUS scan's timestamp, so
        // treating it as news dropped the fetch that was in flight behind it and
        // left the screen on "Reading the library…" forever.
        let seen: number | null = null;
        effect(() => {
            const at = this.scannedAt();
            if (at === null) return;
            const known = seen !== null;
            seen = at;
            if (known) this.invalidate();
        });
    }

    /** The artist list once it has been fetched, or null before that. */
    readonly artists = this._artists.asReadonly();

    /** Shared between concurrent callers so a double navigation fetches once. */
    private artistsRequest: Promise<ArtistSummary[]> | null = null;

    private readonly _generation = signal(0);

    /**
     * Bumped by invalidate(), so a fetch that started before it cannot win.
     *
     * A signal because a screen showing the list has to hear that it was
     * dropped: `artists` going null is not enough, since it is already null
     * while the first fetch is in flight. See Library's constructor.
     */
    readonly generation = this._generation.asReadonly();

    /**
     * Drop the cached artist list.
     *
     * A fetch already in flight read the library BEFORE the scan that prompted
     * this, and dropping the promise does not stop its `.then` — without the
     * generation check it would reinstate the stale list for the whole session.
     */
    invalidate(): void {
        this._artists.set(null);
        this.artistsRequest = null;
        this._generation.update((n) => n + 1);
    }

    async loadArtists(): Promise<ArtistSummary[]> {
        const cached = this._artists();
        if (cached !== null) return cached;
        if (this.artistsRequest === null) {
            // untracked: an effect that calls this is watching `generation`
            // deliberately or not at all, never by way of this line.
            const mine = untracked(this._generation);
            this.artistsRequest = this.api
                .getJson<ArtistsResponse>('/api/library/artists')
                .then(({ artists }) => {
                    if (mine === this._generation()) this._artists.set(artists);
                    return artists;
                })
                .finally(() => {
                    // Cleared on failure too, so MPD being down while the screen
                    // was first opened does not wedge the list forever.
                    if (mine === this._generation()) this.artistsRequest = null;
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
