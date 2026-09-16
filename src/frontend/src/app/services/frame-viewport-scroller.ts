/**
 * The router's scroller, pointed at <main> instead of the window.
 *
 * ANGULAR'S OWN RESTORATION IS INERT HERE, SILENTLY. `withInMemoryScrolling`
 * remembers a position per history entry and replays it on back or forward, all
 * of which is right — but it replays it through `ViewportScroller`, and the
 * stock one calls `window.scrollTo` against a window that never scrolls. This
 * page scrolls in <main>; app.html says why. So the bookkeeping stays Angular's
 * and only the element changes.
 *
 * NAVIGATION END IS TOO EARLY TO WRITE A SCROLL POSITION, on every screen, for
 * two unrelated reasons: artist, album and settings are still fetching their
 * content, and the library's virtual scroller sizes its spacer in its own
 * requestAnimationFrame, outside the zone. Writing 1200 into a frame that can
 * only reach 40 leaves 40 and throws nothing. Hence `settle`, which waits for
 * the frame to be tall enough to hold the target and gives up out loud.
 *
 * `landing()` is that "out loud": every path through here names its outcome, so
 * a restore that quietly did nothing is something a test and a console can see.
 */

import { DOCUMENT, ViewportScroller } from '@angular/common';
import { Injectable, InjectionToken, NgZone, inject, signal } from '@angular/core';
import { ScrollFrame } from './scroll-frame';

export type Landing = 'top' | 'restored' | 'clamped' | 'interrupted' | 'abandoned' | 'no-frame';

/** The frame clock, so the wait can be tested without real frames. */
export interface Frames {
    raf(callback: FrameRequestCallback): number;
    cancel(handle: number): void;
    now(): number;
    maxFrames: number;
    maxMs: number;
}

/**
 * 60 frames or a second, whichever ends first.
 *
 * BOTH NUMBERS ARE GUESSES, not measurements — what would replace them is an
 * artist page's cold-cache round trip timed on the Pi. They are affordable
 * because the wait costs one `scrollHeight` read per frame and only ever runs
 * on a real restore, and because a touch or a wheel ends it immediately.
 */
export const REAL_FRAMES: Frames = {
    raf: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
    now: () => performance.now(),
    maxFrames: 60,
    maxMs: 1000,
};

export const SCROLL_FRAMES = new InjectionToken<Frames>('SCROLL_FRAMES', {
    providedIn: 'root',
    factory: () => REAL_FRAMES,
});

@Injectable()
export class FrameViewportScroller extends ViewportScroller {
    private readonly frame = inject(ScrollFrame).element;
    private readonly zone = inject(NgZone);
    private readonly frames = inject(SCROLL_FRAMES);
    private readonly window = inject(DOCUMENT).defaultView;

    private readonly _landing = signal<Landing | null>(null);

    /** What the last scroll this was asked for actually did. */
    readonly landing = this._landing.asReadonly();

    private offset: () => [number, number] = () => [0, 0];

    private abort: (() => void) | null = null;

    getScrollPosition(): [number, number] {
        const frame = this.frame();
        return frame ? [frame.scrollLeft, frame.scrollTop] : [0, 0];
    }

    scrollToPosition([, y]: [number, number]): void {
        // Whatever we were waiting for belongs to the screen we just left. Left
        // running, it writes a stale position onto this one half a second later.
        this.abort?.();
        const frame = this.frame();
        if (!frame) {
            this._landing.set('no-frame');
            return;
        }
        if (y <= 0) {
            frame.scrollTop = 0;
            this._landing.set('top');
            return;
        }
        // Outside the zone: the virtual scroller's own scroll handler runs there
        // too, and 60 frames of change detection is the opposite of what the
        // panel needs.
        this.zone.runOutsideAngular(() => {
            this.abort = settle(frame, y, this.frames, (landing) => {
                this.abort = null;
                this._landing.set(landing);
            });
        });
    }

    /** Unused: `anchorScrolling` stays disabled. Implemented, not left to throw. */
    scrollToAnchor(anchor: string): void {
        const frame = this.frame();
        const escaped = CSS.escape(anchor);
        const target = frame?.querySelector(`#${escaped}, [name="${escaped}"]`);
        if (!frame || !target) return;
        target.scrollIntoView({ block: 'start' });
        frame.scrollTop -= this.offset()[1];
    }

    setOffset(offset: [number, number] | (() => [number, number])): void {
        this.offset = typeof offset === 'function' ? offset : () => offset;
    }

    /** Inert — nothing here reads window scroll — but it is what the router asks for. */
    setHistoryScrollRestoration(mode: 'auto' | 'manual'): void {
        try {
            if (this.window) this.window.history.scrollRestoration = mode;
        } catch {
            // A sandboxed iframe refuses. Nothing depends on it.
        }
    }
}

/**
 * Put `frame` at `target` once it is tall enough to hold it. Returns an abort.
 *
 * One read and at most one write: a loop that writes every frame ends in the
 * same place and costs 60 repaints getting there, which on the DSI panel is 60
 * vc4 atomic commits. See .claude/docs/clock-deadlock.md.
 *
 * Interruption is a touch or a wheel, deliberately not "did scrollTop change" —
 * the virtual scroller writes scrollTop itself when its content grows, which
 * would abandon every restore of the one list this matters most for.
 */
export function settle(
    frame: HTMLElement,
    target: number,
    frames: Frames,
    done: (landing: Landing) => void,
): () => void {
    const started = frames.now();
    let handle = 0;
    let count = 0;
    let finished = false;

    const stop = (landing: Landing) => {
        if (finished) return;
        finished = true;
        frames.cancel(handle);
        frame.removeEventListener('pointerdown', interrupt);
        frame.removeEventListener('wheel', interrupt);
        done(landing);
    };
    const interrupt = () => stop('interrupted');

    // Out of budget, land anyway: a clamped position beats the top of the list.
    const land = () => {
        frame.scrollTop = target;
        stop(Math.abs(frame.scrollTop - target) <= 1 ? 'restored' : 'clamped');
    };

    const tick = () => {
        if (finished) return;
        if (frame.scrollHeight - frame.clientHeight >= target) return land();
        if (++count >= frames.maxFrames || frames.now() - started >= frames.maxMs) return land();
        handle = frames.raf(tick);
    };

    frame.addEventListener('pointerdown', interrupt, { passive: true });
    frame.addEventListener('wheel', interrupt, { passive: true });
    // Synchronously: a cached screen is already tall enough, and a frame's delay
    // there is a visible jump from the top.
    tick();

    return () => stop('abandoned');
}
