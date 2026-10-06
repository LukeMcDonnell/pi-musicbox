import { TestBed } from '@angular/core/testing';
import { PlaylistDialog, type PlaylistDialogResult, type PlaylistDialogView } from './playlist-dialog';
import { PlaylistsStore } from '../../services/playlists-store';

function fakeStore() {
    return {
        create: jasmine.createSpy('create').and.resolveTo(undefined),
        rename: jasmine.createSpy('rename').and.resolveTo(undefined),
        remove: jasmine.createSpy('remove').and.resolveTo(undefined),
    };
}

function create(view: PlaylistDialogView, store = fakeStore()) {
    TestBed.configureTestingModule({
        imports: [PlaylistDialog],
        providers: [{ provide: PlaylistsStore, useValue: store }],
    });
    const fixture = TestBed.createComponent(PlaylistDialog);
    fixture.componentRef.setInput('view', view);
    fixture.detectChanges();
    const results: PlaylistDialogResult[] = [];
    fixture.componentInstance.done.subscribe((r) => results.push(r));
    const el = fixture.nativeElement as HTMLElement;
    const type = (text: string) => {
        const input = el.querySelector('input') as HTMLInputElement;
        input.value = text;
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
    };
    return { fixture, store, results, el, type };
}

describe('PlaylistDialog', () => {
    it('creates a playlist from the typed name, trimmed, and closes', async () => {
        const { fixture, store, results, type } = create({ kind: 'create' });
        type('  Road trip ');
        await fixture.componentInstance.submit();
        expect(store.create).toHaveBeenCalledWith('Road trip');
        expect(results).toEqual([{ kind: 'created', name: 'Road trip' }]);
        expect(fixture.componentInstance.view()).toBeNull();
    });

    it('focuses the name field so the keyboard opens on it', () => {
        const { el } = create({ kind: 'create' });
        expect(document.activeElement).toBe(el.querySelector('input'));
    });

    it('will not create a playlist with no name', async () => {
        const { fixture, store, el } = create({ kind: 'create' });
        const confirm = [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Create')!;
        expect(confirm.disabled).toBeTrue();
        await fixture.componentInstance.submit();
        expect(store.create).not.toHaveBeenCalled();
    });

    it("keeps the dialog open and shows the server's refusal", async () => {
        const store = fakeStore();
        store.create.and.rejectWith(new Error("a playlist named 'Mine' already exists"));
        const { fixture, results, el, type } = create({ kind: 'create' }, store);
        type('Mine');
        await fixture.componentInstance.submit();
        fixture.detectChanges();
        expect(results).toEqual([]);
        expect(fixture.componentInstance.view()).not.toBeNull();
        expect(el.querySelector('[role="alert"]')!.textContent).toContain('already exists');
    });

    it('renames from the current name, which it starts with', async () => {
        const { fixture, store, results, el, type } = create({ kind: 'rename', name: 'Old' });
        expect((el.querySelector('input') as HTMLInputElement).value).toBe('Old');
        type('New');
        await fixture.componentInstance.submit();
        expect(store.rename).toHaveBeenCalledWith('Old', 'New');
        expect(results).toEqual([{ kind: 'renamed', name: 'New', previous: 'Old' }]);
    });

    it('sends nothing for a rename to the same name', async () => {
        const { fixture, store } = create({ kind: 'rename', name: 'Same' });
        await fixture.componentInstance.submit();
        expect(store.rename).not.toHaveBeenCalled();
        expect(fixture.componentInstance.view()).toBeNull();
    });

    it('offers Rename and Delete, and Delete asks before it acts', async () => {
        const { fixture, store, results, el } = create({ kind: 'actions', name: 'Mix' });
        const byText = (text: string) =>
            [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === text)!;
        byText('Delete').click();
        fixture.detectChanges();
        expect(store.remove).not.toHaveBeenCalled();
        expect(el.querySelector('h2')!.textContent).toContain('Delete “Mix”?');
        // Focus on Cancel, so a stray Enter deletes nothing.
        expect(document.activeElement!.textContent!.trim()).toBe('Cancel');

        byText('Delete').click();
        await fixture.whenStable();
        expect(store.remove).toHaveBeenCalledWith('Mix');
        expect(results).toEqual([{ kind: 'deleted', name: 'Mix' }]);
    });

    it('closes on the backdrop and on Escape', () => {
        const { fixture, el } = create({ kind: 'actions', name: 'Mix' });
        (el.querySelector('.fixed') as HTMLElement).click();
        expect(fixture.componentInstance.view()).toBeNull();

        fixture.componentInstance.view.set({ kind: 'create' });
        fixture.detectChanges();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(fixture.componentInstance.view()).toBeNull();
    });
});
