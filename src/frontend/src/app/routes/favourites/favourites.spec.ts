import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { FavouriteAlbum } from '@musicbox/shared';
import { Favourites, filterFavourites, sortFavourites } from './favourites';
import { ALBUM_ROW_HEIGHT } from '../../components/album-row/album-row';
import { FavouritesStore } from '../../services/favourites-store';
import { LibraryStore } from '../../services/library-store';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { PREFERENCES_KEY, Preferences } from '../../services/preferences';
import { ScrollFrame } from '../../services/scroll-frame';
import { favouriteAlbum } from '../../testing/fixtures';

const OK = favouriteAlbum({ albumArtist: 'Radiohead', album: 'OK Computer', date: '1997-05-21', addedAt: 3 });
const KID_A = favouriteAlbum({ albumArtist: 'Radiohead', album: 'Kid A', date: '2000-10-02', addedAt: 1 });
const BACK = favouriteAlbum({ albumArtist: 'AC/DC', album: 'Back in Black', date: '1980', addedAt: 2 });
const UNDATED = favouriteAlbum({ albumArtist: 'Zappa', album: 'Bootleg', date: null, addedAt: 4 });
const ALL = [OK, KID_A, BACK, UNDATED];

const titles = (albums: FavouriteAlbum[]) => albums.map((a) => a.album);

/** A real, scrollable frame in the document, as App's <main> is. Removed after each test. */
const frames: HTMLElement[] = [];
function realFrame(): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'height:480px;overflow-y:auto';
    document.body.appendChild(el);
    frames.push(el);
    return el;
}

/** The scroller refreshes in requestAnimationFrame, outside the zone. See library.spec. */
async function animationFrames(count = 3): Promise<void> {
    for (let i = 0; i < count; ++i) await new Promise(requestAnimationFrame);
}

async function settle(fixture: { detectChanges: () => void }): Promise<void> {
    fixture.detectChanges();
    await animationFrames();
    fixture.detectChanges();
}

async function create(albums: FavouriteAlbum[] | null = ALL) {
    const frame = realFrame();
    const favourites = signal<FavouriteAlbum[] | null>(albums);
    const library = {
        playAlbum: jasmine.createSpy('playAlbum').and.resolveTo(undefined),
        queueAlbum: jasmine.createSpy('queueAlbum').and.resolveTo(undefined),
        resolve: (path: string) => path,
    };
    TestBed.configureTestingModule({
        imports: [Favourites],
        providers: [
            // A real route, so the navigation setQuery makes has something to match.
            provideRouter([{ path: 'favourites', component: Favourites }]),
            { provide: LibraryStore, useValue: library },
            {
                provide: FavouritesStore,
                useValue: { albums: favourites.asReadonly() },
            },
            { provide: ScrollFrame, useValue: { element: signal(frame).asReadonly(), set: () => {} } },
        ],
    });
    const fixture = TestBed.createComponent(Favourites);
    // The rows have to live inside the frame for its geometry to be real.
    frame.appendChild(fixture.nativeElement);
    await settle(fixture);
    return { fixture, library, favourites, frame };
}

function rows(fixture: { nativeElement: HTMLElement }): string[] {
    return [...fixture.nativeElement.querySelectorAll('li .text-xl')].map((el) => el.textContent!.trim());
}

describe('sortFavourites', () => {
    it('by date added, newest first or oldest first', () => {
        expect(titles(sortFavourites(ALL, 'added', true))).toEqual(['Bootleg', 'OK Computer', 'Back in Black', 'Kid A']);
        expect(titles(sortFavourites(ALL, 'added', false))).toEqual(['Kid A', 'Back in Black', 'OK Computer', 'Bootleg']);
    });

    it('by release date, with undated albums last in both directions', () => {
        expect(titles(sortFavourites(ALL, 'released', false))).toEqual(['Back in Black', 'OK Computer', 'Kid A', 'Bootleg']);
        expect(titles(sortFavourites(ALL, 'released', true))).toEqual(['Kid A', 'OK Computer', 'Back in Black', 'Bootleg']);
    });

    it('by album title, either way', () => {
        expect(titles(sortFavourites(ALL, 'title', false))).toEqual(['Back in Black', 'Bootleg', 'Kid A', 'OK Computer']);
        expect(titles(sortFavourites(ALL, 'title', true))).toEqual(['OK Computer', 'Kid A', 'Bootleg', 'Back in Black']);
    });

    it("by artist, keeping each artist's albums oldest first", () => {
        expect(titles(sortFavourites(ALL, 'artist', false))).toEqual(['Back in Black', 'OK Computer', 'Kid A', 'Bootleg']);
        expect(titles(sortFavourites(ALL, 'artist', true))).toEqual(['Bootleg', 'OK Computer', 'Kid A', 'Back in Black']);
    });

    it('does not reorder the list it was given', () => {
        const input = [...ALL];
        sortFavourites(input, 'title', false);
        expect(input).toEqual(ALL);
    });
});

