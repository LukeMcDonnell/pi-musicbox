import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { FavouriteAlbum } from '@musicbox/shared';
import { FavouritesStore } from '../../services/favourites-store';
import { LibraryStore } from '../../services/library-store';
import { favouriteAlbum } from '../../testing/fixtures';
import { routes } from '../../app.routes';
import { Home } from './home';

function albums(count: number): FavouriteAlbum[] {
    return Array.from({ length: count }, (_, i) =>
        favouriteAlbum({ album: `Album ${i}`, albumArtist: `Artist ${i}` }),
    );
}

function create(favourites: FavouriteAlbum[] | null) {
    TestBed.configureTestingModule({
        imports: [Home],
        providers: [
            provideRouter(routes),
            { provide: FavouritesStore, useValue: { albums: signal(favourites).asReadonly() } },
            { provide: LibraryStore, useValue: { resolve: (path: string) => path } },
        ],
    });
    const fixture = TestBed.createComponent(Home);
    fixture.detectChanges();
    return fixture;
}

function cards(fixture: ReturnType<typeof create>): HTMLElement[] {
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('app-album-card'));
}

describe('Home', () => {
    it('shows ten favourites, however many there are', () => {
        expect(cards(create(albums(40))).length).toBe(10);
    });

    it('shows all of them when there are fewer than ten', () => {
        expect(cards(create(albums(4))).length).toBe(4);
    });

    it('names the shelf and points at the full list', () => {
        const host = create(albums(40)).nativeElement as HTMLElement;
        expect(host.querySelector('h2')!.textContent!.trim()).toBe('From your Favourites');
        expect(host.querySelector('app-shelf a')!.getAttribute('href')).toBe('/favourites');
    });

    it('says so when there are none, rather than showing an empty shelf', () => {
        const fixture = create([]);
        expect((fixture.nativeElement as HTMLElement).textContent).toContain('No favourites yet');
        expect(cards(fixture).length).toBe(0);
    });

    it('waits, rather than claiming there are none, before the stream answers', () => {
        const fixture = create(null);
        const text = (fixture.nativeElement as HTMLElement).textContent!;
        expect(text).toContain('Loading favourites');
        expect(text).not.toContain('No favourites yet');
    });

    it('opens the album a card is tapped on', async () => {
        const fixture = create(albums(40));
        const router = TestBed.inject(Router);
        const navigate = spyOn(router, 'navigate').and.resolveTo(true);
        const first = fixture.componentInstance.albums()[0];
        (cards(fixture)[0].querySelector('button') as HTMLButtonElement).click();
        expect(navigate).toHaveBeenCalledWith(['/library/album'], {
            queryParams: { artist: first.albumArtist, album: first.album },
        });
    });

    it('stops asking for a cover that 404s', () => {
        const fixture = create(albums(40));
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
                { provide: LibraryStore, useValue: { resolve: (path: string) => path } },
            ],
        });
        const router = TestBed.inject(Router);
        await RouterTestingHarness.create('/');
        expect(router.url).toBe('/home');
        await router.navigateByUrl('/playlists');
        expect(router.url).toBe('/home');
    });
});
