import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AlbumSummary, PlaylistSummary } from '@musicbox/shared';
import { AlbumMenu } from './album-menu';
import { PlaylistsStore } from '../../services/playlists-store';

const ALBUM: AlbumSummary = {
    album: 'Kid A',
    albumArtist: 'Radiohead',
    release: 'mb:kid-a',
    date: '2000',
    trackCount: 10,
    genres: [],
    discCount: 1,
    duration: 2497,
    image: null,
};
const REF = { albumArtist: 'Radiohead', album: 'Kid A', release: 'mb:kid-a' };

function summary(name: string): PlaylistSummary {
    return { name, trackCount: 1, duration: 60, modified: 't', covers: [] };
}

function create() {
    const store = {
        playlists: signal<PlaylistSummary[] | null>([summary('Road trip'), summary('Sunday')]).asReadonly(),
        create: jasmine.createSpy('create').and.resolveTo(undefined),
        addAlbum: jasmine.createSpy('addAlbum').and.resolveTo(undefined),
    };
    TestBed.configureTestingModule({
        imports: [AlbumMenu],
        providers: [{ provide: PlaylistsStore, useValue: store }],
    });
    const fixture = TestBed.createComponent(AlbumMenu);
    fixture.componentRef.setInput('album', ALBUM);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const click = (text: string) => {
        [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === text)!.click();
        fixture.detectChanges();
    };
    return { fixture, store, el, click, menu: fixture.componentInstance };
}

describe('AlbumMenu', () => {
    it('names the album and offers the four actions, with Cancel focused', () => {
        const { el } = create();
        expect(el.querySelector('h2')!.textContent!.trim()).toBe('Kid A');
        const labels = [...el.querySelectorAll('button')].map((b) => b.textContent!.trim());
        expect(labels).toEqual(['Play', 'Add to Queue', 'Play Next', 'Add to Playlist', 'Cancel']);
        expect(document.activeElement!.textContent!.trim()).toBe('Cancel');
    });

    for (const [label, event] of [
        ['Play', 'play'],
        ['Add to Queue', 'queue'],
        ['Play Next', 'playNext'],
    ] as const) {
        it(`${label} hands the album to the screen and closes`, () => {
            const { menu, click } = create();
            const heard: AlbumSummary[] = [];
            menu[event].subscribe((a) => heard.push(a));
            click(label);
            expect(heard).toEqual([ALBUM]);
            expect(menu.album()).toBeNull();
        });
    }

    it('adds the album to a picked playlist, then closes and says where', async () => {
        const { fixture, menu, store, click } = create();
        const added: string[] = [];
        menu.added.subscribe((name) => added.push(name));
        click('Add to Playlist');
        click('Sunday');
        await fixture.whenStable();
        expect(store.addAlbum).toHaveBeenCalledWith('Sunday', REF);
        expect(added).toEqual(['Sunday']);
        expect(menu.album()).toBeNull();
    });

    it('makes a new playlist first, and stays open on a refusal', async () => {
        const { fixture, menu, store, el, click } = create();
        click('Add to Playlist');
        click('New playlist…');
        await menu.addTo(' Late night ', true);
        expect(store.create).toHaveBeenCalledWith('Late night');
        expect(store.addAlbum).toHaveBeenCalledWith('Late night', REF);

        fixture.componentRef.setInput('album', { ...ALBUM });
        fixture.detectChanges();
        store.addAlbum.and.rejectWith(new Error('no such album in the library'));
        await menu.addTo('Sunday');
        fixture.detectChanges();
        expect(menu.album()).not.toBeNull();
        expect(el.querySelector('[role="alert"]')!.textContent).toContain('no such album');
    });

    it('closes on the backdrop and on Escape', () => {
        const { fixture, menu, el } = create();
        (el.querySelector('.fixed') as HTMLElement).click();
        expect(menu.album()).toBeNull();
        fixture.componentRef.setInput('album', { ...ALBUM });
        fixture.detectChanges();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(menu.album()).toBeNull();
    });
});
