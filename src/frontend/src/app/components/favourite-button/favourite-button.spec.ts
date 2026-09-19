import { TestBed } from '@angular/core/testing';
import { FavouriteButton } from './favourite-button';
import { FavouritesStore } from '../../services/favourites-store';

function create(favourite: boolean, toggle = jasmine.createSpy('toggle').and.resolveTo(undefined)) {
    TestBed.configureTestingModule({
        imports: [FavouriteButton],
        providers: [{ provide: FavouritesStore, useValue: { isFavourite: () => favourite, toggle } }],
    });
    const fixture = TestBed.createComponent(FavouriteButton);
    fixture.componentRef.setInput('albumArtist', 'Radiohead');
    fixture.componentRef.setInput('album', 'Kid A');
    fixture.componentRef.setInput('release', 'mb:kid-a');
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    return { fixture, button, toggle };
}

describe('FavouriteButton', () => {
    it('says whether the album is a favourite', () => {
        const on = create(true).button;
        expect(on.getAttribute('aria-pressed')).toBe('true');
        expect(getComputedStyle(on.querySelector('svg')!).fill).not.toBe('none');
        TestBed.resetTestingModule();
        const { button } = create(false);
        expect(button.getAttribute('aria-pressed')).toBe('false');
        expect(button.getAttribute('aria-label')).toBe('Add Kid A to favourites');
        expect(getComputedStyle(button.querySelector('svg')!).fill).toBe('none');
    });

    it('toggles the album it names, without the click reaching a row beneath', async () => {
        const { button, toggle } = create(false);
        const row = jasmine.createSpy('row');
        button.parentElement!.addEventListener('click', row);
        button.click();
        await Promise.resolve();
        expect(toggle).toHaveBeenCalledWith({ albumArtist: 'Radiohead', album: 'Kid A', release: 'mb:kid-a' });
        expect(row).not.toHaveBeenCalled();
    });

    it('reports a refusal instead of swallowing it', async () => {
        const { fixture, button } = create(false, jasmine.createSpy('toggle').and.rejectWith(new Error('no such album')));
        const failed: string[] = [];
        fixture.componentInstance.failed.subscribe((m) => failed.push(m));
        button.click();
        await fixture.whenStable();
        expect(failed).toEqual(['no such album']);
        expect(fixture.componentInstance.busy()).toBeFalse();
    });
});
