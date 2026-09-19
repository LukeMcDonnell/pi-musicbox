import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { LucideDisc3 } from '@lucide/angular';
import { CoverArt } from '../../../../components/cover-art/cover-art';
import type { AlbumIdentity } from '@musicbox/shared';

/*
  One album in a shelf: a square cover, its title and its artist. It takes the
  smallest shape that says both — a favourite is an AlbumSummary and a recently
  added album carries less, and the card wants nothing either of them lacks.

  The cover arrives already resolved, and a 404 goes back out as `failed` — the
  screen owns the set of covers that have failed, as the Favourites list does,
  because they fail independently and a card is rebuilt whenever the row changes.

  No width/height on the image: the box is fluid, so `aspect-square` is what holds
  the space open instead, as on the album screen's hero.
*/
@Component({
    selector: 'app-album-card',
    imports: [CoverArt, LucideDisc3],
    template: `
        <button type="button"
                class="flex w-[clamp(7rem,22vw,9.5rem)] flex-none snap-start cursor-pointer
                       touch-manipulation flex-col gap-2 rounded-md text-left select-none
                       active:bg-raised"
                (click)="open.emit()">
            <app-cover-art class="aspect-square w-full rounded-md bg-surface" [uri]="cover()"
                           lazy (failed)="failed.emit($event)">
                <svg lucideDisc3 class="size-8 text-muted" aria-hidden="true"></svg>
            </app-cover-art>
            <span class="w-full min-w-0">
                <span class="block truncate text-[0.95rem]">{{ album().album }}</span>
                <span class="block truncate text-[0.8rem] text-muted">{{ album().albumArtist }}</span>
            </span>
        </button>
    `,
    host: { class: 'contents' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlbumCard {
    readonly album = input.required<AlbumIdentity>();

    /** Resolved by the screen through LibraryStore, or null when there is none. */
    readonly cover = input<string | null>(null);

    /** The cover URI that 404ed. */
    readonly failed = output<string>();
    readonly open = output<void>();
}
