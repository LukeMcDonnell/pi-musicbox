import { booleanAttribute, ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/*
  A cover, a picture, or the placeholder that stands in for one.

  THE ICON SITS UNDER THE IMAGE, not instead of it. Both children share one grid
  cell, so a picture that has arrived but has not painted shows the icon rather
  than an empty box — see the paint entry in .claude/docs/decisions.md.

  The icon arrives by content projection: the lucide import stays at the call
  site, which is what keeps this component ignorant of whether it is showing an
  album, an artist, a track or a Bluetooth source.

  The box itself is the caller's: size, rounding and background differ per site
  and the host only ever contributes the grid.

  NO `decoding="async"`, ANYWHERE. It is what stopped covers painting: the
  decode lands after the layer has rastered clean and nothing invalidates it, so
  the picture arrives and is never drawn until a scroll or a right-click forces
  a repaint. Measured, not guessed — `loading="lazy"` was the other suspect and
  was ruled out. Do not add it back; see decisions.md.
*/
@Component({
    selector: 'app-cover-art',
    template: `
        <span class="col-start-1 row-start-1"><ng-content /></span>
        @if (uri(); as src) {
            <img class="col-start-1 row-start-1 h-full w-full object-cover" [src]="src" alt=""
                 [attr.width]="width()" [attr.height]="height()"
                 [attr.loading]="lazy() ? 'lazy' : null" (error)="failed.emit(src)">
        }
    `,
    host: { class: 'grid place-items-center overflow-hidden' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CoverArt {
    /** Already resolved through MusicboxApi/LibraryStore, or null when there is none. */
    readonly uri = input<string | null>(null);

    /** Set together, and only where the box is fixed: they stop a decode moving a row. */
    readonly width = input<number | null>(null);
    readonly height = input<number | null>(null);

    /** Off-screen lists and shelves set this; the heroes and now-playing do not. */
    readonly lazy = input(false, { transform: booleanAttribute });

    /** The URI that failed, so the screen can stop asking for it. */
    readonly failed = output<string>();
}
