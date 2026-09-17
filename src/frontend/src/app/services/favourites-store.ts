import { Injectable, computed, inject } from '@angular/core';
import type { AlbumRef, FavouritesResponse } from '@musicbox/shared';
import { ApiClient } from './api-client';
import { MusicboxApi } from './musicbox-api';

/*
  Favourite albums. The list is the box's and arrives on the stream; this adds
  the lookups and the two writes. No optimistic update: a heart flips when the
  server's answer does.
*/
@Injectable({ providedIn: 'root' })
export class FavouritesStore {
    private readonly api = inject(ApiClient);
    private readonly box = inject(MusicboxApi);

    /** Null before the first frame. */
    readonly albums = this.box.favourites;

    private readonly keys = computed(
        () => new Set((this.albums() ?? []).map((a) => keyOf(a.albumArtist, a.album))),
    );

    isFavourite(albumArtist: string, album: string): boolean {
        return this.keys().has(keyOf(albumArtist, album));
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
        await (this.isFavourite(ref.albumArtist, ref.album) ? this.remove(ref) : this.add(ref));
    }
}

// JSON rather than a joined string, so no pair of names can collide with another.
function keyOf(albumArtist: string, album: string): string {
    return JSON.stringify([albumArtist, album]);
}

function path(ref: AlbumRef): string {
    return (
        `/api/favourites/album?artist=${encodeURIComponent(ref.albumArtist)}` +
        `&album=${encodeURIComponent(ref.album)}`
    );
}
