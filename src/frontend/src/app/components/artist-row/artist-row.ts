import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { LucideUserRound } from '@lucide/angular';
import { CoverArt } from '../cover-art/cover-art';

/**
 * The height of one row, in pixels.
 *
 * The same 48px picture and `py-2` an AlbumRow has, and the same
 * `min-h-[3.5rem]` floor it beats; both text lines are `truncate` so nothing can
 * wrap a row taller. A CONSTANT THE TEMPLATE CANNOT DISAGREE WITH — every index
 * the virtual scroller computes comes from it, so the spec measures a rendered
 * row against it, as album-row's and library's do.
 */
export const ARTIST_ROW_HEIGHT = 64;

/*
  One artist in a list: a round picture, their name, and a line of text.

  NO PLAY OR QUEUE, unlike AlbumRow. `POST /api/library/{play,queue}` takes an
  album, so there is nothing an artist row could send; tapping it opens them.

  The picture is round where a cover is square — the same distinction the Library
  list draws. It arrives resolved, the second line arrives as text, and every
  press goes back out as an event.
*/
@Component({
    selector: 'app-artist-row',
    imports: [CoverArt, LucideUserRound],
    template: `
        <button class="flex min-h-[3.5rem] w-full min-w-0 cursor-pointer touch-manipulation
                       items-center gap-3 rounded-md px-0 py-2 text-left select-none
                       active:bg-raised"
                (click)="open.emit()">
            <app-cover-art class="size-12 flex-none rounded-full bg-surface" [uri]="cover()"
                           [width]="48" [height]="48" lazy (failed)="failed.emit($event)">
                <svg lucideUserRound class="size-5 text-muted" aria-hidden="true"></svg>
            </app-cover-art>
            <span class="min-w-0 flex-1 flex place-items-center">
                <span class="text-xl block truncate">{{ name() }}</span>
                <span class="ms-auto ps-3 block truncate text-[0.85rem] text-muted tabular-nums">
                    {{ detail() }}
                </span>
            </span>
        </button>
    `,
    host: { class: 'contents' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArtistRow {
    readonly name = input.required<string>();

    /** Resolved by the screen through LibraryStore, or null when there is none. */
    readonly cover = input<string | null>(null);

    /** The line on the right, e.g. "412 plays". The screen decides what it says. */
    readonly detail = input('');

    readonly open = output<void>();
    /** The picture URI that 404ed. */
    readonly failed = output<string>();
}
