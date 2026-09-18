import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { RecentPlayAlbum } from '@musicbox/shared';
import { RecentPlays } from './recent-plays';
import { ALBUM_ROW_HEIGHT } from '../../../components/album-row/album-row';
import { AppHistory } from '../../../services/app-history';
import { LibraryStore } from '../../../services/library-store';
import { NowPlayingSheet } from '../../../services/now-playing-sheet';
import { PlaysStore } from '../../../services/plays-store';
import { PREFERENCES_KEY } from '../../../services/preferences';
import { ScrollFrame } from '../../../services/scroll-frame';

const HOUR = 3_600_000;

function album(i: number, over: Partial<RecentPlayAlbum> = {}): RecentPlayAlbum {
    return {
        album: `Album ${i}`,
        albumArtist: `Artist ${i}`,
        image: `/api/art?album=Album%20${i}`,
        playedAt: Date.now() - i * HOUR,
        plays: 1,
        ...over,
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

async function create(albums: RecentPlayAlbum[] | null = many(4)) {
    const frame = realFrame();
    const state = signal<RecentPlayAlbum[] | null>(albums);
    const library = {
        resolve: (path: string) => path,
        playAlbum: jasmine.createSpy('playAlbum').and.resolveTo(undefined),
        queueAlbum: jasmine.createSpy('queueAlbum').and.resolveTo(undefined),
    };
    TestBed.configureTestingModule({
        imports: [RecentPlays],
        providers: [
            provideRouter([]),
            { provide: PlaysStore, useValue: { albums: state.asReadonly() } },
            { provide: LibraryStore, useValue: library },
            { provide: ScrollFrame, useValue: { element: signal(frame).asReadonly(), set: () => {} } },
        ],
    });
    const fixture = TestBed.createComponent(RecentPlays);
    frame.appendChild(fixture.nativeElement);
    await settle(fixture);
    return { fixture, library, frame, state };
}

function rows(fixture: { nativeElement: HTMLElement }): string[] {
    return [...fixture.nativeElement.querySelectorAll('li .text-xl')].map((el) => el.textContent!.trim());
}

describe('RecentPlays', () => {
    beforeEach(() => localStorage.removeItem(PREFERENCES_KEY));
    afterEach(() => frames.splice(0).forEach((el) => el.remove()));
    afterAll(() => localStorage.removeItem(PREFERENCES_KEY));

    it("keeps the box's order, with no sort or filter to change it", async () => {
        const { fixture } = await create(many(4));
        expect(rows(fixture)).toEqual(['Album 0', 'Album 1', 'Album 2', 'Album 3']);
        expect(fixture.nativeElement.querySelector('input[type="search"]')).toBeNull();
        expect(fixture.nativeElement.querySelector('[aria-haspopup="listbox"]')).toBeNull();
    });

    it('reads "Artist · when", because the year would say nothing in a time-ordered list', async () => {
        const now = Date.now();
        const { fixture } = await create([
            album(0, { albumArtist: 'Tool', playedAt: now - 20 * 60_000 }),
            album(1, { albumArtist: 'Pixies', playedAt: now - 30_000 }),
        ]);
        const lines = [...fixture.nativeElement.querySelectorAll('li .text-\\[0\\.85rem\\]')].map(
            (el) => (el as HTMLElement).textContent!.trim(),
        );
        expect(lines[0]).toBe('Tool · 20 minutes ago');
        expect(lines[1]).toBe('Pixies · just now');
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

    it('waits for the stream rather than claiming nothing has played', async () => {
        const { fixture, state } = await create(null);
        expect(fixture.nativeElement.textContent).toContain('Waiting for the box');
        expect(fixture.nativeElement.textContent).not.toContain('Nothing played yet');
        state.set([]);
        await settle(fixture);
        expect(fixture.nativeElement.textContent).toContain('Nothing played yet');
    });

    it('new plays arrive on the stream, with nothing fetched', async () => {
        const { fixture, state } = await create([album(0)]);
        expect(rows(fixture)).toEqual(['Album 0']);
        state.set([album(9), album(0)]);
        await settle(fixture);
        expect(rows(fixture)).toEqual(['Album 9', 'Album 0']);
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

    it('shows why a Play was refused', async () => {
        const { fixture, library } = await create([album(0)]);
        library.playAlbum.and.rejectWith(new Error('cannot play an album while a phone owns the DAC'));
        await fixture.componentInstance.play(album(0));
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[role="alert"]')!.textContent).toContain('phone owns the DAC');
    });

    it('offers the panel a way back, out of the flow everywhere else', async () => {
        const { fixture } = await create([album(0)]);
        const back = fixture.nativeElement.querySelector('[aria-label="Back"]') as HTMLButtonElement;
        expect(back).not.toBeNull();
        expect(back.parentElement!.classList).toContain('hidden');
        expect(back.parentElement!.classList).toContain('short:flex');
    });

    it('goes back through real history, falling back to Home', async () => {
        const { fixture } = await create([album(0)]);
        const back = spyOn(TestBed.inject(AppHistory), 'back');
        (fixture.nativeElement.querySelector('[aria-label="Back"]') as HTMLButtonElement).click();
        expect(back).toHaveBeenCalledWith(['/home']);
    });

    it('does not stick its heading to the top', async () => {
        const { fixture } = await create([album(0)]);
        const heading = fixture.nativeElement.querySelector('h1') as HTMLElement;
        expect(heading.classList).not.toContain('sticky');
        expect(heading.parentElement!.classList).not.toContain('sticky');
    });
});
