import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type {
    FavouriteAlbum,
    MostPlayedArtist,
    RecentPlayAlbum,
    RecentlyAddedAlbum,
} from '@musicbox/shared';
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

function topArtists(count: number): MostPlayedArtist[] {
    return Array.from({ length: count }, (_, i) => ({
        name: `Player ${i}`,
        image: `/api/art?album=Player%20${i}`,
        plays: 100 - i,
    }));
}

/** A store whose artist list is already fetched, as it is after the first visit. */
function fakePlays(played: RecentPlayAlbum[] | null, artists: MostPlayedArtist[] | null) {
    return {
        albums: signal(played).asReadonly(),
        artists: signal(artists).asReadonly(),
        loadArtists: jasmine.createSpy('loadArtists').and.resolveTo(artists ?? []),
    };
}

function create(
    favourites: FavouriteAlbum[] | null,
    recent: RecentlyAddedAlbum[] | null = recentAlbums(20),
    played: RecentPlayAlbum[] | null = playedAlbums(20),
    artists: MostPlayedArtist[] | null = topArtists(20),
) {
    TestBed.configureTestingModule({
        imports: [Home],
        providers: [
            provideRouter(routes),
            { provide: FavouritesStore, useValue: { albums: signal(favourites).asReadonly() } },
            { provide: LibraryStore, useValue: fakeLibrary(recent) },
            { provide: PlaysStore, useValue: fakePlays(played, artists) },
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
    return shelf ? Array.from(shelf.querySelectorAll('app-album-card, app-artist-card')) : [];
}

/** The blank cards standing in for one shelf, named by its heading. */
function shelfSkeleton(fixture: ReturnType<typeof create>, heading: string): HTMLElement | null {
    const shelf = [...(fixture.nativeElement as HTMLElement).querySelectorAll('app-shelf')].find(
        (el) => el.querySelector('h2')?.textContent?.trim() === heading,
    );
    return shelf?.querySelector('app-shelf-skeleton') ?? null;
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
            .toEqual(['Recent Plays', 'Most Played Artists', 'Recently Added', 'From your Favourites']);
    });

    it('points the newest shelf at its own screen', () => {
        const host = create(albums(40)).nativeElement as HTMLElement;
        const shelves = [...host.querySelectorAll('app-shelf')];
        expect(shelves[2]!.querySelector('a')!.getAttribute('href')).toBe('/home/recently-added');
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
        expect(shelfSkeleton(fixture, 'Recently Added')).not.toBeNull();
    });

    it('an empty library leaves the favourites shelf alone', () => {
        const fixture = create(albums(40), [], [], []);
        expect(shelfCards(fixture, 'Recently Added').length).toBe(0);
        expect(shelfCards(fixture, 'From your Favourites').length).toBe(10);
    });

    it('shows all of them when there are fewer than ten', () => {
        expect(shelfCards(create(albums(4)), 'From your Favourites').length).toBe(4);
    });

    it('names the shelf and points at the full list', () => {
        const host = create(albums(40)).nativeElement as HTMLElement;
        const favourites = [...host.querySelectorAll('app-shelf')][3]!;
        expect(favourites.querySelector('h2')!.textContent!.trim()).toBe('From your Favourites');
        expect(favourites.querySelector('a')!.getAttribute('href')).toBe('/favourites');
    });

    it('says so when there are none, rather than showing an empty shelf', () => {
        const fixture = create([], [], [], []);
        expect((fixture.nativeElement as HTMLElement).textContent).toContain('No favourites yet');
        expect(cards(fixture).length).toBe(0);
    });

    it('waits, rather than claiming there are none, before the stream answers', () => {
        const fixture = create(null, [], [], []);
        expect(shelfSkeleton(fixture, 'From your Favourites')).not.toBeNull();
        expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('No favourites');
    });

    it('holds each shelf open with blank cards while it waits, heading and link and all', () => {
        const fixture = create(null, null, null, null);
        for (const [heading, href] of [
            ['Recent Plays', '/home/recent-plays'],
            ['Most Played Artists', '/home/most-played-artists'],
            ['Recently Added', '/home/recently-added'],
            ['From your Favourites', '/favourites'],
        ]) {
            expect(shelfSkeleton(fixture, heading)).withContext(heading).not.toBeNull();
            expect(shelfCards(fixture, heading).length).withContext(heading).toBe(0);
            const shelf = [...(fixture.nativeElement as HTMLElement).querySelectorAll('app-shelf')]
                .find((el) => el.querySelector('h2')?.textContent?.trim() === heading)!;
            expect(shelf.querySelector('a')!.getAttribute('href')).toBe(href);
        }
    });

    it('takes the blank cards down as each shelf fills, and not before', () => {
        // Recently added is still out while the other two have answered.
        const fixture = create(albums(40), null, playedAlbums(20), topArtists(20));
        expect(shelfSkeleton(fixture, 'Recent Plays')).toBeNull();
        expect(shelfSkeleton(fixture, 'From your Favourites')).toBeNull();
        expect(shelfSkeleton(fixture, 'Recently Added')).not.toBeNull();
    });

    it('a shelf that answered with nothing shows no blank cards either', () => {
        const fixture = create(albums(40), [], [], []);
        expect(shelfSkeleton(fixture, 'Recent Plays')).toBeNull();
        expect(shelfSkeleton(fixture, 'Recently Added')).toBeNull();
    });

    it('opens the album a card is tapped on', async () => {
        const fixture = create(albums(40), [], [], []);
        const router = TestBed.inject(Router);
        const navigate = spyOn(router, 'navigate').and.resolveTo(true);
        const first = fixture.componentInstance.albums()[0];
        (cards(fixture)[0].querySelector('button') as HTMLButtonElement).click();
        expect(navigate).toHaveBeenCalledWith(['/library/album'], {
            queryParams: { artist: first.albumArtist, album: first.album },
        });
    });

    it('shows ten of the most played artists, second, pointing at their own screen', () => {
        const fixture = create(albums(40));
        const host = fixture.nativeElement as HTMLElement;
        const artists = shelfCards(fixture, 'Most Played Artists');
        expect(artists.length).toBe(10);
        // The server's order, most played first — nothing here is shuffled.
        expect(artists[0].textContent).toContain('Player 0');
        expect(artists[0].textContent).toContain('100 plays');
        expect(artists[9].textContent).toContain('Player 9');
        expect([...host.querySelectorAll('app-shelf')][1]!.querySelector('a')!.getAttribute('href'))
            .toBe('/home/most-played-artists');
    });

    it('asks the store for the artists, which is cached and shared with that screen', () => {
        const fixture = create(albums(4), [], [], null);
        const plays = TestBed.inject(PlaysStore) as unknown as ReturnType<typeof fakePlays>;
        expect(plays.loadArtists).toHaveBeenCalled();
        expect(shelfSkeleton(fixture, 'Most Played Artists')).not.toBeNull();
    });

    it('a box that has played nothing shows no artist shelf, and leaves the others alone', () => {
        const fixture = create(albums(40), recentAlbums(20), [], []);
        expect(shelfCards(fixture, 'Most Played Artists').length).toBe(0);
        expect(shelfCards(fixture, 'Recently Added').length).toBe(10);
        expect(shelfCards(fixture, 'From your Favourites').length).toBe(10);
    });

    it('opens the artist a card is tapped on, by name rather than by path', async () => {
        const fixture = create(albums(40), [], [], [
            { name: 'AC/DC', image: null, plays: 7 },
        ]);
        const router = TestBed.inject(Router);
        const navigate = spyOn(router, 'navigate').and.resolveTo(true);
        const card = (fixture.nativeElement as HTMLElement).querySelector('app-artist-card button');
        (card as HTMLButtonElement).click();
        expect(navigate).toHaveBeenCalledWith(['/library/artist'], {
            queryParams: { name: 'AC/DC' },
        });
    });

    it('a shelf whose fetch failed simply does not appear', async () => {
        // The screen behind it reports the error; Home stays as it was.
        TestBed.configureTestingModule({
            imports: [Home],
            providers: [
                provideRouter(routes),
                { provide: FavouritesStore, useValue: { albums: signal(albums(4)).asReadonly() } },
                { provide: LibraryStore, useValue: fakeLibrary([]) },
                {
                    provide: PlaysStore,
                    useValue: {
                        albums: signal([]).asReadonly(),
                        artists: signal(null).asReadonly(),
                        loadArtists: () => Promise.reject(new Error('the box is not answering')),
                    },
                },
            ],
        });
        const fixture = TestBed.createComponent(Home);
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(shelfCards(fixture, 'From your Favourites').length).toBe(4);
    });

    it('stops asking for a cover that 404s', () => {
        const fixture = create(albums(40), [], [], []);
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
                { provide: PlaysStore, useValue: fakePlays([], []) },
            ],
        });
        const router = TestBed.inject(Router);
        await RouterTestingHarness.create('/');
        expect(router.url).toBe('/home');
        await router.navigateByUrl('/playlists');
        expect(router.url).toBe('/home');
    });
});
