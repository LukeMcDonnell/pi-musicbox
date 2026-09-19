import { Injectable, computed, inject } from '@angular/core';
import type { AlbumSummary } from '@musicbox/shared';
import { FavouritesStore } from './favourites-store';

/** How many albums a shelf holds. */
export const SHELF_SIZE = 10;

/*
  Which favourites the Home shelf shows.

  ROOT-PROVIDED, because the pick has to outlive the screen: going to an album and
  back destroys and rebuilds Home, and a pick made in the component would come
  back different every time.

  SEEDED AND HASHED, not shuffled. The seed is drawn once per page load, and each
  album's place comes from a hash of the seed and its name, so the computed can
  re-run as often as it likes for the same answer. It also means a new favourite
  does not rearrange the shelf: every other album's hash is unchanged, so the most
  a star tapped elsewhere can do is displace one of the ten.
*/
@Injectable({ providedIn: 'root' })
export class FavouritePicks {
    private readonly favourites = inject(FavouritesStore);

    private readonly seed = Math.random();

    /** Empty while the stream is still connecting — the screen tells the two apart. */
    readonly albums = computed(() =>
        pickAlbums(this.favourites.albums() ?? [], SHELF_SIZE, this.seed),
    );
}

/** FNV-1a, which is enough to scatter a few hundred album names. */
function hash(text: string): number {
    let value = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        value ^= text.charCodeAt(i);
        value = Math.imul(value, 0x01000193);
    }
    return value >>> 0;
}

/** Up to `count` albums, in an order fixed by `seed`. Pure: the spec calls it directly. */
export function pickAlbums<T extends AlbumSummary>(
    albums: readonly T[],
    count: number,
    seed: number,
): T[] {
    return [...albums]
        .map((album) => ({
            album,
            // The release, not the title: four self-titled Weezers hashed alike
            // would take one rank between them and never spread.
            rank: hash(`${seed}:${album.release}`),
        }))
        .sort((a, b) => a.rank - b.rank)
        .slice(0, count)
        .map((entry) => entry.album);
}
