import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { signal } from '@angular/core';
import type { ArtistSummary } from '@musicbox/shared';
import { Library, ROW_HEIGHT } from './library';
import { LibraryStore } from '../../services/library-store';
import { ScrollFrame } from '../../services/scroll-frame';

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

/**
 * A scroll frame, or none.
 *
 * The real one is App's <main>. A null frame is not a harmless default: the
 * scroller falls back to measuring itself, decides all 487 rows are on screen,
 * and renders every one of them looking exactly like the list that works. That
 * is what 'publishes the scroll frame it was given' guards.
 */
function fakeFrame(element: HTMLElement | null = null) {
    return { element: signal(element).asReadonly(), set: () => {} };
}

/** A real, scrollable frame in the document, so the scroller can measure it. */
function realFrame(): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'height:480px;overflow-y:auto';
    document.body.appendChild(el);
    return el;
}

/** The scroller refreshes in requestAnimationFrame, OUTSIDE the zone — so
 *  whenStable() returns before a single row exists. Its recursion is bounded at
 *  maxRunTimes = 2, so three frames is enough and is not a timing guess. */
async function frames(count = 3): Promise<void> {
    for (let i = 0; i < count; ++i) {
        await new Promise(requestAnimationFrame);
    }
}

function create(
    store: ReturnType<typeof fakeStore>,
    frame: ReturnType<typeof fakeFrame> = fakeFrame(),
    params: Record<string, string> = {},
) {
    TestBed.configureTestingModule({
        imports: [Library],
        providers: [
            // A real route, so the navigation setQuery makes has something to match.
            provideRouter([{ path: 'library', component: Library }]),
            { provide: LibraryStore, useValue: store },
            { provide: ScrollFrame, useValue: frame },
            // The component reads `?filter=` from the snapshot, which in a test
            // is whatever this says it is.
            {
                provide: ActivatedRoute,
                useValue: { snapshot: { queryParamMap: convertToParamMap(params) } },
            },
        ],
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

    it('hands the scroller an array, and the same one each time', () => {
        const store = fakeStore(null);
        const cmp = create(store).componentInstance;
        // Never null: the scroller's items input is not optional. And never a
        // fresh array — its setter compares by reference and recomputes the whole
        // geometry on any new one, which would then happen on every check.
        expect(cmp.rows()).toEqual([]);
        expect(cmp.rows()).toBe(cmp.rows());
    });

    describe('filter', () => {
        const names = ['!!!', 'AC/DC', 'Radiohead', 'Sigur Rós', 'The Panics'];
        const list = () => names.map((name) => artist({ name }));
        const shown = (cmp: Library) => cmp.rows().map((a) => a.name);

        it('matches a substring, ignoring case and accents', () => {
            const cmp = create(fakeStore(list())).componentInstance;
            cmp.setQuery('RADIO');
            expect(shown(cmp)).toEqual(['Radiohead']);
            cmp.setQuery('sigur ros');
            expect(shown(cmp)).toEqual(['Sigur Rós']);
            cmp.setQuery('panics');
            expect(shown(cmp)).toEqual(['The Panics']);
        });

        it('matches through punctuation, without letting punctuation match everything', () => {
            const cmp = create(fakeStore(list())).componentInstance;
            cmp.setQuery('acdc');
            expect(shown(cmp)).toEqual(['AC/DC']);
            cmp.setQuery('!!!');
            expect(shown(cmp)).toEqual(['!!!']);
        });

        it("keeps MPD's order", () => {
            const cmp = create(fakeStore(list())).componentInstance;
            cmp.setQuery('a');
            expect(shown(cmp)).toEqual(['AC/DC', 'Radiohead', 'The Panics']);
        });

        it('hands the scroller the unfiltered array untouched when cleared', () => {
            const artists = list();
            const cmp = create(fakeStore(artists)).componentInstance;
            cmp.setQuery('radio');
            cmp.setQuery('   ');
            expect(cmp.rows()).toBe(artists);
        });

        it('says how many of the whole list are showing', () => {
            const cmp = create(fakeStore(list())).componentInstance;
            expect(cmp.countLabel()).toBe('5 Artists');
            cmp.setQuery('radio');
            expect(cmp.countLabel()).toBe('1 of 5 Artists');
        });

        it('starts filtered when the URL arrived with a term', () => {
            const cmp = create(fakeStore(list()), fakeFrame(), { filter: 'radio' }).componentInstance;
            // Coming back from an artist recreates this component, and the
            // filter the list was left under has to survive that.
            expect(cmp.query()).toBe('radio');
            expect(shown(cmp)).toEqual(['Radiohead']);
        });

        it('starts unfiltered when the URL carries no term', () => {
            const cmp = create(fakeStore(list())).componentInstance;
            expect(cmp.query()).toBe('');
            expect(shown(cmp)).toEqual(names);
        });

        it('puts the term in the URL, and takes it out again when cleared', async () => {
            const cmp = create(fakeStore(list())).componentInstance;
            const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

            cmp.setQuery('radio');
            expect(navigate).toHaveBeenCalledWith(
                ['/library'],
                // replaceUrl: a keystroke is not a place to go back to.
                { queryParams: { filter: 'radio' }, replaceUrl: true },
            );

            cmp.setQuery('');
            // Null, not '', or a cleared field would leave `?filter=` behind.
            expect(navigate).toHaveBeenCalledWith(
                ['/library'],
                { queryParams: { filter: null }, replaceUrl: true },
            );
        });

        it('returns to the top of the frame when the filter changes', () => {
            const element = realFrame();
            const tall = document.createElement('div');
            tall.style.height = '5000px';
            element.appendChild(tall);
            element.scrollTop = 2000;
            const cmp = create(fakeStore(list()), fakeFrame(element)).componentInstance;
            cmp.setQuery('radio');
            expect(element.scrollTop).toBe(0);
            element.remove();
        });
    });

    it('publishes the scroll frame it was given', () => {
        const element = realFrame();
        const cmp = create(fakeStore([artist()]), fakeFrame(element)).componentInstance;
        expect(cmp.frame()).toBe(element);
        element.remove();
    });

    it('creates when there is no scroll frame to be had', () => {
        // Mounted outside App's <main>, which is exactly this fixture.
        const fixture = create(fakeStore([artist()]), fakeFrame(null));
        fixture.detectChanges();
        expect(fixture.componentInstance.frame()).toBeNull();
    });

    it('tracks the visible slice and where it starts', () => {
        const cmp = create(fakeStore([artist()])).componentInstance;
        const slice = [artist({ name: 'Ought' }), artist({ name: 'Preoccupations' })];
        cmp.onViewport(slice);
        expect(cmp.visible()).toEqual(slice);
        // No scroller mounted in this fixture, so the offset falls back to 0
        // rather than throwing; aria-posinset is the only thing that reads it.
        expect(cmp.firstIndex()).toBe(0);
    });

    it('follows a scrollTop written straight onto the frame', async () => {
        // How FrameViewportScroller restores this screen: it writes scrollTop on
        // <main> and nothing else. If the scroller did not follow that, a restore
        // would land at the right offset with the list still showing row 1.
        const element = realFrame();
        const many = Array.from({ length: 200 }, (_, i) => artist({ name: `Artist ${i}` }));
        const fixture = create(fakeStore(many), fakeFrame(element));
        // The rows have to live inside the frame for its geometry to be real.
        element.appendChild(fixture.nativeElement);
        fixture.detectChanges();
        await frames();

        element.scrollTop = ROW_HEIGHT * 50;
        await frames(6);
        fixture.detectChanges();

        expect(fixture.componentInstance.firstIndex()).toBeGreaterThan(40);
        element.remove();
    });

    it('renders a row exactly ROW_HEIGHT tall', async () => {
        // The one DOM assertion in this file, and it earns its place: every index
        // the scroller computes comes from ROW_HEIGHT, so a change to the row's
        // padding that missed the constant would break scrolling with every other
        // assertion still green. Measured against the real template, never
        // against a copy of its classes — a copy would drift with it.
        const element = realFrame();
        const fixture = create(fakeStore([artist()]), fakeFrame(element));
        fixture.detectChanges();
        await frames();
        fixture.detectChanges();

        const row = fixture.nativeElement.querySelector('li') as HTMLElement | null;
        expect(row).withContext('no row rendered').not.toBeNull();
        expect(row!.offsetHeight).toBe(ROW_HEIGHT);
        element.remove();
    });
});
