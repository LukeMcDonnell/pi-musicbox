import { Location } from '@angular/common';
import { provideLocationMocks, SpyLocation } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { NOW_PLAYING_STATE, NowPlayingSheet } from './now-playing-sheet';

/** A sheet over a fake history, starting on `/library` with the router's own state. */
function setup(initialState: Record<string, unknown> = { navigationId: 1 }) {
    TestBed.configureTestingModule({ providers: [provideLocationMocks()] });
    const location = TestBed.inject(Location) as SpyLocation;
    location.replaceState('/library', '', initialState);
    return { location, sheet: TestBed.inject(NowPlayingSheet) };
}

const marked = (location: SpyLocation) =>
    (location.getState() as Record<string, unknown> | null)?.[NOW_PLAYING_STATE] === true;

describe('NowPlayingSheet history', () => {
    it('opening pushes a same-URL entry that keeps the router state', () => {
        const { location, sheet } = setup();
        sheet.show();
        expect(sheet.open()).toBeTrue();
        expect(location.path()).toBe('/library');
        expect(location.getState()).toEqual({ navigationId: 1, [NOW_PLAYING_STATE]: true });
        location.back();
        expect(location.getState()).toEqual({ navigationId: 1 });
    });

    it('browser Back closes it, and Forward opens it again', () => {
        const { location, sheet } = setup();
        sheet.showQueue();
        location.back();
        expect(sheet.open()).toBeFalse();
        expect(sheet.atQueue()).toBeFalse();
        location.forward();
        expect(sheet.open()).toBeTrue();
        expect(marked(location)).toBeTrue();
    });

    it('closing in the app pops its entry, so Forward can still reopen it', async () => {
        const { location, sheet } = setup();
        sheet.show();
        await sheet.hide();
        expect(sheet.open()).toBeFalse();
        expect(marked(location)).toBeFalse();
        location.forward();
        expect(sheet.open()).toBeTrue();
    });

    it('opening twice adds one entry, not two', async () => {
        const { location, sheet } = setup();
        sheet.show();
        sheet.showQueue();
        expect(sheet.atQueue()).toBeTrue();
        await sheet.hide();
        location.back();
        // Back again leaves the page rather than landing on a second sheet entry.
        expect(sheet.open()).toBeFalse();
        expect(location.path()).toBe('/library');
    });

    it('closing a sheet with no entry of its own goes nowhere', async () => {
        const { location, sheet } = setup();
        const back = spyOn(location, 'back').and.callThrough();
        await sheet.hide();
        expect(back).not.toHaveBeenCalled();
    });

    it('Back to another page with the sheet open closes it', () => {
        const { location, sheet } = setup();
        location.go('/library/artist?name=Radiohead', '', { navigationId: 2 });
        sheet.show();
        location.back();
        location.back();
        expect(location.path()).toBe('/library');
        expect(sheet.open()).toBeFalse();
    });

    it('unmarks an entry left over from a reload, instead of opening on it', () => {
        const { location, sheet } = setup({ navigationId: 3, [NOW_PLAYING_STATE]: true });
        expect(sheet.open()).toBeFalse();
        expect(location.getState()).toEqual({ navigationId: 3 });
    });
});
