import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { LucideHeart } from '@lucide/angular';
import { formatRating } from '../../services/rating';

/*
  A rating: a solid red heart and a whole percentage, e.g. ♥ 85%.

  ONE COMPONENT FOR ALL FOUR PLACES that show a rating — both heroes and both
  lists — so the glyph, the colour, the gap and the rounding cannot drift apart.

  A LUCIDE SVG AND NOT THE ❤ CHARACTER. The panel has no emoji font at all
  (`fc-list` finds none: DejaVu, Lato, FontAwesome and nothing else), so an
  emoji heart renders as tofu on the one screen that matters. Lucide is already
  bundled and is what every other icon here uses.

  RED, NOT ACCENT, and that is a rule rather than a taste: everything
  accent-coloured in this app is tappable, and a rating is not.

  TAKES A NUMBER, NOT A NULLABLE ONE. Callers must decide for themselves what to
  do when there is no rating — 61 of 506 artists and 449 of 3,062 albums have
  none, and in a list the surrounding separator has to disappear with it, which
  only the caller can do.
*/
@Component({
    selector: 'app-rating',
    imports: [LucideHeart],
    template: `
        <svg lucideHeart class="size-[0.85em] flex-none fill-current text-rating"
             aria-hidden="true"></svg>
        <span aria-hidden="true">{{ label() }}</span>
    `,
    host: {
        // inline-flex so it sits on a text line; the em-sized icon then tracks
        // whatever font size the line is set in, which is 0.85rem in the lists
        // and larger in the heroes.
        class: 'inline-flex items-center gap-1 align-middle tabular-nums',
        role: 'img',
        '[attr.aria-label]': 'aria()',
    },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Rating {
    /** The mark out of ten, as the `.nfo` files carry it. */
    readonly rating = input.required<number>();

    readonly label = computed(() => formatRating(this.rating()) ?? '');

    /**
     * "Rated 85%".
     *
     * The heart and the number are both aria-hidden under one role="img": a
     * screen reader reading "85%" off the end of "23 tracks · 1997" has no way
     * to know what the number is of.
     */
    readonly aria = computed(() => `Rated ${this.label()}`);
}
