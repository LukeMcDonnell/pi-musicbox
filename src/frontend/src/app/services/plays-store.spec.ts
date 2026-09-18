import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MostPlayedArtist, RecentPlayAlbum } from '@musicbox/shared';
import { ApiClient } from './api-client';
import { MusicboxApi } from './musicbox-api';
import { PlaysStore } from './plays-store';

const ARTISTS: MostPlayedArtist[] = [
    { name: 'Radiohead', image: '/api/art?album=Radiohead', plays: 412 },
];

const OTHERS: MostPlayedArtist[] = [{ name: 'Tool', image: null, plays: 9 }];

function played(album: string): RecentPlayAlbum[] {
    return [{ album, albumArtist: 'Radiohead', image: null, playedAt: 1000, plays: 1 }];
}

/** A store whose fetches finish when the test says so. */
function setup() {
    const plays = signal<RecentPlayAlbum[] | null>(null);
    const pending: Array<(artists: MostPlayedArtist[]) => void> = [];
    const getJson = jasmine.createSpy('getJson').and.callFake(
        () =>
            new Promise<{ artists: MostPlayedArtist[] }>((resolve) => {
                pending.push((artists) => resolve({ artists }));
            }),
    );

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            { provide: ApiClient, useValue: { getJson, resolve: (path: string) => path } },
            { provide: MusicboxApi, useValue: { plays: plays.asReadonly() } },
        ],
    });
    const store = TestBed.inject(PlaysStore);
    TestBed.tick();
    return { store, plays, pending, getJson };
}

describe('PlaysStore', () => {
    it('hands the album list straight off the stream', () => {
        const { store, plays } = setup();
        expect(store.albums()).toBeNull();
        plays.set(played('Kid A'));
        expect(store.albums()).toEqual(played('Kid A'));
    });

    it('asks for the artists once and serves the rest from the cache', async () => {
        const { store, getJson, pending } = setup();
        const first = store.loadArtists();
        const second = store.loadArtists();
        pending[0](ARTISTS);
        await Promise.all([first, second]);

        await store.loadArtists();
        expect(store.artists()).toEqual(ARTISTS);
        expect(getJson).toHaveBeenCalledTimes(1);
    });

    it('keeps a fetch that the first plays frame arrived behind', async () => {
        const { store, plays, pending } = setup();
        const load = store.loadArtists();

        // The stream sends a plays frame the moment it connects. Treating that
        // first one as news would discard the answer behind it and leave Home's
        // shelf on its blank cards. Same trap as LibraryStore's scan effect.
        plays.set(played('Kid A'));
        TestBed.tick();

        pending[0](ARTISTS);
        await load;
        expect(store.artists()).toEqual(ARTISTS);
    });

    it('drops the cached artists when something is played', async () => {
        const { store, plays, pending } = setup();
        plays.set(played('Kid A'));
        TestBed.tick();

        const load = store.loadArtists();
        pending[0](ARTISTS);
        await load;
        expect(store.artists()).toEqual(ARTISTS);

        plays.set(played('Amnesiac'));
        TestBed.tick();
        expect(store.artists()).toBeNull();
    });

    it('refetches the counts after a play rather than serving the old ones', async () => {
        const { store, plays, pending, getJson } = setup();
        plays.set(played('Kid A'));
        TestBed.tick();
        const first = store.loadArtists();
        pending[0](ARTISTS);
        await first;

        plays.set(played('Amnesiac'));
        TestBed.tick();
        const second = store.loadArtists();
        pending[1](OTHERS);
        await second;

        expect(getJson).toHaveBeenCalledTimes(2);
        expect(store.artists()).toEqual(OTHERS);
    });

    it('does not reinstate counts read before the play that dropped them', async () => {
        const { store, plays, pending } = setup();
        plays.set(played('Kid A'));
        TestBed.tick();

        const stale = store.loadArtists();
        plays.set(played('Amnesiac'));
        TestBed.tick();
        pending[0](ARTISTS);
        await stale;
        expect(store.artists()).toBeNull();
    });

    it('does not wedge the shelf when the box is unreachable', async () => {
        const fail = jasmine.createSpy('getJson').and.rejectWith(new Error('offline'));
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({
            providers: [
                { provide: ApiClient, useValue: { getJson: fail, resolve: (p: string) => p } },
                { provide: MusicboxApi, useValue: { plays: signal(null).asReadonly() } },
            ],
        });
        const store = TestBed.inject(PlaysStore);

        await expectAsync(store.loadArtists()).toBeRejected();
        await expectAsync(store.loadArtists()).toBeRejected();
        // Asked again rather than holding the failed promise for the session.
        expect(fail).toHaveBeenCalledTimes(2);
    });
});
