import { TestBed } from '@angular/core/testing';
import { DEFAULTS, IDLE_OPTIONS, PREFERENCES_KEY, Preferences } from './preferences';

function fresh(): Preferences {
    TestBed.resetTestingModule();
    return TestBed.inject(Preferences);
}

describe('Preferences', () => {
    beforeEach(() => localStorage.removeItem(PREFERENCES_KEY));
    afterAll(() => localStorage.removeItem(PREFERENCES_KEY));

    it('opens now-playing on Play, and does not open the queue on Queue', () => {
        const prefs = fresh();
        expect(prefs.openNowPlayingOnPlay()).toBeTrue();
        expect(prefs.openQueueOnAdd()).toBeFalse();
        // Never: a screen that changes on its own is opted into.
        expect(prefs.openNowPlayingAfterIdle()).toBe(0);
    });

    it('offers Never, every minute to ten, then fifteen and twenty', () => {
        expect(IDLE_OPTIONS.map((option) => option.value))
            .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20]);
        expect(IDLE_OPTIONS[0].label).toBe('Never');
        expect(IDLE_OPTIONS[1].label).toBe('1 minute');
        expect(IDLE_OPTIONS[2].label).toBe('2 minutes');
    });

    it('survives a reload — the whole point of storing them', () => {
        const prefs = fresh();
        prefs.set('openNowPlayingOnPlay', false);
        prefs.set('openQueueOnAdd', true);
        prefs.set('openNowPlayingAfterIdle', 15);

        const reloaded = fresh();
        expect(reloaded.openNowPlayingOnPlay()).toBeFalse();
        expect(reloaded.openQueueOnAdd()).toBeTrue();
        expect(reloaded.openNowPlayingAfterIdle()).toBe(15);
    });

    it('falls back to the default for anything it cannot read', () => {
        // Junk, a stale shape from an older build, and a key of the wrong type.
        localStorage.setItem(PREFERENCES_KEY, 'not json');
        expect(fresh().openNowPlayingOnPlay()).toBe(DEFAULTS.openNowPlayingOnPlay);

        localStorage.setItem(PREFERENCES_KEY, '{"openQueueOnAdd":true}');
        const partial = fresh();
        expect(partial.openQueueOnAdd()).toBeTrue();
        expect(partial.openNowPlayingOnPlay()).toBe(DEFAULTS.openNowPlayingOnPlay);

        localStorage.setItem(PREFERENCES_KEY, '{"openQueueOnAdd":"yes"}');
        expect(fresh().openQueueOnAdd()).toBe(DEFAULTS.openQueueOnAdd);

        // A delay this build does not offer — a value from a longer list, or a
        // number somebody typed into storage. Only what the dropdown shows.
        localStorage.setItem(PREFERENCES_KEY, '{"openNowPlayingAfterIdle":12}');
        expect(fresh().openNowPlayingAfterIdle()).toBe(DEFAULTS.openNowPlayingAfterIdle);
        localStorage.setItem(PREFERENCES_KEY, '{"openNowPlayingAfterIdle":20}');
        expect(fresh().openNowPlayingAfterIdle()).toBe(20);
    });

    it('keeps working when storage itself throws', () => {
        const getItem = spyOn(Storage.prototype, 'getItem').and.throwError('denied');
        const setItem = spyOn(Storage.prototype, 'setItem').and.throwError('denied');
        const prefs = fresh();
        expect(prefs.openNowPlayingOnPlay()).toBeTrue();
        prefs.set('openNowPlayingOnPlay', false);
        // The setting still applies for this session; only persistence is lost.
        expect(prefs.openNowPlayingOnPlay()).toBeFalse();
        expect(getItem).toHaveBeenCalled();
        expect(setItem).toHaveBeenCalled();
    });
});
