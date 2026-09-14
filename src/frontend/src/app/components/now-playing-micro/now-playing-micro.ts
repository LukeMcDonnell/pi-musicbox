import { Component, computed, inject, signal } from '@angular/core';
import { LucideBluetooth, LucideMusic } from '@lucide/angular';
import { MusicboxApi } from '../../musicbox-api';
import { NowPlayingSheet } from '../../now-playing-sheet';

/*
  The micro now-playing: only the album art, carried in the menu on short
  screens in place of the mini bar. Tapping it opens the full now-playing view.

  Which of the two is showing is decided by the `short` variant in styles.scss;
  this component is always mounted and the menu hides it. There are no controls
  and no title here — on a 480px panel the bar's 70px were worth more to the page
  than play/pause one tap closer.

  It opens the sheet through NowPlayingSheet directly rather than emitting, as
  the mini bar does: it lives inside Menu, and threading an output up through a
  component that has no other interest in it buys nothing.

  The art fallbacks mirror now-playing.ts; see the comments there for why each
  one is the shape it is.
*/
@Component({
    selector: 'app-now-playing-micro',
    imports: [LucideBluetooth, LucideMusic],
    template: `
      <button class="flex h-full w-full cursor-pointer touch-manipulation items-center justify-center
                     py-2 select-none active:bg-raised max-[46rem]:py-1"
              (click)="sheet.show()" aria-label="Open now playing">
        <!-- Fixed box, so a cover arriving or failing never changes the menu's layout. -->
        <span class="grid size-[60px] flex-none place-items-center overflow-hidden rounded bg-raised
                     max-[46rem]:size-10">
          @if (artUri(); as uri) {
            <img class="h-full w-full object-cover" [src]="uri" alt=""
                 width="60" height="60" decoding="async" (error)="onArtError(uri)">
          } @else if (onBluetooth()) {
            <svg lucideBluetooth class="size-6 text-muted max-[46rem]:size-5" aria-hidden="true"></svg>
          } @else {
            <svg lucideMusic class="size-6 text-muted max-[46rem]:size-5" aria-hidden="true"></svg>
          }
        </span>
      </button>
    `,
})
export class NowPlayingMicro {
    private readonly api = inject(MusicboxApi);
    protected readonly sheet = inject(NowPlayingSheet);

    private readonly track = computed(() => this.api.snapshot()?.track ?? null);
    readonly onBluetooth = computed(() => this.api.snapshot()?.source === 'bluetooth');

    private readonly artFailed = signal<string | null>(null);

    readonly artUri = computed(() => {
        const image = this.track()?.image ?? null;
        if (!image) return null;
        const resolved = this.api.resolve(image);
        return resolved === this.artFailed() ? null : resolved;
    });

    onArtError(uri: string): void {
        this.artFailed.set(uri);
    }
}
