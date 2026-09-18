import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { FavouriteAlbum, RecentPlayAlbum, RecentlyAddedAlbum } from '@musicbox/shared';
import { FavouritesStore } from '../../services/favourites-store';
import { LibraryStore } from '../../services/library-store';
import { PlaysStore } from '../../services/plays-store';
import { favouriteAlbum } from '../../testing/fixtures';
import { routes } from '../../app.routes';
import { Home } from './home';

function albums(count: number): FavouriteAlbum[] {
    return Array.from({ length: count }, (_, i) =>
        favouriteAlbum({ album: `Album ${i}`, albumArtist: `Artist ${i}` }),
    );
}

function recentAlbums(count: number): RecentlyAddedAlbum[] {
    return Array.from({ length: count }, (_, i) => ({
        album: `New ${i}`,
        albumArtist: `Band ${i}`,
        date: '2020',
        image: `/api/art?album=New%20${i}`,
        addedAt: `2026-09-${String(18 - i).padStart(2, '0')}T10:00:00Z`,
    }));
}

/** A store whose recently-added list is already cached, as it is after the first visit. */
function fakeLibrary(recent: RecentlyAddedAlbum[] | null) {
    const albums = signal<RecentlyAddedAlbum[] | null>(recent);
    return {
        resolve: (path: string) => path,
        recentlyAdded: albums.asReadonly(),
        loadRecentlyAdded: jasmine.createSpy('loadRecentlyAdded').and.resolveTo(recent ?? []),
    };
}

function playedAlbums(count: number): RecentPlayAlbum[] {
    return Array.from({ length: count }, (_, i) => ({
        album: `Played ${i}`,
        albumArtist: `Band ${i}`,
        image: `/api/art?album=Played%20${i}`,
        playedAt: Date.now() - i * 3_600_000,
        plays: 1,
    }));
}

function create(
    favourites: FavouriteAlbum[] | null,
    recent: RecentlyAddedAlbum[] | null = recentAlbums(20),
    played: RecentPlayAlbum[] | null = playedAlbums(20),
) {
    TestBed.configureTestingModule({
        imports: [Home],
        providers: [
            provideRouter(routes),
            { provide: FavouritesStore, useValue: { albums: signal(favourites).asReadonly() } },
            { provide: LibraryStore, useValue: fakeLibrary(recent) },
            { provide: PlaysStore, useValue: { albums: signal(played).asReadonly() } },
        ],
    });
    const fixture = TestBed.createComponent(Home);
    fixture.detectChanges();
    return fixture;
}

function cards(fixture: ReturnType<typeof create>): HTMLElement[] {
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('app-album-card'));
}

/** The cards of one shelf, named by its heading. */
function shelfCards(fixture: ReturnType<typeof create>, heading: string): HTMLElement[] {
    const shelf = [...(fixture.nativeElement as HTMLElement).querySelectorAll('app-shelf')].find(
        (el) => el.querySelector('h2')?.textContent?.trim() === heading,
    );
    return shelf ? Array.from(shelf.querySelectorAll('app-album-card')) : [];
}

