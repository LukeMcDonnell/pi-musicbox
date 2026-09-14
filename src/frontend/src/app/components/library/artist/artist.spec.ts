import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import type { AlbumSummary, ArtistSummary } from '@musicbox/shared';
import { Artist } from './artist';
import { LibraryStore } from '../../../library-store';

function album(over: Partial<AlbumSummary> = {}): AlbumSummary {
    return {
        album: 'Kid A',
        albumArtist: 'Radiohead',
        date: '2000-10-02',
        trackCount: 10,
        image: '/api/art?album=Radiohead%2FKid%20A',
        ...over,
    };
}

function fakeStore(albums: AlbumSummary[] = [], artists: ArtistSummary[] | null = null) {
    const state = signal<ArtistSummary[] | null>(artists);
    return {
        artists: state.asReadonly(),
        fetchAlbums: jasmine
            .createSpy('fetchAlbums')
            .and.resolveTo({ albumArtist: 'Radiohead', image: '/api/art?album=Radiohead', albums }),
        resolve: (path: string) => path,
    };
}

function create(store: ReturnType<typeof fakeStore>, name = 'Radiohead') {
    TestBed.configureTestingModule({
        imports: [Artist],
        providers: [provideRouter([]), { provide: LibraryStore, useValue: store }],
    });
    const fixture = TestBed.createComponent(Artist);
    fixture.componentRef.setInput('name', name);
    return fixture;
}

describe('Artist', () => {
    it('creates without a backend present', () => {
        const fixture = create(fakeStore(), '');
        fixture.detectChanges();
        expect(fixture.componentInstance).toBeTruthy();
    });

    it('fetches the artist named in the query parameter', async () => {
        const store = fakeStore([album()]);
        const fixture = create(store, 'AC/DC');
        fixture.detectChanges();
        await fixture.whenStable();
        // The name goes through untouched — `AC/DC` is a real artist and the
        // slash is exactly why it travels as a query parameter.
        expect(store.fetchAlbums).toHaveBeenCalledWith('AC/DC');
    });

    it('renders the year as the leading four digits, and an em dash when undated', () => {
        const cmp = create(fakeStore()).componentInstance;
        // `date` is free text on the wire: `1997`, `1997-06-16`, occasionally worse.
        expect(cmp.yearOf(album({ date: '2000-10-02' }))).toBe('2000');
        expect(cmp.yearOf(album({ date: '1997' }))).toBe('1997');
        // 18 of this library's 2,757 albums carry no date at all.
        expect(cmp.yearOf(album({ date: null }))).toBe('—');
        expect(cmp.yearOf(album({ date: 'unknown' }))).toBe('—');
    });

    it('reports an error instead of loading forever', async () => {
        const store = fakeStore();
        store.fetchAlbums.and.rejectWith(new Error('MPD is not connected'));
        const fixture = create(store);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(fixture.componentInstance.error()).toBe('MPD is not connected');
        expect(fixture.componentInstance.loading()).toBeFalse();
    });

    it('ignores a stale response when the artist changed while it was in flight', async () => {
        const store = fakeStore();
        let resolveFirst: (v: unknown) => void = () => {};
        store.fetchAlbums.and.returnValues(
            new Promise((r) => {
                resolveFirst = r;
            }),
            Promise.resolve({
                albumArtist: 'Blur',
                image: '/api/art?album=Blur',
                albums: [album({ album: 'Parklife' })],
            }),
        );

        const fixture = create(store, 'Radiohead');
        fixture.detectChanges();
        fixture.componentRef.setInput('name', 'Blur');
        fixture.detectChanges();
        await fixture.whenStable();

        // The first request now lands. It must be discarded: rendering it would
        // put Radiohead's albums under Blur's name.
        resolveFirst({
            albumArtist: 'Radiohead',
            image: '/api/art?album=Radiohead',
            albums: [album({ album: 'Kid A' })],
        });
        await fixture.whenStable();

        expect(fixture.componentInstance.albums()?.map((a) => a.album)).toEqual(['Parklife']);
    });

    it('takes the hero picture from its OWN response, not the artist list', async () => {
        // Reached by URL, so the client-side artist list is empty — the state
        // after every kiosk reload and from any phone bookmark. Reading the
        // picture out of that cache showed the placeholder instead, which is
        // what a screenshot of the real device caught.
        const fixture = create(fakeStore([album()]), 'Radiohead');
        expect(fixture.componentInstance.image()).toBeNull();

        fixture.detectChanges();
        await fixture.whenStable();
        expect(fixture.componentInstance.image()).toBe('/api/art?album=Radiohead');
    });

    it('shows the placeholder for an artist the backend has no picture for', async () => {
        const store = fakeStore([album()]);
        store.fetchAlbums.and.resolveTo({ albumArtist: 'Ought', image: null, albums: [album()] });
        const fixture = create(store, 'Ought');
        fixture.detectChanges();
        await fixture.whenStable();
        expect(fixture.componentInstance.image()).toBeNull();
    });
});
