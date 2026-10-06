import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { PlaylistSummary, Track } from '@musicbox/shared';
import { SaveQueueDialog } from './save-queue-dialog';
import { MusicboxApi } from '../../services/musicbox-api';
import { PlaylistsStore } from '../../services/playlists-store';

const SONG: Track = { file: 'a/1.flac', title: 'One', image: null };
const DISC: Track = { file: 'cdda:///1', title: 'Track 1', image: null };

function create(queue: Track[] = [SONG, SONG]) {
    const list: PlaylistSummary[] = [{ name: 'Sunday', trackCount: 12, duration: 900, modified: 't', covers: [] }];
    const store = {
        playlists: signal(list).asReadonly(),
        saveQueue: jasmine.createSpy('saveQueue').and.resolveTo(undefined),
        appendQueue: jasmine.createSpy('appendQueue').and.resolveTo(undefined),
        replaceWithQueue: jasmine.createSpy('replaceWithQueue').and.resolveTo(undefined),
    };
    TestBed.configureTestingModule({
        imports: [SaveQueueDialog],
        providers: [
            { provide: PlaylistsStore, useValue: store },
            { provide: MusicboxApi, useValue: { queue: signal(queue).asReadonly() } },
        ],
    });
    const fixture = TestBed.createComponent(SaveQueueDialog);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const click = (text: string) => {
        const button = [...el.querySelectorAll('button')].find((b) => b.textContent!.trim().startsWith(text));
        if (!button) throw new Error(`no button '${text}'`);
        button.click();
        fixture.detectChanges();
    };
    const saved: string[] = [];
    fixture.componentInstance.saved.subscribe((n) => saved.push(n));
    return { fixture, dialog: fixture.componentInstance, store, el, click, saved };
}

describe('SaveQueueDialog', () => {
    it('saves as a new playlist, then closes and says where', async () => {
        const { fixture, dialog, store, el, click, saved } = create();
        click('New playlist…');
        const input = el.querySelector('input') as HTMLInputElement;
        input.value = 'Late night';
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
        await fixture.whenStable();
        expect(store.saveQueue).toHaveBeenCalledWith('Late night');
        expect(saved).toEqual(['Late night']);
        expect(dialog.open()).toBeFalse();
    });

    it('offers Add to end and Replace for an existing playlist, and says what Replace loses', async () => {
        const { fixture, store, el, click } = create();
        click('Sunday');
        expect(el.querySelector('h2')!.textContent!.trim()).toBe('Sunday');
        expect(el.textContent).toContain('The 12 tracks in it now will go');
        click('Add to end');
        await fixture.whenStable();
        expect(store.appendQueue).toHaveBeenCalledWith('Sunday');
        expect(store.replaceWithQueue).not.toHaveBeenCalled();
    });

    it('replaces only when Replace itself is pressed', async () => {
        const { fixture, store, click } = create();
        click('Sunday');
        click('Replace');
        await fixture.whenStable();
        expect(store.replaceWithQueue).toHaveBeenCalledWith('Sunday');
        expect(store.appendQueue).not.toHaveBeenCalled();
    });

    it('stays open and shows a refusal', async () => {
        const { fixture, dialog, store, el, click } = create();
        store.appendQueue.and.rejectWith(new Error("no playlist named 'Sunday'"));
        click('Sunday');
        click('Add to end');
        await fixture.whenStable();
        fixture.detectChanges();
        expect(dialog.open()).toBeTrue();
        expect(el.querySelector('[role="alert"]')!.textContent).toContain('no playlist named');
    });

    it('says Audio CD tracks are left out', () => {
        const { el } = create([SONG, DISC]);
        expect(el.textContent).toContain('Audio CD tracks are left out.');
    });

    it('offers nothing to save when only CD tracks are queued', () => {
        const { el } = create([DISC, DISC]);
        expect(el.textContent).toContain('can’t be saved');
        expect(el.textContent).not.toContain('New playlist…');
    });

    it('focuses Cancel, closes on Escape, and opens again at the start', () => {
        const { fixture, dialog, click } = create();
        expect(document.activeElement!.textContent!.trim()).toBe('Cancel');
        click('Sunday');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(dialog.open()).toBeFalse();
        fixture.componentRef.setInput('open', true);
        fixture.detectChanges();
        expect(dialog.face()).toEqual({ kind: 'pick' });
    });
});
