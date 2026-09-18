import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { LucideDisc3, LucideListPlus, LucidePlay } from '@lucide/angular';
import type { AlbumIdentity } from '@musicbox/shared';

/**
 * The height of one row, in pixels.
 *
 * 48px of cover (`size-12`) plus `py-2` top and bottom, which beats the
 * `min-h-[3.5rem]` floor; both text lines are `truncate` so nothing can wrap a
 * row taller. A CONSTANT THE TEMPLATE CANNOT DISAGREE WITH — every index the
 * virtual scrollers compute comes from it, so the specs measure a rendered row
 * against it, as library.spec does for its own.
 */
export const ALBUM_ROW_HEIGHT = 64;

/*
  One album in a list: cover, title, a line under it, then Queue and Play.

  SHARED BY FAVOURITES AND RECENTLY ADDED, which is the point — the two screens
  draw the same row and would otherwise drift apart. The row knows nothing about
  where its albums came from: the cover arrives resolved, the second line arrives
  as text, and every press goes back out as an event.

  The buttons are siblings of the row button rather than inside it: a button
  cannot hold a button. Play's `-me-3` gives back its icon's inset so it lines up
  with the page edge.
*/
@Component({
    selector: 'app-album-row',
    imports: [LucideDisc3, LucideListPlus, LucidePlay],
    template: `
        <button class="flex min-h-[3.5rem] min-w-0 flex-1 cursor-pointer touch-manipulation items-center
                       gap-3 rounded-md px-0 py-2 text-left select-none active:bg-raised"
                (click)="open.emit()">
            <span class="grid size-12 flex-none place-items-center overflow-hidden rounded bg-surface">
                @if (cover(); as uri) {
                    <img class="h-full w-full object-cover" [src]="uri" alt=""
                         width="48" height="48" loading="lazy" decoding="async"
                         (error)="failed.emit(uri)">
                } @else {
                    <svg lucideDisc3 class="size-5 text-muted" aria-hidden="true"></svg>
                }
            </span>
            <span class="min-w-0 flex-1">
                <span class="text-xl block truncate">{{ album().album }}</span>
                <span class="block truncate text-[0.85rem] text-muted tabular-nums">{{ subtitle() }}</span>
            </span>
        </button>
        <button type="button"
                class="grid size-11 flex-none cursor-pointer touch-manipulation place-items-center
                       rounded-full text-muted select-none active:bg-raised disabled:opacity-40"
                [disabled]="busy()" [attr.aria-label]="'Add ' + album().album + ' to the queue'"
                (click)="queue.emit()">
            <svg lucideListPlus class="size-5" aria-hidden="true"></svg>
        </button>
        <button type="button"
                class="-me-3 grid size-11 flex-none cursor-pointer touch-manipulation place-items-center
                       rounded-full text-accent select-none active:bg-raised disabled:opacity-40"
                [disabled]="busy()" [attr.aria-label]="'Play ' + album().album"
                (click)="play.emit()">
            <svg lucidePlay class="size-5 fill-current" aria-hidden="true"></svg>
        </button>
    `,
    host: { class: 'contents' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlbumRow {
    readonly album = input.required<AlbumIdentity>();

    /** Resolved by the screen through LibraryStore, or null when there is none. */
    readonly cover = input<string | null>(null);

    /** The second line, e.g. "Radiohead · 1997". The screen decides what it says. */
    readonly subtitle = input('');

    /** True while a Play or Queue is in flight, so neither can be double-sent. */
    readonly busy = input(false);

    readonly open = output<void>();
    readonly play = output<void>();
    readonly queue = output<void>();
    /** The cover URI that 404ed. */
    readonly failed = output<string>();
}
