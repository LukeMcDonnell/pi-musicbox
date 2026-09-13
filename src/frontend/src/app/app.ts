import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Menu } from './components/menu/menu';
import { NowPlaying } from './components/now-playing/now-playing';
import { NowPlayingMini } from './components/now-playing-mini/now-playing-mini';

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
    readonly showNowPlaying = signal<boolean>(false);
}
