import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SHELF_SIZE } from '../../../../services/favourite-picks';

/*
  A shelf's worth of blank cards, to stand in its rail until the real ones arrive.
  Goes inside an `app-shelf`, so the heading, its link and the arrows are already
  right and only the cards are missing.

  NOT ANIMATED. A shimmer is a repaint per frame, and on the DSI panel every one
  of those is a vc4 atomic commit — the same rule as the settings switch and the
  shelf's own instant scroll.

  The blocks take their size from the card's own classes, holding a space rather
  than carrying heights of their own, so the two cannot drift apart. The two text
  bars touch: a gap between them is height the real card does not have. See
  decisions.md.
*/
@Component({
    selector: 'app-shelf-skeleton',
    template: `
        <span class="sr-only">Loading…</span>
        @for (card of cards; track card) {
            <span class="flex w-[clamp(7rem,22vw,9.5rem)] flex-none flex-col gap-2"
                  aria-hidden="true">
                <span class="aspect-square w-full bg-surface"
                      [class.rounded-md]="!round()" [class.rounded-full]="round()"></span>
                <span class="w-full min-w-0">
                    <span class="block w-4/5 rounded-sm bg-surface text-[0.95rem]">&nbsp;</span>
                    <span class="block w-3/5 rounded-sm bg-surface text-[0.8rem]">&nbsp;</span>
                </span>
            </span>
        }
    `,
    host: { class: 'contents' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShelfSkeleton {
    readonly cards = Array.from({ length: SHELF_SIZE }, (_, i) => i);

    /** Round for a shelf of artists, as the cards there are. Sizes are unchanged. */
    readonly round = input(false);
}
