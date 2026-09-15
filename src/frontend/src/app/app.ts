import { AfterViewInit, Component, ElementRef, inject, viewChild } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Keyboard } from './components/keyboard/keyboard';
import { Menu } from './components/menu/menu';
import { NowPlaying } from './components/now-playing/now-playing';
import { NowPlayingMini } from './components/now-playing-mini/now-playing-mini';
import { NowPlayingSheet } from './services/now-playing-sheet';
import { OnScreenKeyboard } from './services/on-screen-keyboard';
import { ScrollFrame } from './services/scroll-frame';

/**
 * The application frame: menu, routed screen, and the two now-playing views.
 *
 * Now-playing is NOT a route. It is always mounted and slides over everything,
 * so opening it costs no component construction and the art is already decoded
 * — and it can be dismissed back to whatever screen was underneath, unchanged.
 *
 * Screens live under routes/, wired up in app.routes.ts.
 */
@Component({
    selector: 'app-root',
    imports: [RouterOutlet, Keyboard, Menu, NowPlaying, NowPlayingMini],
    templateUrl: './app.html',
})
export class App implements AfterViewInit {
    /**
     * Whether now-playing is showing.
     *
     * On a service rather than a local signal because the library screens open
     * it too — tapping Play on an album raises it — and a routed component
     * cannot reach a field on its parent. App still owns the wiring; the service
     * owns only the boolean. See NowPlayingSheet.
     */
    readonly sheet = inject(NowPlayingSheet);

    /** Panel only. Injected here so it is listening from boot. */
    readonly keyboard = inject(OnScreenKeyboard);

    private readonly frame = inject(ScrollFrame);

    /**
     * The <main> element from app.html — the one thing on this page that scrolls.
     *
     * Published for the same reason as the sheet boolean: a routed screen that
     * virtualises a long list needs the scroller, and only App has it. See
     * ScrollFrame for why the screens must not go looking for it themselves.
     */
    private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scrollFrame');

    ngAfterViewInit(): void {
        this.frame.set(this.scroller().nativeElement);
    }
}
