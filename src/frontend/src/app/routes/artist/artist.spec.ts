import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import type { AlbumSummary, ArtistSummary } from '@musicbox/shared';
import { Artist } from './artist';
import { LibraryStore } from '../../services/library-store';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { PREFERENCES_KEY } from '../../services/preferences';

function album(over: Partial<AlbumSummary> = {}): AlbumSummary {
    return {
        album: 'Kid A',
        albumArtist: 'Radiohead',
        release: 'mb:kid-a',
        date: '2000-10-02',
        trackCount: 10,
        genres: ['Alternative Rock', 'Art Rock'],
        discCount: 1,
        duration: 2497,
        image: '/api/art?album=Radiohead%2FKid%20A',
        ...over,
    };
}

function fakeStore(albums: AlbumSummary[] = [], artists: ArtistSummary[] | null = null) {
    const state = signal<ArtistSummary[] | null>(artists);
    return {
        artists: state.asReadonly(),
        playAlbum: jasmine.createSpy('playAlbum').and.resolveTo(undefined),
        queueAlbum: jasmine.createSpy('queueAlbum').and.resolveTo(undefined),
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

    it('gives every album row its own star, outside the row button', async () => {
        const fixture = create(fakeStore([album(), album({ album: 'Amnesiac' })]));
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        const stars = [...fixture.nativeElement.querySelectorAll('li app-favourite-button button')] as HTMLElement[];
        expect(stars.map((s) => s.getAttribute('aria-label'))).toEqual([
            'Add Kid A to favourites',
            'Add Amnesiac to favourites',
        ]);
        expect(stars.every((s) => s.parentElement!.closest('button') === null)).toBeTrue();
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

    it('puts the year on the track count line, and leaves it off when undated', () => {
        const cmp = create(fakeStore()).componentInstance;
        expect(cmp.detailsOf(album({ trackCount: 12, date: '1995-07-04' }))).toBe('12 tracks · 1995');
        expect(cmp.detailsOf(album({ trackCount: 1, date: null }))).toBe('1 track');
    });

    it('shows a rated album its rating, and an unrated one no separator', async () => {
        const fixture = create(
            fakeStore([album({ rating: 8.5 }), album({ album: 'Amnesiac', rating: undefined })]),
        );
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        const rows = [...fixture.nativeElement.querySelectorAll('li')] as HTMLElement[];
        const rated = rows[0]!.querySelector('app-rating');
        expect(rated).withContext('rated album has no rating').not.toBeNull();
        expect(rated!.textContent!.trim()).toBe('85%');
        expect(rated!.getAttribute('aria-label')).toBe('Rated 85%');
        // 449 of 3,062 albums have none. No rating element and, just as
        // importantly, no orphaned separator left sitting after the year.
        expect(rows[1]!.querySelector('app-rating')).toBeNull();
        expect(rows[1]!.textContent).not.toContain('·  ');
    });

    it('plays and queues an album from its row, raising the sheet as preferred', async () => {
        localStorage.removeItem(PREFERENCES_KEY);
        const store = fakeStore([album({ albumArtist: 'AC/DC', album: 'Back in Black', release: 'mb:kid-a' })]);
        const fixture = create(store, 'AC/DC');
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        const sheet = TestBed.inject(NowPlayingSheet);
        const show = spyOn(sheet, 'show');
        const showQueue = spyOn(sheet, 'showQueue');
        const button = (label: string) =>
            fixture.nativeElement.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

        // Queue, then Play last at the row's edge.
        const labels = [...fixture.nativeElement.querySelectorAll('li > button')].map((b) =>
            (b as HTMLElement).getAttribute('aria-label'),
        );
        expect(labels).toEqual([null, 'Add Back in Black to the queue', 'Play Back in Black']);

        button('Play Back in Black').click();
        await fixture.whenStable();
        expect(store.playAlbum).toHaveBeenCalledWith({ albumArtist: 'AC/DC', album: 'Back in Black', release: 'mb:kid-a' });
        expect(show).toHaveBeenCalled();

        button('Add Back in Black to the queue').click();
        await fixture.whenStable();
        expect(store.queueAlbum).toHaveBeenCalledWith({ albumArtist: 'AC/DC', album: 'Back in Black', release: 'mb:kid-a' });
        expect(showQueue).not.toHaveBeenCalled();
    });

    it('hides the row star below 40rem, where phones get their layout', async () => {
        const fixture = create(fakeStore([album()]));
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        const wrapper = fixture.nativeElement.querySelector('li app-favourite-button')!.parentElement as HTMLElement;
        expect(wrapper.classList).toContain('max-[40rem]:hidden');
        // Karma's browser is wider than a phone, so the star is still there to press.
        expect(getComputedStyle(wrapper).display).toBe('contents');
    });

    it('shows why a Play from a row was refused', async () => {
        const store = fakeStore();
        store.playAlbum.and.rejectWith(new Error('cannot play an album while a phone owns the DAC'));
        const fixture = create(store);
        await fixture.componentInstance.play(album());
        expect(fixture.componentInstance.error()).toContain('phone owns the DAC');
        expect(fixture.componentInstance.busy()).toBeFalse();
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
