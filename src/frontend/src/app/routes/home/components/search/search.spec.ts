import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { SearchResponse, Track } from '@musicbox/shared';
import { LibraryStore } from '../../../../services/library-store';
import { HomeSearch, SEARCH_DEBOUNCE_MS } from './search';

const TRACK: Track = {
    file: 'AC-DC/Back in Black/06.flac',
    title: 'Back in Black',
    artist: 'AC/DC',
    albumArtist: 'AC/DC',
    album: 'Back in Black',
    release: 'mb:bib',
    image: null,
};

const RESPONSE: SearchResponse = {
    query: 'back in black',
    groups: [
        {
            kind: 'album',
            items: [{ album: 'Back in Black', albumArtist: 'AC/DC', release: 'mb:bib', date: '1980', image: null }],
        },
        { kind: 'track', items: [TRACK] },
        {
            kind: 'artist',
            items: [{ name: 'Black Sabbath', directory: 'Black Sabbath', albumCount: 3, trackCount: 30, duration: null, image: null }],
        },
    ],
};

function fakeLibrary() {
    return {
        resolve: (path: string) => path,
        search: jasmine.createSpy('search').and.resolveTo(RESPONSE),
        playAlbum: jasmine.createSpy('playAlbum').and.resolveTo(),
        queueAlbum: jasmine.createSpy('queueAlbum').and.resolveTo(),
        queueTrack: jasmine.createSpy('queueTrack').and.resolveTo(),
        playTrackNext: jasmine.createSpy('playTrackNext').and.resolveTo(),
    };
}

describe('HomeSearch', () => {
    let library: ReturnType<typeof fakeLibrary>;

    beforeEach(() => {
        library = fakeLibrary();
        TestBed.configureTestingModule({
            imports: [HomeSearch],
            providers: [provideRouter([]), { provide: LibraryStore, useValue: library }],
        });
    });

    function create() {
        const fixture = TestBed.createComponent(HomeSearch);
        fixture.detectChanges();
        return fixture;
    }

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    async function settle(fixture: ReturnType<typeof create>) {
        fixture.detectChanges();
        await wait(SEARCH_DEBOUNCE_MS + 20);
        await fixture.whenStable();
        fixture.detectChanges();
    }

    function headings(fixture: ReturnType<typeof create>): string[] {
        return [...(fixture.nativeElement as HTMLElement).querySelectorAll('h2')].map((h) => h.textContent!.trim());
    }

    it('waits for typing to pause, then sends one search', async () => {
        const fixture = create();
        for (const term of ['ba', 'bac', 'back']) {
            fixture.componentRef.setInput('query', term);
            fixture.detectChanges();
            await wait(SEARCH_DEBOUNCE_MS / 5);
        }
        expect(library.search).not.toHaveBeenCalled();
        await wait(SEARCH_DEBOUNCE_MS);
        expect(library.search).toHaveBeenCalledOnceWith('back');
    });

    it('does not search below the minimum length', async () => {
        const fixture = create();
        fixture.componentRef.setInput('query', 'b');
        await settle(fixture);
        expect(library.search).not.toHaveBeenCalled();
    });

    it('shows the groups in the order the server ranked them', async () => {
        const fixture = create();
        fixture.componentRef.setInput('query', 'back in black');
        await settle(fixture);
        expect(headings(fixture)).toEqual(['Albums', 'Tracks', 'Artists']);
    });

    it('ignores an answer to a query that has since changed', async () => {
        let answer!: (value: SearchResponse) => void;
        library.search.and.returnValues(
            new Promise<SearchResponse>((resolve) => (answer = resolve)),
            new Promise<SearchResponse>(() => {}),
        );
        const fixture = create();
        fixture.componentRef.setInput('query', 'back');
        await settle(fixture);
        fixture.componentRef.setInput('query', 'zz');
        fixture.detectChanges();
        answer(RESPONSE);
        await fixture.whenStable();
        expect(fixture.componentInstance.results()).toBeNull();
    });

    it('says when nothing matches', async () => {
        library.search.and.resolveTo({ query: 'zzz', groups: [] });
        const fixture = create();
        fixture.componentRef.setInput('query', 'zzz');
        await settle(fixture);
        expect((fixture.nativeElement as HTMLElement).textContent).toContain('Nothing matches “zzz”');
    });

    it('opens a track on its album', async () => {
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        const fixture = create();
        fixture.componentRef.setInput('query', 'back in black');
        await settle(fixture);
        const row = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
            'section[aria-label=Tracks] li button',
        )!;
        row.click();
        expect(navigate).toHaveBeenCalledWith(['/library/album'], {
            queryParams: { artist: 'AC/DC', album: 'Back in Black', release: 'mb:bib' },
        });
    });

    it('plays a track as its album, starting there', async () => {
        const fixture = create();
        await fixture.componentInstance.playTrack(TRACK);
        expect(library.playAlbum).toHaveBeenCalledWith(
            { albumArtist: 'AC/DC', album: 'Back in Black', release: 'mb:bib' },
            TRACK.file,
        );
    });

    it('queues a single track by its file', async () => {
        const fixture = create();
        await fixture.componentInstance.queueTrack(TRACK);
        expect(library.queueTrack).toHaveBeenCalledWith(TRACK.file);
    });
});
