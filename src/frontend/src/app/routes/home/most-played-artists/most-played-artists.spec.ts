import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { MostPlayedArtist } from '@musicbox/shared';
import { MostPlayedArtists } from './most-played-artists';
import { ARTIST_ROW_HEIGHT } from '../../../components/artist-row/artist-row';
import { AppHistory } from '../../../services/app-history';
import { LibraryStore } from '../../../services/library-store';
import { PlaysStore } from '../../../services/plays-store';
import { ScrollFrame } from '../../../services/scroll-frame';

function artist(i: number, over: Partial<MostPlayedArtist> = {}): MostPlayedArtist {
    return {
        name: `Artist ${i}`,
        image: `/api/art?album=Artist%20${i}`,
        plays: 100 - i,
        ...over,
    };
}

const many = (count: number) => Array.from({ length: count }, (_, i) => artist(i));

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

async function create(artists: MostPlayedArtist[] | null = many(4), fails = false) {
    const frame = realFrame();
    const state = signal<MostPlayedArtist[] | null>(artists);
    const plays = {
        artists: state.asReadonly(),
        loadArtists: jasmine
            .createSpy('loadArtists')
            .and.callFake(() =>
                fails ? Promise.reject(new Error('the box is not answering')) : Promise.resolve(artists ?? []),
            ),
    };
    TestBed.configureTestingModule({
        imports: [MostPlayedArtists],
        providers: [
            provideRouter([]),
            { provide: PlaysStore, useValue: plays },
            { provide: LibraryStore, useValue: { resolve: (path: string) => path } },
            { provide: ScrollFrame, useValue: { element: signal(frame).asReadonly(), set: () => {} } },
        ],
    });
    const fixture = TestBed.createComponent(MostPlayedArtists);
    frame.appendChild(fixture.nativeElement);
    await settle(fixture);
    return { fixture, plays, frame, state };
}

function rows(fixture: { nativeElement: HTMLElement }): string[] {
    return [...fixture.nativeElement.querySelectorAll('li .text-xl')].map((el) =>
        el.textContent!.trim(),
    );
}

describe('MostPlayedArtists', () => {
    afterEach(() => frames.splice(0).forEach((el) => el.remove()));

    it('creates without a backend present', async () => {
        const { fixture } = await create();
        expect(fixture.componentInstance).toBeTruthy();
    });

    it('asks the store once, and shows the order the server gave', async () => {
        const { fixture, plays } = await create();
        expect(plays.loadArtists).toHaveBeenCalled();
        expect(rows(fixture)).toEqual(['Artist 0', 'Artist 1', 'Artist 2', 'Artist 3']);
    });

    it('counts the artists, singular at one', async () => {
        const { fixture } = await create(many(4));
        expect(fixture.componentInstance.countLabel()).toBe('4 Artists');
        await TestBed.resetTestingModule();
        const one = await create(many(1));
        expect(one.fixture.componentInstance.countLabel()).toBe('1 Artist');
    });

    it('reads "412 plays", and "1 play" for the one that played once', async () => {
        const { fixture } = await create([artist(0, { plays: 412 }), artist(1, { plays: 1 })]);
        const details = [...fixture.nativeElement.querySelectorAll('li .tabular-nums')].map(
            (el: Element) => el.textContent!.trim(),
        );
        expect(details).toEqual(['412 plays', '1 play']);
    });

    it('waits, rather than claiming there are none, before the fetch lands', async () => {
        const { fixture } = await create(null);
        expect(fixture.componentInstance.loading()).toBeTrue();
        expect((fixture.nativeElement as HTMLElement).textContent).toContain('Asking the box…');
        expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Nothing played yet');
    });

    it('says so when the box has played nothing', async () => {
        const { fixture } = await create([]);
        expect((fixture.nativeElement as HTMLElement).textContent).toContain('Nothing played yet');
    });

    it('reports a fetch that failed, and offers it again', async () => {
        const { fixture } = await create(null, true);
        await fixture.whenStable();
        fixture.detectChanges();
        const alert = (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]');
        expect(alert!.textContent).toContain('the box is not answering');
        expect((fixture.nativeElement as HTMLElement).textContent).toContain('Try again');
    });

    it('virtualises: a hundred artists are not a hundred rows', async () => {
        const { fixture } = await create(many(100));
        expect((fixture.nativeElement as HTMLElement).querySelectorAll('li').length).toBeLessThan(40);
    });

    it('renders a row exactly as tall as the constant the scroller indexes by', async () => {
        const { fixture } = await create();
        const row = (fixture.nativeElement as HTMLElement).querySelector('li');
        expect(row!.offsetHeight).toBe(ARTIST_ROW_HEIGHT);
    });

    it('opens an artist by name, which is the only way a slash can travel', async () => {
        const { fixture } = await create([artist(0, { name: 'AC/DC' })]);
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        (fixture.nativeElement as HTMLElement).querySelector('li button')!.dispatchEvent(
            new MouseEvent('click'),
        );
        expect(navigate).toHaveBeenCalledWith(['/library/artist'], {
            queryParams: { name: 'AC/DC' },
        });
    });

    it('shows the placeholder for an artist with no picture at all', async () => {
        const { fixture } = await create([artist(0, { image: null })]);
        expect(fixture.componentInstance.artOf(artist(0, { image: null }))).toBeNull();
        expect((fixture.nativeElement as HTMLElement).querySelector('li img')).toBeNull();
    });

    it('stops asking for a picture that 404s', async () => {
        const { fixture } = await create();
        const img = (fixture.nativeElement as HTMLElement).querySelector('li img')!;
        img.dispatchEvent(new Event('error'));
        fixture.detectChanges();
        expect(fixture.componentInstance.artOf(artist(0))).toBeNull();
        // Only that one: the pictures fail independently.
        expect(fixture.componentInstance.artOf(artist(1))).not.toBeNull();
    });

    it('goes back through history, with Home as the fallback', async () => {
        const { fixture } = await create();
        const back = spyOn(TestBed.inject(AppHistory), 'back');
        fixture.componentInstance.back();
        expect(back).toHaveBeenCalledWith(['/home']);
    });
});