describe('filterFavourites', () => {
    const SIGUR = favouriteAlbum({ albumArtist: 'Sigur Rós', album: 'Ágætis byrjun' });
    const LIST = [...ALL, SIGUR];

    it('matches the artist or the album title, ignoring case', () => {
        expect(titles([...filterFavourites(LIST, 'radiohead')])).toEqual(['OK Computer', 'Kid A']);
        expect(titles([...filterFavourites(LIST, 'BLACK')])).toEqual(['Back in Black']);
    });

    it('ignores accents and punctuation, as the Library does', () => {
        expect(titles([...filterFavourites(LIST, 'sigur ros')])).toEqual(['Ágætis byrjun']);
        expect(titles([...filterFavourites(LIST, 'acdc')])).toEqual(['Back in Black']);
    });

    it('treats a blank term as no filter, and punctuation alone as matching nothing', () => {
        expect(filterFavourites(LIST, '  ')).toBe(LIST);
        expect(filterFavourites(LIST, '!!!').length).toBe(0);
    });
});

describe('Favourites', () => {
    beforeEach(() => localStorage.removeItem(PREFERENCES_KEY));
    afterAll(() => localStorage.removeItem(PREFERENCES_KEY));
    afterEach(() => frames.splice(0).forEach((el) => el.remove()));

    it('lists the newest favourite first by default', async () => {
        const { fixture } = await create();
        expect(rows(fixture)).toEqual(['Bootleg', 'OK Computer', 'Back in Black', 'Kid A']);
    });

    it('says it is loading before the first frame, and what to do when empty', async () => {
        const { fixture, favourites } = await create(null);
        expect(fixture.nativeElement.textContent).toContain('Loading favourites');
        favourites.set([]);
        await settle(fixture);
        expect(fixture.nativeElement.textContent).toContain('No favourites yet');
    });

    it('restores the sort this device last chose', async () => {
        localStorage.setItem(
            PREFERENCES_KEY,
            JSON.stringify({ favouritesSortBy: 'title', favouritesSortDescending: false }),
        );
        const { fixture } = await create();
        expect(rows(fixture)).toEqual(['Back in Black', 'Bootleg', 'Kid A', 'OK Computer']);
    });

    it('stores a changed sort and direction', async () => {
        const { fixture } = await create();
        fixture.componentInstance.setSort(1);
        fixture.componentInstance.toggleDirection();
        await settle(fixture);
        const prefs = TestBed.inject(Preferences);
        expect(prefs.favouritesSortBy()).toBe('released');
        expect(prefs.favouritesSortDescending()).toBeFalse();
        expect(rows(fixture)).toEqual(['Back in Black', 'OK Computer', 'Kid A', 'Bootleg']);
    });

    it('opens the album a row names', async () => {
        const { fixture } = await create([BACK]);
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        (fixture.nativeElement.querySelector('li button') as HTMLButtonElement).click();
        expect(navigate).toHaveBeenCalledWith(['/library/album'], {
            queryParams: { artist: 'AC/DC', album: 'Back in Black' },
        });
    });

    it('plays and queues the album a row names, raising the sheet as preferred', async () => {
        const { fixture, library } = await create([BACK]);
        const sheet = TestBed.inject(NowPlayingSheet);
        const show = spyOn(sheet, 'show');
        const showQueue = spyOn(sheet, 'showQueue');
        const button = (label: string) =>
            fixture.nativeElement.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

        button('Play Back in Black').click();
        await fixture.whenStable();
        expect(library.playAlbum).toHaveBeenCalledWith({ albumArtist: 'AC/DC', album: 'Back in Black' });
        expect(show).toHaveBeenCalled();

        button('Add Back in Black to the queue').click();
        await fixture.whenStable();
        expect(library.queueAlbum).toHaveBeenCalledWith({ albumArtist: 'AC/DC', album: 'Back in Black' });
        // Off by default: Queue is pressed several times in a row.
        expect(showQueue).not.toHaveBeenCalled();
    });

    it('offers Play and Queue on a row, but no heart to un-favourite it', async () => {
        const { fixture } = await create([BACK]);
        const labels = [...fixture.nativeElement.querySelectorAll('li button')].map((b) =>
            (b as HTMLElement).getAttribute('aria-label'),
        );
        expect(labels).toEqual([null, 'Add Back in Black to the queue', 'Play Back in Black']);
        expect(fixture.nativeElement.querySelector('app-favourite-button')).toBeNull();
    });

    it('shows why a Play was refused', async () => {
        const { fixture, library } = await create([BACK]);
        library.playAlbum.and.rejectWith(new Error('cannot play an album while a phone owns the DAC'));
        await fixture.componentInstance.play(BACK);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain('phone owns the DAC');
    });

    it('counts the albums in place of a "Sort by" label, and what a filter leaves', async () => {
        const { fixture } = await create();
        const trigger = () => fixture.nativeElement.querySelector('[aria-haspopup="listbox"]') as HTMLElement;
        expect(trigger().textContent).toContain('4 Albums');
        expect(trigger().textContent).not.toContain('Sort by');
        expect(trigger().getAttribute('aria-label')).toBe('Sort by: Date added');

        fixture.componentInstance.setQuery('radiohead');
        await settle(fixture);
        expect(trigger().textContent).toContain('2 of 4 Albums');
        expect(rows(fixture)).toEqual(['OK Computer', 'Kid A']);
    });

    it('says one Album, not one Albums', async () => {
        const { fixture } = await create([BACK]);
        expect(fixture.nativeElement.textContent).toContain('1 Album');
        expect(fixture.nativeElement.textContent).not.toContain('1 Albums');
    });

    it('keeps the filter in the URL without adding history, and says when nothing matches', async () => {
        const { fixture } = await create();
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        const input = fixture.nativeElement.querySelector('input[type="search"]') as HTMLInputElement;
        input.value = 'zzz';
        input.dispatchEvent(new Event('input'));
        await settle(fixture);
        expect(navigate).toHaveBeenCalledWith(['/favourites'], { queryParams: { filter: 'zzz' }, replaceUrl: true });
        expect(fixture.nativeElement.textContent).toContain('No albums match “zzz”');
        expect(fixture.nativeElement.textContent).not.toContain('No favourites yet');

        (fixture.nativeElement.querySelector('button[aria-label="Clear filter"]') as HTMLButtonElement).click();
        await settle(fixture);
        expect(navigate).toHaveBeenCalledWith(['/favourites'], { queryParams: { filter: null }, replaceUrl: true });
        expect(rows(fixture).length).toBe(4);
    });

    it('renders a row exactly ALBUM_ROW_HEIGHT tall', async () => {
        // Every index the scroller computes comes from this number, so the row's padding must agree with it.
        const { fixture } = await create([BACK]);
        const row = fixture.nativeElement.querySelector('li') as HTMLElement | null;
        expect(row).withContext('no row rendered').not.toBeNull();
        expect(row!.offsetHeight).toBe(ALBUM_ROW_HEIGHT);
    });

    it('renders only the rows near the screen, not every favourite', async () => {
        const many = Array.from({ length: 200 }, (_, i) =>
            favouriteAlbum({ albumArtist: `Artist ${i}`, album: `Album ${i}`, addedAt: i }),
        );
        const { fixture, frame } = await create(many);
        const count = () => fixture.nativeElement.querySelectorAll('li').length;
        expect(count()).toBeGreaterThan(0);
        expect(count()).toBeLessThan(40);

        frame.scrollTop = ALBUM_ROW_HEIGHT * 100;
        await animationFrames(6);
        fixture.detectChanges();
        expect(fixture.componentInstance.firstIndex()).toBeGreaterThan(90);
        const posinset = Number(fixture.nativeElement.querySelector('li')!.getAttribute('aria-posinset'));
        expect(posinset).toBeGreaterThan(90);
        expect(fixture.nativeElement.querySelector('li')!.getAttribute('aria-setsize')).toBe('200');
    });

    it('returns to the top when the filter or the sort changes', async () => {
        const many = Array.from({ length: 200 }, (_, i) =>
            favouriteAlbum({ albumArtist: `Artist ${i}`, album: `Album ${i}`, addedAt: i }),
        );
        const { fixture, frame } = await create(many);
        spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        const cmp = fixture.componentInstance;
        for (const change of [() => cmp.setQuery('Artist'), () => cmp.setSort(2), () => cmp.toggleDirection()]) {
            frame.scrollTop = ALBUM_ROW_HEIGHT * 50;
            expect(frame.scrollTop).toBeGreaterThan(0);
            change();
            expect(frame.scrollTop).toBe(0);
        }
    });
});
