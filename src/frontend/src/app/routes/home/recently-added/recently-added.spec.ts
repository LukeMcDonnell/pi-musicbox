import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { RecentlyAddedAlbum } from '@musicbox/shared';
import { RecentlyAdded } from './recently-added';
import { ALBUM_ROW_HEIGHT } from '../../../components/album-row/album-row';
import { AppHistory } from '../../../services/app-history';
import { LibraryStore } from '../../../services/library-store';
import { NowPlayingSheet } from '../../../services/now-playing-sheet';
import { PREFERENCES_KEY } from '../../../services/preferences';
import { ScrollFrame } from '../../../services/scroll-frame';

function album(i: number): RecentlyAddedAlbum {
    return {
        album: `Album ${i}`,
        albumArtist: `Artist ${i}`,
        date: '1997-05-21',
        image: `/api/art?album=Album%20${i}`,
        addedAt: '2026-09-18T10:00:00Z',
    };
}

const many = (count: number) => Array.from({ length: count }, (_, i) => album(i));

/** A real, scrollable frame in the document, as App's <main> is. */
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

async function create(albums: RecentlyAddedAlbum[] | null = many(4), loadFails?: Error) {
    const frame = realFrame();
    const state = signal<RecentlyAddedAlbum[] | null>(albums);
    const library = {
        resolve: (path: string) => path,
        recentlyAdded: state.asReadonly(),
        loadRecentlyAdded: jasmine
            .createSpy('loadRecentlyAdded')
            .and.callFake(async () => {
                if (loadFails) throw loadFails;
                return albums ?? [];
            }),
        playAlbum: jasmine.createSpy('playAlbum').and.resolveTo(undefined),
        queueAlbum: jasmine.createSpy('queueAlbum').and.resolveTo(undefined),
    };
    TestBed.configureTestingModule({
        imports: [RecentlyAdded],
        providers: [
            provideRouter([]),
            { provide: LibraryStore, useValue: library },
            { provide: ScrollFrame, useValue: { element: signal(frame).asReadonly(), set: () => {} } },
        ],
    });
    const fixture = TestBed.createComponent(RecentlyAdded);
    frame.appendChild(fixture.nativeElement);
    await settle(fixture);
    return { fixture, library, frame, state };
}

function rows(fixture: { nativeElement: HTMLElement }): string[] {
    return [...fixture.nativeElement.querySelectorAll('li .text-xl')].map((el) => el.textContent!.trim());
}

