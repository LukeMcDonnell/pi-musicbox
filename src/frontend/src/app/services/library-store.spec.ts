import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ArtistSummary, LibraryScan, LibraryState } from '@musicbox/shared';
import { ApiClient } from './api-client';
import { LibraryStore } from './library-store';
import { MusicboxApi } from './musicbox-api';
import { libraryState } from '../testing/fixtures';

const ARTISTS: ArtistSummary[] = [
    {
        name: 'Radiohead',
        directory: 'Radiohead',
        albumCount: 9,
        trackCount: 111,
        duration: 28_800,
        image: null,
    },
];

function scan(finishedAt: number): LibraryScan {
    return {
        startedAt: finishedAt - 60_000,
        finishedAt,
        trigger: 'scheduled',
        outcome: 'completed',
        songsBefore: 10,
        songsAfter: 11,
    };
}

/** A store whose fetches finish when the test says so. */
function setup() {
    const library = signal<LibraryState | null>(null);
    const pending: Array<(artists: ArtistSummary[]) => void> = [];
    const getJson = jasmine.createSpy('getJson').and.callFake(
        () =>
            new Promise<{ artists: ArtistSummary[] }>((resolve) => {
                pending.push((artists) => resolve({ artists }));
            }),
    );

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            { provide: ApiClient, useValue: { getJson, resolve: (path: string) => path } },
            { provide: MusicboxApi, useValue: { library: library.asReadonly() } },
        ],
    });
    const store = TestBed.inject(LibraryStore);
    TestBed.tick();
    return { store, library, pending, getJson };
}

describe('LibraryStore', () => {
    it('keeps a fetch that the first library frame arrived behind', async () => {
        const { store, library, pending } = setup();
        const load = store.loadArtists();

        // The stream sends a library frame the moment it connects, and it
        // carries the timestamp of a scan that finished long before this fetch
        // started. Treating that as news discarded the answer and left the
        // Library screen on "Reading the library…" for the whole session.
        library.set(libraryState({ lastScan: scan(1_700_000_000_000) }));
        TestBed.tick();

        pending[0](ARTISTS);
        await load;
        expect(store.artists()).toEqual(ARTISTS);
    });

    it('serves the second caller from the cache', async () => {
        const { store, getJson, pending } = setup();
        const first = store.loadArtists();
        const second = store.loadArtists();
        pending[0](ARTISTS);
        await Promise.all([first, second]);

        await store.loadArtists();
        expect(getJson).toHaveBeenCalledTimes(1);
    });

    it('drops the cached list when a scan finishes', async () => {
        const { store, library, pending } = setup();
        library.set(libraryState({ lastScan: scan(1_700_000_000_000) }));
        TestBed.tick();

        const load = store.loadArtists();
        pending[0](ARTISTS);
        await load;
        expect(store.artists()).toEqual(ARTISTS);

        const before = store.generation();
        library.set(libraryState({ lastScan: scan(1_700_000_600_000) }));
        TestBed.tick();
        expect(store.artists()).toBeNull();
        // The screen showing the list has no other way to hear this.
        expect(store.generation()).toBeGreaterThan(before);
    });

    it('does not reinstate a list read before the scan that dropped it', async () => {
        const { store, library, pending, getJson } = setup();
        library.set(libraryState({ lastScan: scan(1_700_000_000_000) }));
        TestBed.tick();

        const stale = store.loadArtists();
        library.set(libraryState({ lastScan: scan(1_700_000_600_000) }));
        TestBed.tick();
        pending[0](ARTISTS);
        await stale;
        expect(store.artists()).toBeNull();

        // And the next ask is a real fetch, not the dropped promise.
        void store.loadArtists();
        expect(getJson).toHaveBeenCalledTimes(2);
    });
});
