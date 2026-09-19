import { Injectable, computed, inject } from '@angular/core';
import type { AlbumRef, FavouritesResponse } from '@musicbox/shared';
import { ApiClient } from './api-client';
import { MusicboxApi } from './musicbox-api';

/*
  Favourite albums. The list is the box's and arrives on the stream; this adds
  the lookups and the two writes. No optimistic update: a star flips when the
  server's answer does.
*/
@Injectable({ providedIn: 'root' })
export class FavouritesStore {
    private readonly api = inject(ApiClient);
    private readonly box = inject(MusicboxApi);

    /** Null before the first frame. */
    readonly albums = this.box.favourites;

    private readonly keys = computed(
        () => new Set((this.albums() ?? []).map((a) => a.release)),
    );

    isFavourite(release: string): boolean {
        return this.keys().has(release);
    }

    async add(ref: AlbumRef): Promise<void> {
        const { albums } = await this.api.putJson<FavouritesResponse>(path(ref));
        this.box.setFavourites(albums);
    }

    async remove(ref: AlbumRef): Promise<void> {
        const { albums } = await this.api.deleteJson<FavouritesResponse>(path(ref));
        this.box.setFavourites(albums);
    }

    async toggle(ref: AlbumRef): Promise<void> {
        await (this.isFavourite(ref.release) ? this.remove(ref) : this.add(ref));
    }
}

function path(ref: AlbumRef): string {
    return (
        `/api/favourites/album?artist=${encodeURIComponent(ref.albumArtist)}` +
        `&release=${encodeURIComponent(ref.release)}`
    );
}
