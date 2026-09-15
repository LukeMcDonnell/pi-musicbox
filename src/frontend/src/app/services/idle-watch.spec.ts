import { TestBed } from '@angular/core/testing';
import { IdleWatch } from './idle-watch';
import { NowPlayingSheet } from './now-playing-sheet';
import { PREFERENCES_KEY, Preferences } from './preferences';

const MINUTE = 60_000;

/** Someone touching the screen. Capture-phase, so the target does not matter. */
function activity(): void {
    document.dispatchEvent(new Event('pointerdown'));
}

describe('IdleWatch', () => {
    beforeEach(() => {
        localStorage.removeItem(PREFERENCES_KEY);
        jasmine.clock().install();
        jasmine.clock().mockDate(new Date(0));
        TestBed.resetTestingModule();
    });
    afterEach(() => {
        // Destroy first: the listeners come off with the injector.
        TestBed.resetTestingModule();
        jasmine.clock().uninstall();
    });
    afterAll(() => localStorage.removeItem(PREFERENCES_KEY));

    function start(minutes: number) {
        const prefs = TestBed.inject(Preferences);
        prefs.set('openNowPlayingAfterIdle', minutes);
        TestBed.inject(IdleWatch);
        TestBed.tick();
        return TestBed.inject(NowPlayingSheet);
    }

    it('does nothing at all on Never, which is the default', () => {
        const sheet = start(0);
        jasmine.clock().tick(60 * MINUTE);
        expect(sheet.open()).toBeFalse();
    });

    it('raises now-playing once the delay has passed', () => {
        const sheet = start(2);
        jasmine.clock().tick(2 * MINUTE - 1);
        expect(sheet.open()).withContext('a moment early').toBeFalse();
        jasmine.clock().tick(1);
        expect(sheet.open()).toBeTrue();
    });

    it('starts counting again from the last thing anybody did', () => {
        const sheet = start(1);
        jasmine.clock().tick(50_000);
        activity();
        jasmine.clock().tick(50_000);
        // 100s in, but only 50s since that tap.
        expect(sheet.open()).toBeFalse();
        jasmine.clock().tick(10_000);
        expect(sheet.open()).toBeTrue();
    });

    it('arms again after it has fired, rather than once per session', () => {
        const sheet = start(1);
        jasmine.clock().tick(MINUTE);
        expect(sheet.open()).toBeTrue();

        sheet.hide();
        activity();
        jasmine.clock().tick(MINUTE);
        expect(sheet.open()).withContext('a second idle period').toBeTrue();
    });

    it('takes a new delay immediately, without waiting out the old one', () => {
        const sheet = start(20);
        jasmine.clock().tick(5 * MINUTE);
        TestBed.inject(Preferences).set('openNowPlayingAfterIdle', 1);
        TestBed.tick();

        jasmine.clock().tick(MINUTE);
        expect(sheet.open()).toBeTrue();
    });

    it('stops when switched back to Never', () => {
        const sheet = start(1);
        TestBed.inject(Preferences).set('openNowPlayingAfterIdle', 0);
        TestBed.tick();
        jasmine.clock().tick(60 * MINUTE);
        expect(sheet.open()).toBeFalse();
    });
});
