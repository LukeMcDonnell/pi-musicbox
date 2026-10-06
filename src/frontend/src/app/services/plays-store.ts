import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { MostPlayedArtist, MostPlayedArtistsResponse } from '@musicbox/shared';
import { MOST_PLAYED_ARTISTS_LIMIT } from '@musicbox/shared';
import { ApiClient } from './api-client';
import { MusicboxApi } from './musicbox-api';

/*
  What the box has played: albums most recently first, and artists most played.

  The album list is the box's and arrives on the stream, so there is nothing to
  fetch and nothing to cache. The artist list is a count over the same table and
  is FETCHED — an all-time total does not reorder on one play, so a frame per
  play would carry the whole list again to change nothing. See api.ts.

  Note neither is in LibraryStore: that cache is dropped when a scan finishes,
  and a play has nothing to do with a scan.
*/
@Injectable({ providedIn: 'root' })
export class PlaysStore {
    private readonly api = inject(ApiClient);
    private readonly box = inject(MusicboxApi);

    /** Null before the first frame. */
    readonly albums = this.box.plays;

    private readonly _artists = signal<MostPlayedArtist[] | null>(null);
    private artistsRequest: Promise<MostPlayedArtist[]> | null = null;

    /**
     * The most played artists, or null before the first fetch.
     *
     * Cached like the recently added list: Home's shelf and the screen behind it
     * want the same list within a frame of each other, and one fetch of
     * MOST_PLAYED_ARTISTS_LIMIT serves both — the shelf takes the first few.
     */
    readonly artists = this._artists.asReadonly();

    private readonly _generation = signal(0);

    /** Bumped by invalidate(): a screen showing the artists watches it to refetch. */
    readonly generation = this._generation.asReadonly();

    /**
     * The newest play, as a primitive: every reconnect resends the same list as a
     * new array, and that is not a play. Null before the first frame.
     */
    private readonly latestPlay = computed(() => {
        const albums = this.albums();
        if (albums === null) return null;
        const newest = albums[0];
        return newest ? `${newest.release}:${newest.playedAt}` : '';
    });

    constructor() {
        // A play changes the counts, so the cache is dropped. The first frame is
        // the baseline, not a change — same trap as LibraryStore's scan effect.
        let seen: string | null = null;
        effect(() => {
            const latest = this.latestPlay();
            if (latest === null) return;
            const known = seen !== null;
            seen = latest;
            if (known) this.invalidate();
        });
    }

    /** Drop the cached artist list. A fetch in flight is dropped with it. */
    invalidate(): void {
        this._artists.set(null);
        this.artistsRequest = null;
        this._generation.update((n) => n + 1);
    }

    async loadArtists(): Promise<MostPlayedArtist[]> {
        const cached = this._artists();
        if (cached !== null) return cached;
        if (this.artistsRequest === null) {
            const mine = (this.artistsRequest = this.api
                .getJson<MostPlayedArtistsResponse>(
                    `/api/plays/artists?limit=${MOST_PLAYED_ARTISTS_LIMIT}`,
                )
                .then(({ artists }) => {
                    // Not if a play landed while this was in flight: those counts
                    // are one behind, and the next ask fetches them again.
                    if (mine === this.artistsRequest) this._artists.set(artists);
                    return artists;
                })
                .finally(() => {
                    // Cleared on failure too, so the box being unreachable once
                    // does not wedge the shelf for the session.
                    if (mine === this.artistsRequest) this.artistsRequest = null;
                }));
        }
        return this.artistsRequest;
    }
}
