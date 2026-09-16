import { ViewportScroller } from '@angular/common';
import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';

import { routes } from './app.routes';
import { FrameViewportScroller } from './services/frame-viewport-scroller';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    // Query parameters arrive as component inputs — see app.routes.ts for why
    // artist and album identity travels that way.
    //
    // These two lines are one feature and neither works alone: the option asks
    // the router to put a screen back where it was left on back or forward, and
    // the provider is what makes that reach <main> instead of the window, which
    // does not scroll. Removing either leaves the other doing nothing, quietly.
    provideRouter(routes, withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled' })),
    { provide: ViewportScroller, useClass: FrameViewportScroller }
  ]
};