describe('Home', () => {
    it('shows ten favourites, however many there are', () => {
        // Two shelves now, so the cards are counted per shelf.
        expect(shelfCards(create(albums(40)), 'From your Favourites').length).toBe(10);
    });

    it('leads with ten of the newest albums, in the order the server gave them', () => {
        const fixture = create(albums(40));
        const recent = shelfCards(fixture, 'Recently Added');
        expect(recent.length).toBe(10);
        expect(recent[0].textContent).toContain('New 0');
        expect(recent[9].textContent).toContain('New 9');
        // Above the favourites, and not shuffled the way they are.
        const headings = [...(fixture.nativeElement as HTMLElement).querySelectorAll('h2')];
        expect(headings.map((h) => h.textContent!.trim()))
            .toEqual(['Recent Plays', 'Recently Added', 'From your Favourites']);
    });

    it('points the newest shelf at its own screen', () => {
        const host = create(albums(40)).nativeElement as HTMLElement;
        const shelves = [...host.querySelectorAll('app-shelf')];
        expect(shelves[1]!.querySelector('a')!.getAttribute('href')).toBe('/home/recently-added');
    });

    it('leads with what was played lately, pointing at its own screen', () => {
        const fixture = create(albums(40));
        const host = fixture.nativeElement as HTMLElement;
        const played = shelfCards(fixture, 'Recent Plays');
        expect(played.length).toBe(10);
        expect(played[0].textContent).toContain('Played 0');
        expect([...host.querySelectorAll('app-shelf')][0]!.querySelector('a')!.getAttribute('href'))
            .toBe('/home/recent-plays');
    });

    it('a box that has played nothing shows no shelf for it, and leaves the others alone', () => {
        const fixture = create(albums(40), recentAlbums(20), []);
        expect(shelfCards(fixture, 'Recent Plays').length).toBe(0);
        expect(shelfCards(fixture, 'Recently Added').length).toBe(10);
        expect(shelfCards(fixture, 'From your Favourites').length).toBe(10);
    });

    it('asks the store for the list, which is cached and shared with that screen', () => {
        const fixture = create(albums(4), null);
        const library = TestBed.inject(LibraryStore) as unknown as ReturnType<typeof fakeLibrary>;
        expect(library.loadRecentlyAdded).toHaveBeenCalled();
        expect((fixture.nativeElement as HTMLElement).textContent).toContain('Reading the library');
    });

    it('an empty library leaves the favourites shelf alone', () => {
        const fixture = create(albums(40), [], []);
        expect(shelfCards(fixture, 'Recently Added').length).toBe(0);
        expect(shelfCards(fixture, 'From your Favourites').length).toBe(10);
    });

    it('shows all of them when there are fewer than ten', () => {
        expect(shelfCards(create(albums(4)), 'From your Favourites').length).toBe(4);
    });

    it('names the shelf and points at the full list', () => {
        const host = create(albums(40)).nativeElement as HTMLElement;
        const favourites = [...host.querySelectorAll('app-shelf')][2]!;
        expect(favourites.querySelector('h2')!.textContent!.trim()).toBe('From your Favourites');
        expect(favourites.querySelector('a')!.getAttribute('href')).toBe('/favourites');
    });

    it('says so when there are none, rather than showing an empty shelf', () => {
        const fixture = create([], [], []);
        expect((fixture.nativeElement as HTMLElement).textContent).toContain('No favourites yet');
        expect(cards(fixture).length).toBe(0);
    });

    it('waits, rather than claiming there are none, before the stream answers', () => {
        const fixture = create(null, [], []);
        const text = (fixture.nativeElement as HTMLElement).textContent!;
        expect(text).toContain('Loading favourites');
        expect(text).not.toContain('No favourites yet');
    });

    it('opens the album a card is tapped on', async () => {
        const fixture = create(albums(40), [], []);
        const router = TestBed.inject(Router);
        const navigate = spyOn(router, 'navigate').and.resolveTo(true);
        const first = fixture.componentInstance.albums()[0];
        (cards(fixture)[0].querySelector('button') as HTMLButtonElement).click();
        expect(navigate).toHaveBeenCalledWith(['/library/album'], {
            queryParams: { artist: first.albumArtist, album: first.album },
        });
    });

    it('stops asking for a cover that 404s', () => {
        const fixture = create(albums(40), [], []);
        const img = (fixture.nativeElement as HTMLElement).querySelector('img')!;
        const uri = img.getAttribute('src')!;
        img.dispatchEvent(new Event('error'));
        fixture.detectChanges();
        expect(fixture.componentInstance.coverOf(fixture.componentInstance.albums()[0])).toBeNull();
        expect(uri).toContain('/api/art');
    });
});

describe('the Home route', () => {
    it('is where the app starts, and where a stale bookmark lands', async () => {
        TestBed.configureTestingModule({
            providers: [
                provideRouter(routes),
                { provide: FavouritesStore, useValue: { albums: signal(null).asReadonly() } },
                { provide: LibraryStore, useValue: fakeLibrary([]) },
                { provide: PlaysStore, useValue: { albums: signal([]).asReadonly() } },
            ],
        });
        const router = TestBed.inject(Router);
        await RouterTestingHarness.create('/');
        expect(router.url).toBe('/home');
        await router.navigateByUrl('/playlists');
        expect(router.url).toBe('/home');
    });
});
