import { Component, signal } from '@angular/core';
import { NowPlaying } from './components/now-playing/now-playing';

/**
 * The application host, and nothing else.
 *
 * Every screen is a component under components/. The router is already provided
 * (app.config.ts) with an empty route table — when there is a second screen this
 * becomes a <router-outlet>, and nothing else here has to change.
 */
@Component({
    selector: 'app-root',
    imports: [NowPlaying],
    templateUrl: './app.html',
    styleUrl: './app.scss',
})
export class App {
  showNowPlaying = signal<boolean>(false)
}
