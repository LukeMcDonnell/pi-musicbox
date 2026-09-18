import type { FavouriteAlbum } from '@musicbox/shared';
import { favouriteAlbum } from '../testing/fixtures';
import { pickAlbums } from './favourite-picks';

function library(count: number): FavouriteAlbum[] {
    return Array.from({ length: count }, (_, i) =>
        favouriteAlbum({ album: `Album ${i}`, albumArtist: `Artist ${i % 7}` }),
    );
}

const titles = (albums: readonly FavouriteAlbum[]) => albums.map((a) => a.album);

describe('pickAlbums', () => {
    it('takes at most the count asked for', () => {
        expect(pickAlbums(library(40), 10, 0.5).length).toBe(10);
    });

    it('returns everything there is when there are fewer', () => {
        expect(pickAlbums(library(3), 10, 0.5).length).toBe(3);
    });

    it('answers the same for the same seed, so the shelf survives a re-render', () => {
        const albums = library(40);
        expect(titles(pickAlbums(albums, 10, 0.5))).toEqual(titles(pickAlbums(albums, 10, 0.5)));
    });

    it('answers differently for a different seed', () => {
        const albums = library(40);
        expect(titles(pickAlbums(albums, 10, 0.5))).not.toEqual(titles(pickAlbums(albums, 10, 0.9)));
    });

    it('does not reshuffle the rest when a favourite is added', () => {
        const albums = library(40);
        const before = pickAlbums(albums, 10, 0.5);
        const after = pickAlbums([...albums, favouriteAlbum({ album: 'New One' })], 10, 0.5);
        // The newcomer can displace one; the others keep their places.
        const kept = titles(after).filter((title) => titles(before).includes(title));
        expect(kept.length).toBeGreaterThanOrEqual(9);
    });

    it('leaves an empty library empty', () => {
        expect(pickAlbums([], 10, 0.5)).toEqual([]);
    });
});
