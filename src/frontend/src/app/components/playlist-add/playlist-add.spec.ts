import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { PlaylistAdd } from './playlist-add';
import { PlaylistsStore } from '../../services/playlists-store';

function create() {
    const store = {
        playlists: signal([{ name: 'Mix', trackCount: 3, duration: null, modified: '2026-10-07T00:00:00Z', covers: [] }]),
        create: jasmine.createSpy('create').and.resolveTo(undefined),
        addTracks: jasmine.createSpy('addTracks').and.resolveTo(undefined),
    };
    TestBed.configureTestingModule({ imports: [PlaylistAdd], providers: [{ provide: PlaylistsStore, useValue: store }] });
    const fixture = TestBed.createComponent(PlaylistAdd);
    fixture.componentRef.setInput('files', ['a/1.flac', 'a/2.flac']);
    fixture.componentRef.setInput('subtitle', 'Tool · Popular tracks');
    fixture.detectChanges();
    return { fixture, store, el: fixture.nativeElement as HTMLElement };
}

describe('PlaylistAdd', () => {
    it('says what it is adding', () => {
        const { el } = create();
        expect(el.textContent).toContain('Tool · Popular tracks · 2 tracks');
    });

    it('adds the songs to the playlist picked, then closes and says where', async () => {
        const { fixture, store } = create();
        const added: string[] = [];
        fixture.componentInstance.added.subscribe((name) => added.push(name));
        await fixture.componentInstance.addTo('Mix');
        expect(store.addTracks).toHaveBeenCalledWith('Mix', ['a/1.flac', 'a/2.flac']);
        expect(store.create).not.toHaveBeenCalled();
        expect(fixture.componentInstance.files()).toBeNull();
        expect(added).toEqual(['Mix']);
    });

    it('makes a new playlist first when asked', async () => {
        const { fixture, store } = create();
        await fixture.componentInstance.addTo(' New one ', true);
        expect(store.create).toHaveBeenCalledWith('New one');
        expect(store.addTracks).toHaveBeenCalledWith('New one', ['a/1.flac', 'a/2.flac']);
    });

    it('stays open and says why when the server refuses', async () => {
        const { fixture, store } = create();
        store.addTracks.and.rejectWith(new Error('MPD is not connected'));
        await fixture.componentInstance.addTo('Mix');
        expect(fixture.componentInstance.files()).not.toBeNull();
        expect(fixture.componentInstance.error()).toBe('MPD is not connected');
    });
});
