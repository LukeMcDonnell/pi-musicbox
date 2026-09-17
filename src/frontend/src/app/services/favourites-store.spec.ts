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
    it('knows an album by artist AND title, so a shared title is not a match', () => {
        const { store } = setup([favouriteAlbum({ albumArtist: 'Queen', album: 'Greatest Hits' })]);
        expect(store.isFavourite('Queen', 'Greatest Hits')).toBeTrue();
        expect(store.isFavourite('Eagles', 'Greatest Hits')).toBeFalse();
    });

    it('adds with a PUT, escaping the names, and applies the answer at once', async () => {
        const { store, api } = setup();
        await store.toggle({ albumArtist: 'AC/DC', album: 'Back in Black' });
        expect(api.putJson).toHaveBeenCalledWith('/api/favourites/album?artist=AC%2FDC&album=Back%20in%20Black');
        expect(store.isFavourite('Radiohead', 'Amnesiac')).toBeTrue();
    });

    it('removes a favourite with a DELETE', async () => {
        const { store, api } = setup([favouriteAlbum()]);
        await store.toggle({ albumArtist: 'Radiohead', album: 'Kid A' });
        expect(api.deleteJson).toHaveBeenCalledWith('/api/favourites/album?artist=Radiohead&album=Kid%20A');
        expect(api.putJson).not.toHaveBeenCalled();
        expect(store.albums()).toEqual([]);
    });

    it('changes nothing when the server refuses', async () => {
        const { store, api } = setup();
        api.putJson.and.rejectWith(new Error('no such album'));
        await expectAsync(store.add({ albumArtist: 'A', album: 'B' })).toBeRejectedWithError('no such album');
        expect(store.albums()).toEqual([]);
    });
});
