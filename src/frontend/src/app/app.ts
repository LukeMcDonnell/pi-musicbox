import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Menu } from './components/menu/menu';
import { NowPlaying } from './components/now-playing/now-playing';
import { NowPlayingMini } from './components/now-playing-mini/now-playing-mini';
import { NowPlayingSheet } from './now-playing-sheet';

/**
 * The application frame: menu, routed screen, and the two now-playing views.
 *
 * Now-playing is NOT a route. It is always mounted and slides over everything,
 * so opening it costs no component construction and the art is already decoded
 * — and it can be dismissed back to whatever screen was underneath, unchanged.
 *
 * Screens are components under components/, wired up in app.routes.ts.
 */
@Component({
    selector: 'app-root',
    imports: [RouterOutlet, Menu, NowPlaying, NowPlayingMini],
    templateUrl: './app.html',
})
export class App {
    /**
     * Whether now-playing is showing.
     *
     * On a service rather than a local signal because the library screens open
     * it too — tapping Play on an album raises it — and a routed component
     * cannot reach a field on its parent. App still owns the wiring; the service
     * owns only the boolean. See NowPlayingSheet.
     */
    readonly sheet = inject(NowPlayingSheet);
}
