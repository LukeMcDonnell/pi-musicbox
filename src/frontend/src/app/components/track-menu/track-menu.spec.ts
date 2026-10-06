import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { PlaylistSummary, Track } from '@musicbox/shared';
import { TrackMenu, type TrackAction } from './track-menu';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { PlaylistsStore } from '../../services/playlists-store';

const TRACK: Track = { file: 'a/1.flac', title: 'Everything', artist: 'Radiohead', image: null };

function summary(name: string): PlaylistSummary {
    return { name, trackCount: 1, duration: 60, modified: 't', covers: [] };
}

function create(actions?: readonly TrackAction[], track: Track = TRACK) {
    const store = {
        playlists: signal<PlaylistSummary[] | null>([summary('Road trip'), summary('Sunday')]).asReadonly(),
        create: jasmine.createSpy('create').and.resolveTo(undefined),
        addTrack: jasmine.createSpy('addTrack').and.resolveTo(undefined),
    };
    TestBed.configureTestingModule({
        imports: [TrackMenu],
        providers: [{ provide: PlaylistsStore, useValue: store }],
    });
    const fixture = TestBed.createComponent(TrackMenu);
    if (actions) fixture.componentRef.setInput('actions', actions);
    fixture.componentRef.setInput('track', track);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
        [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === text) as HTMLButtonElement;
    const click = (text: string) => {
        button(text).click();
        fixture.detectChanges();
    };
    return { fixture, store, el, button, click, menu: fixture.componentInstance };
}

describe('TrackMenu', () => {
    it('names the track and offers the four actions, with Cancel focused', () => {
        const { el } = create();
        expect(el.querySelector('h2')!.textContent!.trim()).toBe('Everything');
        const labels = [...el.querySelectorAll('button')].map((b) => b.textContent!.trim());
        expect(labels).toEqual(['Play', 'Add to Queue', 'Play Next', 'Add to Playlist', 'Cancel']);
        // Not Play: an Enter left over from the tap must not replace the queue.
        expect(document.activeElement!.textContent!.trim()).toBe('Cancel');
    });

    for (const [label, event] of [
        ['Play', 'play'],
        ['Add to Queue', 'queue'],
        ['Play Next', 'playNext'],
    ] as const) {
        it(`${label} hands the track to the screen and closes`, () => {
            const { menu, click } = create();
            const heard: Track[] = [];
            menu[event].subscribe((t) => heard.push(t));
            click(label);
            expect(heard).toEqual([TRACK]);
            expect(menu.track()).toBeNull();
        });
    }

    it('adds to a picked playlist, then closes and says where', async () => {
        const { fixture, menu, store, click, button } = create();
        const added: string[] = [];
        menu.added.subscribe((name) => added.push(name));
        click('Add to Playlist');
        expect(button('New playlist…')).toBeDefined();
        click('Sunday');
        await fixture.whenStable();
        expect(store.addTrack).toHaveBeenCalledWith('Sunday', 'a/1.flac');
        expect(store.create).not.toHaveBeenCalled();
        expect(added).toEqual(['Sunday']);
        expect(menu.track()).toBeNull();
    });

    it('makes a new playlist and adds the track to it', async () => {
        const { fixture, menu, store, el, click } = create();
        click('Add to Playlist');
        click('New playlist…');
        const input = el.querySelector('input') as HTMLInputElement;
        expect(document.activeElement).toBe(input);
        input.value = ' Late night ';
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
        await fixture.whenStable();
        expect(store.create).toHaveBeenCalledWith('Late night');
        expect(store.addTrack).toHaveBeenCalledWith('Late night', 'a/1.flac');
        expect(menu.track()).toBeNull();
    });

    it('stays open and shows the refusal when the name is taken', async () => {
        const { fixture, menu, store, el, click } = create();
        store.create.and.rejectWith(new Error("a playlist named 'Sunday' already exists"));
        click('Add to Playlist');
        click('New playlist…');
        await menu.addTo('Sunday', true);
        fixture.detectChanges();
        expect(store.addTrack).not.toHaveBeenCalled();
        expect(menu.track()).not.toBeNull();
        expect(el.querySelector('[role="alert"]')!.textContent).toContain('already exists');
    });

    it('steps back from the name to the list to the actions', () => {
        const { menu, el, click } = create();
        click('Add to Playlist');
        click('New playlist…');
        (el.querySelector('[aria-label="Back"]') as HTMLButtonElement).click();
        expect(menu.face()).toBe('pick');
        (el.querySelector('[aria-label="Back"]') as HTMLButtonElement).click();
        expect(menu.face()).toBe('actions');
    });

    it('opens on the actions again for the next track', () => {
        const { fixture, menu, click } = create();
        click('Add to Playlist');
        fixture.componentRef.setInput('track', { ...TRACK, file: 'a/2.flac' });
        fixture.detectChanges();
        expect(menu.face()).toBe('actions');
    });

    it('closes on the backdrop and on Escape', () => {
        const { fixture, menu, el } = create();
        (el.querySelector('.fixed') as HTMLElement).click();
        expect(menu.track()).toBeNull();
        fixture.componentRef.setInput('track', TRACK);
        fixture.detectChanges();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(menu.track()).toBeNull();
    });

    describe('Remove and Go to', () => {
        const ACTIONS: readonly TrackAction[] = ['remove', 'artist', 'album'];
        const LIBRARY: Track = { ...TRACK, albumArtist: 'AC/DC', album: 'Back in Black', release: 'mb:bib' };

        it('offers just the actions it is given, with the remove label', () => {
            const { fixture, el } = create(ACTIONS, LIBRARY);
            fixture.componentRef.setInput('removeLabel', 'Remove from Queue');
            fixture.detectChanges();
            const labels = [...el.querySelectorAll('button')].map((b) => b.textContent!.trim());
            expect(labels).toEqual(['Remove from Queue', 'Go to Artist', 'Go to Album', 'Cancel']);
        });

        it('hands Remove to the screen and closes', () => {
            const { menu, click } = create(ACTIONS, LIBRARY);
            const heard: Track[] = [];
            menu.remove.subscribe((t) => heard.push(t));
            click('Remove');
            expect(heard).toEqual([LIBRARY]);
            expect(menu.track()).toBeNull();
        });

        it('leaves through the sheet for the artist and the album, keys encoded', () => {
            const { menu, click } = create(ACTIONS, LIBRARY);
            const leave = spyOn(TestBed.inject(NowPlayingSheet), 'leaveTo').and.resolveTo();
            click('Go to Artist');
            expect(leave).toHaveBeenCalledWith('/library/artist?name=AC%2FDC');
            expect(menu.track()).toBeNull();
        });

        it('goes to the album by all three keys', () => {
            const { click } = create(ACTIONS, LIBRARY);
            const leave = spyOn(TestBed.inject(NowPlayingSheet), 'leaveTo').and.resolveTo();
            click('Go to Album');
            expect(leave).toHaveBeenCalledWith('/library/album?artist=AC%2FDC&album=Back%20in%20Black&release=mb:bib');
        });

        it('disables Go to for a track with no library album, such as a CD track', () => {
            const { button } = create(ACTIONS, { file: 'cdda:///1', title: 'Track 1', image: null });
            expect(button('Go to Artist').disabled).toBeTrue();
            expect(button('Go to Album').disabled).toBeTrue();
        });
    });
});
