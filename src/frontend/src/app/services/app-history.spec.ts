import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { AppHistory } from './app-history';

type Trigger = 'imperative' | 'popstate';

/** A router with no routes behind it: navigations are events, nothing else. */
function fakeRouter() {
    const events = new Subject<NavigationStart | NavigationEnd>();
    const current = signal<{ extras: { replaceUrl?: boolean } } | null>(null);
    return {
        events: events.asObservable(),
        currentNavigation: current.asReadonly(),
        navigate: jasmine.createSpy('navigate').and.resolveTo(true),
        _current: current,
        _emit: (event: NavigationStart | NavigationEnd) => events.next(event),
    };
}

function create() {
    const router = fakeRouter();
    const location = { back: jasmine.createSpy('back') };
    TestBed.configureTestingModule({
        providers: [
            { provide: Router, useValue: router },
            { provide: Location, useValue: location },
        ],
    });
    const history = TestBed.inject(AppHistory);

    /** One complete navigation, as the router would emit it. */
    function go(
        id: number,
        url: string,
        opts: { trigger?: Trigger; restored?: number; replaceUrl?: boolean } = {},
    ): void {
        router._current.set({ extras: { replaceUrl: opts.replaceUrl ?? false } });
        const restored = opts.restored ? { navigationId: opts.restored } : null;
        router._emit(new NavigationStart(id, url, opts.trigger ?? 'imperative', restored));
        router._emit(new NavigationEnd(id, url, url));
        router._current.set(null);
    }

    /** The router's own first navigation, which is a replace, not a push. */
    const boot = (url = '/library') => go(1, url, { replaceUrl: true });

    /** A back or forward gesture: a popstate, and also a replace. */
    const pop = (id: number, url: string, restored: number) =>
        go(id, url, { trigger: 'popstate', restored, replaceUrl: true });

    return { history, router, location, go, boot, pop };
}

describe('AppHistory', () => {
    it('has nowhere to go back to on a cold load', () => {
        const { history, boot } = create();
        boot('/library/artist?name=Radiohead');
        // A bookmarked artist on a phone, or the panel reloaded onto one.
        // location.back() here walks out of the app.
        expect(history.canGoBack()).toBeFalse();
    });

    it('takes the fallback when there is nothing behind', () => {
        const { history, router, location, boot } = create();
        boot('/library/artist?name=Radiohead');
        history.back(['/library']);
        expect(location.back).not.toHaveBeenCalled();
        expect(router.navigate).toHaveBeenCalledWith(['/library'], undefined);
    });

    it('goes back once a screen has been opened', () => {
        const { history, router, location, boot, go } = create();
        boot();
        go(2, '/library/artist?name=Radiohead');
        expect(history.canGoBack()).toBeTrue();

        history.back(['/library']);
        expect(location.back).toHaveBeenCalled();
        expect(router.navigate).not.toHaveBeenCalled();
    });

    it('does not count a replaced URL as somewhere to go back to', () => {
        const { history, boot, go } = create();
        boot();
        // Every keystroke in the library filter is one of these.
        for (let i = 2; i <= 6; ++i) go(i, `/library?filter=rad`.slice(0, 14 + i), { replaceUrl: true });
        expect(history.canGoBack()).toBeFalse();
    });

    it('follows a back gesture down and a forward gesture back up', () => {
        const { history, boot, go, pop } = create();
        boot();
        go(2, '/library/artist?name=Radiohead');
        go(3, '/library/album?artist=Radiohead&album=Kid%20A');
        expect(history.canGoBack()).toBeTrue();

        pop(4, '/library/artist?name=Radiohead', 2);
        pop(5, '/library', 1);
        expect(history.canGoBack()).toBeFalse();

        // Forward again: the entries are still there and the arrow can use them.
        pop(6, '/library/artist?name=Radiohead', 2);
        expect(history.canGoBack()).toBeTrue();
    });

    it('never counts below zero', () => {
        const { history, boot, pop } = create();
        boot();
        // A popstate onto an entry this app never pushed — the panel's kiosk
        // tab can carry history from before the page loaded.
        pop(2, '/library', 0);
        pop(3, '/library', 0);
        expect(history.canGoBack()).toBeFalse();
    });
});