describe('RecentlyAdded', () => {
    beforeEach(() => localStorage.removeItem(PREFERENCES_KEY));
    afterEach(() => frames.splice(0).forEach((el) => el.remove()));
    afterAll(() => localStorage.removeItem(PREFERENCES_KEY));

    it("keeps the server's order, newest first, with no sort or filter to change it", async () => {
        const { fixture } = await create(many(4));
        expect(rows(fixture)).toEqual(['Album 0', 'Album 1', 'Album 2', 'Album 3']);
        expect(fixture.nativeElement.querySelector('input[type="search"]')).toBeNull();
        expect(fixture.nativeElement.querySelector('[aria-haspopup="listbox"]')).toBeNull();
    });

    it('asks the store for the list, which caches it', async () => {
        const { library } = await create();
        expect(library.loadRecentlyAdded).toHaveBeenCalledTimes(1);
    });

    it('reads "Artist · year", and drops the year when the album has no date', async () => {
        const { fixture } = await create([album(0), { ...album(1), date: null }]);
        const lines = [...fixture.nativeElement.querySelectorAll('li .text-\\[0\\.85rem\\]')].map(
            (el) => (el as HTMLElement).textContent!.trim(),
        );
        expect(lines[0]).toBe('Artist 0 · 1997');
        expect(lines[1]).toBe('Artist 1');
    });

    it('counts what it is showing', async () => {
        const { fixture } = await create(many(100));
        expect(fixture.nativeElement.textContent).toContain('100 Albums');
        TestBed.resetTestingModule();
        const one = await create([album(0)]);
        expect(one.fixture.nativeElement.textContent).toContain('1 Album');
        expect(one.fixture.nativeElement.textContent).not.toContain('1 Albums');
    });

    it('renders a row exactly ALBUM_ROW_HEIGHT tall', async () => {
        const { fixture } = await create([album(0)]);
        const row = fixture.nativeElement.querySelector('li') as HTMLElement | null;
        expect(row).withContext('no row rendered').not.toBeNull();
        expect(row!.offsetHeight).toBe(ALBUM_ROW_HEIGHT);
    });

    it('renders only the rows near the screen, not all 100', async () => {
        const { fixture, frame } = await create(many(100));
        const count = () => fixture.nativeElement.querySelectorAll('li').length;
        expect(count()).toBeGreaterThan(0);
        expect(count()).toBeLessThan(40);

        frame.scrollTop = ALBUM_ROW_HEIGHT * 60;
        await animationFrames(6);
        fixture.detectChanges();
        expect(fixture.componentInstance.firstIndex()).toBeGreaterThan(50);
        expect(fixture.nativeElement.querySelector('li')!.getAttribute('aria-setsize')).toBe('100');
    });

    it('waits before saying the library is empty', async () => {
        const { fixture, state } = await create(null);
        expect(fixture.nativeElement.textContent).toContain('Reading the library');
        expect(fixture.nativeElement.textContent).not.toContain('Nothing added yet');
        state.set([]);
        await settle(fixture);
        expect(fixture.nativeElement.textContent).toContain('Nothing added yet');
    });

    it('reports a refusal from the backend instead of loading forever', async () => {
        const { fixture } = await create(null, new Error('MPD is not connected'));
        await fixture.whenStable();
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[role="alert"]')!.textContent).toContain('MPD is not connected');
        expect(fixture.nativeElement.textContent).not.toContain('Reading the library');
    });

    it('opens, plays and queues the album a row names', async () => {
        const { fixture, library } = await create([album(0)]);
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        const sheet = TestBed.inject(NowPlayingSheet);
        const show = spyOn(sheet, 'show');
        const showQueue = spyOn(sheet, 'showQueue');
        const button = (label: string) =>
            fixture.nativeElement.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

        (fixture.nativeElement.querySelector('li button') as HTMLButtonElement).click();
        expect(navigate).toHaveBeenCalledWith(['/library/album'], {
            queryParams: { artist: 'Artist 0', album: 'Album 0' },
        });

        button('Play Album 0').click();
        await fixture.whenStable();
        expect(library.playAlbum).toHaveBeenCalledWith({ albumArtist: 'Artist 0', album: 'Album 0' });
        expect(show).toHaveBeenCalled();

        button('Add Album 0 to the queue').click();
        await fixture.whenStable();
        expect(library.queueAlbum).toHaveBeenCalledWith({ albumArtist: 'Artist 0', album: 'Album 0' });
        // Off by default, as on the Favourites rows.
        expect(showQueue).not.toHaveBeenCalled();
    });

    it('offers the panel a way back, out of the flow everywhere else', async () => {
        const { fixture } = await create([album(0)]);
        const back = fixture.nativeElement.querySelector('[aria-label="Back"]') as HTMLButtonElement;
        expect(back).not.toBeNull();
        // `hidden short:flex` — the short variant is the panel, per styles.scss.
        expect(back.parentElement!.classList).toContain('hidden');
        expect(back.parentElement!.classList).toContain('short:flex');
    });

    it('goes back through real history, falling back to Home', async () => {
        const { fixture } = await create([album(0)]);
        const history = TestBed.inject(AppHistory);
        const back = spyOn(history, 'back');
        (fixture.nativeElement.querySelector('[aria-label="Back"]') as HTMLButtonElement).click();
        expect(back).toHaveBeenCalledWith(['/home']);
    });

    it('does not stick its heading to the top', async () => {
        const { fixture } = await create([album(0)]);
        const heading = fixture.nativeElement.querySelector('h1') as HTMLElement;
        expect(heading.classList).not.toContain('sticky');
        expect(heading.parentElement!.classList).not.toContain('sticky');
    });

    it('shows why a Play was refused', async () => {
        const { fixture, library } = await create([album(0)]);
        library.playAlbum.and.rejectWith(new Error('cannot play an album while a phone owns the DAC'));
        await fixture.componentInstance.play(album(0));
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[role="alert"]')!.textContent).toContain('phone owns the DAC');
    });
});
