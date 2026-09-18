import { DOCUMENT } from '@angular/common';
import {
    AfterViewInit,
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    computed,
    inject,
    input,
    signal,
    viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideChevronLeft, LucideChevronRight } from '@lucide/angular';
import { IS_PANEL } from '../../../../services/panel-client';

/*
  One horizontal row of whatever is projected into it, with a button at each end.

  It knows nothing about what it carries — Home has albums and artists to show in
  this shape, and the cards differ while the rail does not.

  THE ARROWS ARE ALWAYS THERE FOR A THUMB. They only fade in on hover where there
  is a pointer to hover with: `fine` is (hover: hover) and (pointer: fine), which
  the panel never matches. See styles.scss.

  SCROLLING IS SMOOTH EVERYWHERE BUT THE PANEL. An animated scroll is a repaint
  per frame, and on the DSI panel every one of those is a vc4 atomic commit —
  one half of the deadlock in clock-deadlock.md, which is not called closed. A
  phone's GPU does not care, so it is the device that decides, not the taste:
  `IS_PANEL`, the same token panel sleep and the on-screen keyboard use. Reduced
  motion turns it off too. The rail snaps either way, so a page still lands on a
  card edge. See decisions.md.
*/
@Component({
    selector: 'app-shelf',
    imports: [RouterLink, LucideChevronLeft, LucideChevronRight],
    templateUrl: './shelf.html',
    host: { class: 'block', '(window:resize)': 'measure()' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Shelf implements AfterViewInit {
    private readonly isPanel = inject(IS_PANEL);
    private readonly window = inject(DOCUMENT).defaultView;

    readonly heading = input.required<string>();

    /** Where the heading's link goes, if it has one. */
    readonly link = input<string | null>(null);
    readonly linkLabel = input('See all');

    private readonly rail = viewChild.required<ElementRef<HTMLElement>>('rail');

    private readonly scrollLeft = signal(0);
    private readonly scrollWidth = signal(0);
    private readonly clientWidth = signal(0);

    /** A pixel of slack: a fractional scrollWidth would otherwise never reach the end. */
    readonly canScrollLeft = computed(() => this.scrollLeft() > 1);
    readonly canScrollRight = computed(
        () => this.scrollLeft() + this.clientWidth() < this.scrollWidth() - 1,
    );

    /** Nothing to scroll: the row fits, and the buttons are not just disabled but gone. */
    readonly overflows = computed(() => this.scrollWidth() > this.clientWidth() + 1);

    ngAfterViewInit(): void {
        this.measure();
    }

    measure(): void {
        const rail = this.rail().nativeElement;
        this.scrollLeft.set(rail.scrollLeft);
        this.scrollWidth.set(rail.scrollWidth);
        this.clientWidth.set(rail.clientWidth);
    }

    /** Most of a screenful, so the card at the edge stays as a handhold. */
    scrollBy(direction: -1 | 1): void {
        const rail = this.rail().nativeElement;
        rail.scrollBy({
            left: direction * Math.round(rail.clientWidth * 0.85),
            behavior: this.behavior(),
        });
        // Instant has already landed. A smooth scroll re-measures from the scroll
        // events it emits on the way, the last of which is the one that counts.
        this.measure();
    }

    /** Animated only where a frame is cheap, and only if motion is wanted. */
    private behavior(): ScrollBehavior {
        if (this.isPanel) return 'auto';
        const reduced = this.window?.matchMedia('(prefers-reduced-motion: reduce)').matches;
        return reduced ? 'auto' : 'smooth';
    }
}
