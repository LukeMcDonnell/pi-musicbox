import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { FavouriteAlbum } from '@musicbox/shared';
import { ApiClient } from './api-client';
import { FavouritesStore } from './favourites-store';
import { MusicboxApi } from './musicbox-api';
import { favouriteAlbum } from '../testing/fixtures';

function setup(initial: FavouriteAlbum[] | null = []) {
    const favourites = signal<FavouriteAlbum[] | null>(initial);
    const api = {
        putJson: jasmine.createSpy('putJson').and.resolveTo({ albums: [favouriteAlbum({ album: 'Amnesiac' })] }),
        deleteJson: jasmine.createSpy('deleteJson').and.resolveTo({ albums: [] }),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            { provide: ApiClient, useValue: api },
            {
                provide: MusicboxApi,
                useValue: {
                    favourites: favourites.asReadonly(),
                    setFavourites: (albums: FavouriteAlbum[]) => favourites.set(albums),
                },
            },
        ],
    });
    return { store: TestBed.inject(FavouritesStore), api, favourites };
}

describe('FavouritesStore', () => {
    it('knows an album by RELEASE, so two records sharing a title do not match', () => {
        // Weezer's four self-titled records. Artist and title cannot tell them
        // apart, which is why the key is the release.
        const { store } = setup([
            favouriteAlbum({ albumArtist: 'Weezer', album: 'Weezer', release: 'mb:blue' }),
        ]);
        expect(store.isFavourite('mb:blue')).toBeTrue();
        expect(store.isFavourite('mb:green')).toBeFalse();
    });

    it('adds with a PUT, escaping the names, and applies the answer at once', async () => {
        const { store, api } = setup();
        await store.toggle({ albumArtist: 'AC/DC', album: 'Back in Black', release: 'mb:bib' });
        expect(api.putJson).toHaveBeenCalledWith('/api/favourites/album?artist=AC%2FDC&release=mb%3Abib');
        expect(store.isFavourite('mb:kid-a')).toBeTrue();
    });

    it('removes a favourite with a DELETE', async () => {
        const { store, api } = setup([favouriteAlbum()]);
        await store.toggle({ albumArtist: 'Radiohead', album: 'Kid A', release: 'mb:kid-a' });
        expect(api.deleteJson).toHaveBeenCalledWith('/api/favourites/album?artist=Radiohead&release=mb%3Akid-a');
        expect(api.putJson).not.toHaveBeenCalled();
        expect(store.albums()).toEqual([]);
    });

    it('changes nothing when the server refuses', async () => {
        const { store, api } = setup();
        api.putJson.and.rejectWith(new Error('no such album'));
        await expectAsync(
            store.add({ albumArtist: 'A', album: 'B', release: 'mb:b' }),
        ).toBeRejectedWithError('no such album');
        expect(store.albums()).toEqual([]);
    });
});
