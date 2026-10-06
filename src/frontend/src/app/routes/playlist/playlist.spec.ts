import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { CdkDragDrop } from '@angular/cdk/drag-drop';
import type { PlaylistResponse, PlaylistSummary, Track } from '@musicbox/shared';
import { Playlist } from './playlist';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { PlaylistsStore } from '../../services/playlists-store';
import { PREFERENCES_KEY } from '../../services/preferences';

const SUMMARY: PlaylistSummary = { name: 'Road trip', trackCount: 2, duration: 531, modified: 't1', covers: [] };

function response(over: Partial<PlaylistResponse> = {}): PlaylistResponse {
    return {
        playlist: SUMMARY,
        tracks: [
            { file: 'a/1.flac', title: 'Everything', artist: 'Radiohead', album: 'Kid A', duration: 267, image: null },
            { file: 'gone.flac', title: '', image: null },
        ],
        ...over,
    };
}

function create(data: PlaylistResponse = response()) {
    const playlists = signal<PlaylistSummary[] | null>([SUMMARY]);
    const store = {
        playlists: playlists.asReadonly(),
        fetchPlaylist: jasmine.createSpy('fetchPlaylist').and.resolveTo(data),
        play: jasmine.createSpy('play').and.resolveTo(undefined),
        queue: jasmine.createSpy('queue').and.resolveTo(undefined),
        moveTrack: jasmine.createSpy('moveTrack'),
        removeTrack: jasmine.createSpy('removeTrack'),
        addTrack: jasmine.createSpy('addTrack').and.resolveTo(undefined),
    };
    TestBed.configureTestingModule({
        imports: [Playlist],
        providers: [provideRouter([]), { provide: PlaylistsStore, useValue: store }],
    });
    const fixture = TestBed.createComponent(Playlist);
    fixture.componentRef.setInput('name', 'Road trip');
    return { fixture, store, playlists, el: fixture.nativeElement as HTMLElement };
}

async function settle(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
}

