import { Location, ViewportScroller } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { App } from './app';
import { appConfig } from './app.config';
import { routes } from './app.routes';
import { ScrollFrame } from './services/scroll-frame';

describe('App', () => {
    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [App],
            providers: [provideRouter(routes)],
        }).compileComponents();
    });

    it('creates without a backend present', () => {
        // EventSource will fail to connect under test; the component must still
        // render, because that is exactly the state at boot before MPD is up.
        const fixture = TestBed.createComponent(App);
        expect(fixture.componentInstance).toBeTruthy();
    });

    // Both open buttons are always in the DOM — which one is visible is a media
    // query Karma cannot set — so each is found by its host, not by label alone.
    for (const host of ['app-now-playing-mini', 'app-now-playing-micro']) {
        it(`opens now-playing from ${host} and closes it again`, () => {
            const fixture = TestBed.createComponent(App);
            fixture.detectChanges();
            const root = fixture.nativeElement as HTMLElement;
            const view = root.querySelector('app-now-playing')!;

            root.querySelector<HTMLButtonElement>(`${host} [aria-label="Open now playing"]`)!.click();
            fixture.detectChanges();
            expect(view.hasAttribute('inert')).toBeFalse();

            const close = Array.from(view.querySelectorAll('button')).find(
                (b) => b.textContent?.trim() === 'Close',
            );
            close!.click();
            fixture.detectChanges();
            expect(view.hasAttribute('inert')).toBeTrue();
        });
    }
});

/**
 * Scroll restoration, wired the way the real app wires it.
 *
 * THIS IS THE ONE THAT CATCHES ITS ABSENCE. The feature is two lines in
 * app.config.ts that do nothing apart — drop the ViewportScroller provider and
 * the router restores the window, which does not scroll; drop the option and
 * nothing is remembered at all. Either way every other spec in this project
 * stays green. So this builds App from appConfig's own providers rather than a
 * convenient subset.
 */
describe('App scroll restoration', () => {
    let host: HTMLElement;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [App],
            providers: [...appConfig.providers, provideLocationMocks()],
        }).compileComponents();

        // A real bootstrap, not createComponent: the router only starts its
        // scroller from an APP_BOOTSTRAP_LISTENER, and the same listener is what
        // registers the popstate handler. Neither runs in a plain fixture, and
        // without them this whole feature is inert with nothing to show for it.
        host = document.createElement('app-root');
        document.body.appendChild(host);
        TestBed.inject(ApplicationRef).bootstrap(App, host);
    });

    afterEach(() => host.remove());

    it('gives the router a scroller pointed at <main>, not the window', () => {
        const main = frame();
        main.scrollTop = 120;

        // The stock ViewportScroller answers the window's position here, which
        // is [0, 0] and always will be — this page's window never scrolls.
        expect(TestBed.inject(ViewportScroller).getScrollPosition()).toEqual([0, 120]);
    });

    it('puts a screen back where it was left when you go back', async () => {
        const router = TestBed.inject(Router);
        const main = frame();
        await settled();

        await router.navigateByUrl('/settings');
        main.scrollTop = 300;

        await router.navigateByUrl('/library');
        await settled();
        expect(main.scrollTop).withContext('a forward navigation starts at the top').toBe(0);

        TestBed.inject(Location).back();
        await settled();

        expect(main.scrollTop).toBe(300);
    });
});

/**
 * The app's <main>, given a box it can actually scroll in.
 *
 * FROM ScrollFrame, not `querySelector('main')` — there are two <main> elements
 * here and now-playing's comes first, which is the whole reason that service
 * exists. Styling the wrong one is silent: the test scrolls an element nothing
 * reads. Taking it from the service also proves App published it.
 *
 * Karma loads no stylesheet, so the flex row that normally bounds <main> to the
 * viewport gives it no height at all. The spacer is a direct child of <main> so
 * that it survives the routed screen being swapped underneath it.
 */
function frame(): HTMLElement {
    const main = TestBed.inject(ScrollFrame).element()!;
    main.style.cssText = 'height:200px;overflow-y:auto';
    const spacer = document.createElement('div');
    spacer.style.height = '5000px';
    main.appendChild(spacer);
    return main;
}

/** The router defers its scroll a macrotask and a frame; the wait adds one more. */
async function settled(): Promise<void> {
    for (let i = 0; i < 4; ++i) {
        await new Promise((resolve) => setTimeout(resolve));
        await new Promise(requestAnimationFrame);
    }
}
