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

  THE ARROWS ARE FOR THE PANEL AND A MOUSE. A phone or tablet swipes, so a coarse
  primary pointer hides them unless this is the panel. Where they show to a mouse
  they fade in on hover: `fine` is (hover: hover) and (pointer: fine). See styles.scss.

  SCROLLING IS SMOOTH EVERYWHERE BUT THE PANEL. An animated scroll is a repaint
  per frame, and on the DSI panel every one of those is a vc4 atomic commit —
  one half of the deadlock in clock-deadlock.md, which is not called closed. A
  phone's GPU does not care, so it is the device that decides, not the taste:
  `IS_PANEL`, the same token panel sleep and the on-screen keyboard use. Reduced
  motion turns it off too. There is no CSS snap — a swipe stops where it stops —
  so the arrows pick a card edge themselves. See decisions.md.
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

    readonly showButtons =
        this.isPanel || !this.window?.matchMedia('(pointer: coarse)').matches;

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
        rail.scrollTo({ left: this.target(rail, direction), behavior: this.behavior() });
        // Instant has already landed. A smooth scroll re-measures from the scroll
        // events it emits on the way, the last of which is the one that counts.
        this.measure();
    }

    /** The card start nearest a page away, but always at least one card along. */
    private target(rail: HTMLElement, direction: -1 | 1): number {
        const from = rail.scrollLeft;
        const aim = from + direction * rail.clientWidth * 0.85;
        const origin = rail.getBoundingClientRect().left - from;
        const starts = Array.from(rail.children, (c) => c.getBoundingClientRect().left - origin)
            .filter((x) => direction * (x - from) > 1);
        if (starts.length === 0) return direction > 0 ? rail.scrollWidth : 0;
        return Math.round(
            starts.reduce((best, x) => (Math.abs(x - aim) < Math.abs(best - aim) ? x : best)),
        );
    }

    /** Animated only where a frame is cheap, and only if motion is wanted. */
    private behavior(): ScrollBehavior {
        if (this.isPanel) return 'auto';
        const reduced = this.window?.matchMedia('(prefers-reduced-motion: reduce)').matches;
        return reduced ? 'auto' : 'smooth';
    }
}
