import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import type { ArtistSummary } from '@musicbox/shared';
import { Library } from './library';
import { LibraryStore } from '../../library-store';

function artist(over: Partial<ArtistSummary> = {}): ArtistSummary {
    return {
        name: 'Radiohead',
        directory: 'Radiohead',
        albumCount: 9,
        image: '/api/art?album=Radiohead',
        ...over,
    };
}

/** A store with no HTTP behind it. */
function fakeStore(artists: ArtistSummary[] | null = null) {
    const state = signal<ArtistSummary[] | null>(artists);
    return {
        artists: state.asReadonly(),
        loadArtists: jasmine.createSpy('loadArtists').and.resolveTo(artists ?? []),
        resolve: (path: string) => path,
        _set: (next: ArtistSummary[] | null) => state.set(next),
    };
}

function create(store: ReturnType<typeof fakeStore>) {
    TestBed.configureTestingModule({
        imports: [Library],
        providers: [provideRouter([]), { provide: LibraryStore, useValue: store }],
    });
    return TestBed.createComponent(Library);
}

describe('Library', () => {
    it('creates without a backend present', () => {
        // The state at boot, before MPD is up and before anything has loaded.
        const fixture = create(fakeStore(null));
        fixture.detectChanges();
        expect(fixture.componentInstance).toBeTruthy();
    });

    it('asks the store for the list on construction', () => {
        const store = fakeStore([artist()]);
        create(store).detectChanges();
        expect(store.loadArtists).toHaveBeenCalled();
    });

    it('distinguishes "not loaded yet" from "an empty library"', () => {
        const store = fakeStore(null);
        const fixture = create(store);
        fixture.detectChanges();
        // Null is loading. An empty array is a real, different answer, and the
        // template says something different for each.
        expect(fixture.componentInstance.loading()).toBeTrue();

        store._set([]);
        expect(fixture.componentInstance.loading()).toBeFalse();
    });

    it('stops claiming to load when the fetch failed', async () => {
        const store = fakeStore(null);
        store.loadArtists.and.rejectWith(new Error('MPD is not connected'));
        const fixture = create(store);
        await fixture.componentInstance.load();
        expect(fixture.componentInstance.error()).toBe('MPD is not connected');
        // Otherwise the screen would sit on "Reading the library…" forever.
        expect(fixture.componentInstance.loading()).toBeFalse();
    });

    it('hides a picture that 404ed, and only that one', () => {
        const fixture = create(fakeStore([artist()]));
        const cmp = fixture.componentInstance;
        const missing = artist({ name: 'Ought', image: '/api/art?album=Ought' });

        expect(cmp.artOf(missing)).toBe('/api/art?album=Ought');
        cmp.onArtError('/api/art?album=Ought');
        // 16 of this library's artists have no image file, so this path is
        // normal rather than exceptional.
        expect(cmp.artOf(missing)).toBeNull();
        expect(cmp.artOf(artist())).toBe('/api/art?album=Radiohead');
    });

    it('shows the placeholder for an artist whose directory is unknown', () => {
        const fixture = create(fakeStore([]));
        // The backend sends null rather than a guessed URI — deriving a
        // directory from a name is wrong for 48 of 487 real artists.
        expect(fixture.componentInstance.artOf(artist({ image: null }))).toBeNull();
    });

    it('counts albums in words, and gets the singular right', () => {
        const cmp = create(fakeStore([])).componentInstance;
        expect(cmp.albumsLabel(artist({ albumCount: 1 }))).toBe('1 album');
        expect(cmp.albumsLabel(artist({ albumCount: 17 }))).toBe('17 albums');
    });
});