describe('Playlist', () => {
    beforeEach(() => localStorage.removeItem(PREFERENCES_KEY));
    afterAll(() => localStorage.removeItem(PREFERENCES_KEY));

    it('lists the tracks in order, with artist and album under each', async () => {
        const { fixture, store, el } = create();
        await settle(fixture);
        expect(store.fetchPlaylist).toHaveBeenCalledWith('Road trip');
        const rows = [...el.querySelectorAll('ol li')].map((li) =>
            [...li.querySelectorAll('span')].filter((s) => s.children.length === 0).map((s) => s.textContent!.trim()),
        );
        expect(rows[0]).toEqual(['Everything', 'Radiohead · Kid A', '4:27']);
        // A song gone from the library still shows, by its file.
        expect(rows[1]).toContain('gone.flac');
        expect(el.textContent).toContain('2 tracks · 8:51');
    });

    it('shows each track with its album cover', async () => {
        const { fixture, el } = create(
            response({ tracks: [{ file: 'a/1.flac', title: 'One', image: '/api/art?album=A' }] }),
        );
        await settle(fixture);
        const row = el.querySelector('ol li app-cover-art');
        expect(row).not.toBeNull();
        expect(fixture.componentInstance.artOf(fixture.componentInstance.tracks()[0])).toContain('/api/art?album=A');
    });

    it('tiles four different covers in the header, or shows the first alone', async () => {
        const art = (album: string) => ({ file: `${album}.flac`, title: album, image: `/api/art?album=${album}` });
        const four = create(response({ tracks: ['A', 'A', 'B', 'C', 'D', 'E'].map(art) }));
        await settle(four.fixture);
        expect(four.fixture.componentInstance.covers().map((u) => u.split('album=')[1])).toEqual(['A', 'B', 'C', 'D']);
        expect(four.el.querySelectorAll('app-cover-grid app-cover-art').length).toBe(4);

        TestBed.resetTestingModule();
        const two = create(response({ tracks: ['A', 'B'].map(art) }));
        await settle(two.fixture);
        expect(two.el.querySelectorAll('app-cover-grid app-cover-art').length).toBe(1);
    });

    it('drops a cover that failed to load, from the rows and the header', async () => {
        const { fixture } = create(response({ tracks: [{ file: 'a.flac', title: 'a', image: '/api/art?album=A' }] }));
        await settle(fixture);
        const page = fixture.componentInstance;
        const uri = page.artOf(page.tracks()[0])!;
        page.onArtError(uri);
        expect(page.artOf(page.tracks()[0])).toBeNull();
        expect(page.covers()).toEqual([]);
    });

    it('says an empty playlist is empty, and offers nothing to play', async () => {
        const { fixture, el } = create(response({ tracks: [], playlist: { ...SUMMARY, trackCount: 0, duration: null } }));
        await settle(fixture);
        expect(el.textContent).toContain('This playlist is empty.');
        const play = [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Play')!;
        expect(play.disabled).toBeTrue();
    });

    it('refetches when the streamed list says this playlist changed', async () => {
        const { fixture, store, playlists } = create();
        await settle(fixture);
        playlists.set([{ ...SUMMARY, modified: 't2', covers: [] }]);
        await settle(fixture);
        expect(store.fetchPlaylist).toHaveBeenCalledTimes(2);
    });

    it('does not refetch the old name while a rename is moving the URL', async () => {
        const { fixture, store, playlists } = create();
        await settle(fixture);
        playlists.set([{ ...SUMMARY, name: 'Renamed' }]);
        await settle(fixture);
        expect(store.fetchPlaylist).toHaveBeenCalledTimes(1);
    });

    it('plays and raises now-playing', async () => {
        const { fixture, store } = create();
        await settle(fixture);
        await fixture.componentInstance.play();
        expect(store.play).toHaveBeenCalledWith('Road trip');
        expect(TestBed.inject(NowPlayingSheet).open()).toBeTrue();
    });

    it('offers Reshuffle beside Edit, confirmed by the dialog, and reloads after', async () => {
        const { fixture, store, el } = create();
        await settle(fixture);
        const page = fixture.componentInstance;
        const reshuffle = [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Reshuffle')!;
        reshuffle.click();
        expect(page.dialog()).toEqual({ kind: 'shuffle', name: 'Road trip' });
        page.onDialogDone({ kind: 'shuffled', name: 'Road trip' });
        await settle(fixture);
        expect(store.fetchPlaylist).toHaveBeenCalledTimes(2);
    });

    it('cannot reshuffle a single track', async () => {
        const { fixture, el } = create(response({ tracks: [{ file: 'a.flac', title: 'A', image: null }] }));
        await settle(fixture);
        const reshuffle = [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Reshuffle')!;
        expect(reshuffle.disabled).toBeTrue();
    });

    it('goes back to the list after a delete, and follows a rename in the URL', async () => {
        const { fixture } = create();
        await settle(fixture);
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        fixture.componentInstance.onDialogDone({ kind: 'renamed', name: 'New', previous: 'Road trip' });
        expect(navigate).toHaveBeenCalledWith([], { queryParams: { name: 'New' }, replaceUrl: true });
        fixture.componentInstance.onDialogDone({ kind: 'deleted', name: 'New' });
        expect(navigate).toHaveBeenCalledWith(['/playlists'], { replaceUrl: true });
    });

    it('shows a missing playlist as an error rather than loading forever', async () => {
        const { fixture, store, el } = create();
        store.fetchPlaylist.and.rejectWith(new Error("no playlist named 'Road trip'"));
        await settle(fixture);
        expect(el.querySelector('[role="alert"]')!.textContent).toContain('no playlist named');
        expect(fixture.componentInstance.loading()).toBeFalse();
    });

    describe('editing', () => {
        const three = () =>
            response({
                tracks: ['a', 'b', 'c'].map((f) => ({ file: `${f}.flac`, title: f.toUpperCase(), image: null })),
                playlist: { ...SUMMARY, trackCount: 3 },
            });
        const drop = (from: number, to: number) =>
            ({ previousIndex: from, currentIndex: to }) as CdkDragDrop<Track[]>;
        const files = (page: Playlist) => page.tracks().map((t) => t.file);

        async function editing() {
            const made = create(three());
            await settle(made.fixture);
            const edit = [...made.el.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Edit')!;
            edit.click();
            made.fixture.detectChanges();
            return { ...made, page: made.fixture.componentInstance };
        }

        it('shows a grip and a × on each row, and Done to leave', async () => {
            const { el, page, fixture } = await editing();
            expect(el.querySelectorAll('[cdkDragHandle]').length).toBe(3);
            expect(el.querySelector('[aria-label="Remove B"]')).not.toBeNull();
            const done = [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Done')!;
            done.click();
            fixture.detectChanges();
            expect(page.editing()).toBeFalse();
            expect(el.querySelectorAll('[cdkDragHandle]').length).toBe(0);
        });

        it('offers no Edit or Reshuffle for an empty playlist', async () => {
            const { fixture, el } = create(response({ tracks: [], playlist: { ...SUMMARY, trackCount: 0 } }));
            await settle(fixture);
            const labels = [...el.querySelectorAll('button')].map((b) => b.textContent!.trim());
            expect(labels).not.toContain('Edit');
            expect(labels).not.toContain('Reshuffle');
        });

        it('moves the row at once, sends the file it moved, and takes the answer', async () => {
            const { page, store } = await editing();
            let answer: (r: PlaylistResponse) => void = () => {};
            store.moveTrack.and.returnValue(new Promise<PlaylistResponse>((r) => (answer = r)));

            const pending = page.drop(drop(0, 2));
            expect(files(page)).toEqual(['b.flac', 'c.flac', 'a.flac']);
            expect(store.moveTrack).toHaveBeenCalledWith('Road trip', 0, 2, 'a.flac');

            const server = response({ tracks: [{ file: 'x.flac', title: 'X', image: null }] });
            answer(server);
            await pending;
            expect(files(page)).toEqual(['x.flac']);
        });

        it('reloads and says why when a move is refused', async () => {
            const { page, store, fixture } = await editing();
            store.moveTrack.and.rejectWith(new Error('the playlist has changed; reload it'));
            await page.drop(drop(0, 1));
            await settle(fixture);
            expect(store.fetchPlaylist).toHaveBeenCalledTimes(2);
            expect(files(page)).toEqual(['a.flac', 'b.flac', 'c.flac']);
            expect(page.error()).toContain('has changed');
        });

        it('ignores a drop back where it started', async () => {
            const { page, store } = await editing();
            await page.drop(drop(1, 1));
            expect(store.moveTrack).not.toHaveBeenCalled();
        });

        it('removes by position and file, then offers Undo at that position', async () => {
            const { page, store, fixture, el } = await editing();
            store.removeTrack.and.resolveTo(response({ tracks: [] }));
            // Not whenStable(): the Undo timer keeps the zone busy for its five seconds.
            await page.remove(page.tracks()[1], 1);
            fixture.detectChanges();
            expect(store.removeTrack).toHaveBeenCalledWith('Road trip', 1, 'b.flac');
            expect(el.querySelector('[role="status"]')!.textContent).toContain('Removed “B”.');

            await page.undo();
            expect(store.addTrack).toHaveBeenCalledWith('Road trip', 'b.flac', 1);
            expect(page.removed()).toBeNull();
        });

        it('withdraws Undo after a few seconds', async () => {
            const { page, store } = await editing();
            jasmine.clock().install();
            try {
                store.removeTrack.and.resolveTo(response());
                await page.remove(page.tracks()[0], 0);
                expect(page.removed()).not.toBeNull();
                jasmine.clock().tick(5001);
                expect(page.removed()).toBeNull();
            } finally {
                jasmine.clock().uninstall();
            }
        });
    });

    describe('the track menu', () => {
        it('opens from ⋮ outside Edit mode, and Remove takes out that row', async () => {
            const tracks = ['a', 'b', 'a'].map((f) => ({ file: `${f}.flac`, title: f.toUpperCase(), image: null }));
            const { fixture, store, el } = create(response({ tracks }));
            store.removeTrack.and.resolveTo(response());
            await settle(fixture);
            const page = fixture.componentInstance;
            const dots = el.querySelectorAll('ol [aria-label^="More for"]');
            expect(dots.length).toBe(3);
            (dots[2] as HTMLButtonElement).click();
            fixture.detectChanges();
            expect(page.menuTrack()).toBe(page.tracks()[2]);
            // The second "a", by identity — not the first one with the same file.
            await page.removeFromMenu(page.tracks()[2]);
            expect(store.removeTrack).toHaveBeenCalledWith('Road trip', 2, 'a.flac');
        });

        it('is not offered in Edit mode, which has its own ×', async () => {
            const { fixture, el } = create();
            await settle(fixture);
            fixture.componentInstance.toggleEditing();
            fixture.detectChanges();
            expect(el.querySelectorAll('ol [aria-label^="More for"]').length).toBe(0);
        });
    });
});
