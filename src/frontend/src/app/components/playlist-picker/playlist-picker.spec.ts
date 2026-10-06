import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { PlaylistSummary } from '@musicbox/shared';
import { PlaylistPicker } from './playlist-picker';
import { PlaylistsStore } from '../../services/playlists-store';

function create(naming = false) {
    const list: PlaylistSummary[] = [{ name: 'Sunday', trackCount: 3, duration: 90, modified: 't', covers: [] }];
    TestBed.configureTestingModule({
        imports: [PlaylistPicker],
        providers: [{ provide: PlaylistsStore, useValue: { playlists: signal(list).asReadonly() } }],
    });
    const fixture = TestBed.createComponent(PlaylistPicker);
    fixture.componentRef.setInput('naming', naming);
    fixture.componentRef.setInput('createLabel', 'Save');
    fixture.detectChanges();
    return { fixture, picker: fixture.componentInstance, el: fixture.nativeElement as HTMLElement };
}

describe('PlaylistPicker', () => {
    it('offers New playlist… first, then each playlist', () => {
        const { picker, el } = create();
        const heard: string[] = [];
        let wantsNew = false;
        picker.picked.subscribe((n) => heard.push(n));
        picker.newPlaylist.subscribe(() => (wantsNew = true));
        const buttons = [...el.querySelectorAll('button')];
        expect(buttons.map((b) => b.textContent!.trim())).toEqual(['New playlist…', 'Sunday']);
        buttons[0].click();
        buttons[1].click();
        expect(wantsNew).toBeTrue();
        expect(heard).toEqual(['Sunday']);
    });

    it('asks for a name, focused, and hands back a trimmed one', () => {
        const { fixture, picker, el } = create(true);
        const made: string[] = [];
        picker.create.subscribe((n) => made.push(n));
        const input = el.querySelector('input') as HTMLInputElement;
        expect(document.activeElement).toBe(input);
        const save = el.querySelector('button[type="submit"]') as HTMLButtonElement;
        expect(save.textContent!.trim()).toBe('Save');
        expect(save.disabled).toBeTrue();

        input.value = '  Late night ';
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
        expect(made).toEqual(['Late night']);
    });
});
