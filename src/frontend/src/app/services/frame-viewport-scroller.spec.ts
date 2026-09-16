import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FrameViewportScroller, SCROLL_FRAMES, settle } from './frame-viewport-scroller';
import type { Frames, Landing } from './frame-viewport-scroller';
import { ScrollFrame } from './scroll-frame';

/**
 * A frame clock that only advances when told to.
 *
 * The real wait runs in requestAnimationFrame OUTSIDE the zone, so whenStable()
 * would return before a single tick — the same reason library.spec pumps frames
 * by hand. Here the clock is fake instead, so nothing in these tests is timing.
 */
function pump(over: Partial<Frames> = {}) {
    let queued: FrameRequestCallback[] = [];
    let now = 0;
    return {
        raf: (callback: FrameRequestCallback) => { queued.push(callback); return queued.length; },
        cancel: () => { queued = []; },
        now: () => now,
        maxFrames: 60,
        maxMs: 1000,
        ...over,
        /** One frame, `ms` after the last. */
        tick(ms = 16) {
            now += ms;
            const due = queued;
            queued = [];
            due.forEach((callback) => callback(now));
        },
        get pending() { return queued.length; },
    };
}

/** A real, scrollable frame in the document, `content` px tall inside. */
function realFrame(content = 5000): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'height:480px;overflow-y:auto';
    const inner = document.createElement('div');
    inner.style.height = `${content}px`;
    el.appendChild(inner);
    document.body.appendChild(el);
    return el;
}

function grow(frame: HTMLElement, height: number): void {
    (frame.firstElementChild as HTMLElement).style.height = `${height}px`;
}

/** Every scrollTop write, counted — one is the whole point. */
function writes(frame: HTMLElement): () => number {
    let count = 0;
    frame.addEventListener('scroll', () => { count += 1; });
    // scroll events are async; the count is read after a frame has passed.
    return () => count;
}

describe('settle', () => {
    let frame: HTMLElement;
    let landing: Landing | null;

    beforeEach(() => {
        frame = realFrame();
        landing = null;
    });

    afterEach(() => frame.remove());

    const record = (value: Landing) => { landing = value; };

    it('writes straight away when the frame is already tall enough', () => {
        const clock = pump();
        settle(frame, 1200, clock, record);
        // No waiting: a cached screen is at full height already, and a frame's
        // delay there is a visible jump from the top.
        expect(frame.scrollTop).toBe(1200);
        expect(landing).toBe('restored');
        expect(clock.pending).toBe(0);
    });

    it('waits for a short frame to grow, then writes once', () => {
        const clock = pump();
        grow(frame, 500);
        settle(frame, 1200, clock, record);
        expect(frame.scrollTop).toBe(0);

        for (let i = 0; i < 9; ++i) clock.tick();
        expect(frame.scrollTop).toBe(0);
        expect(landing).toBeNull();

        grow(frame, 5000);
        clock.tick();
        expect(frame.scrollTop).toBe(1200);
        expect(landing).toBe('restored');
        expect(clock.pending).toBe(0);
    });

    it('gives up at the frame budget, and lands clamped rather than at the top', () => {
        const clock = pump();
        grow(frame, 900);
        settle(frame, 1200, clock, record);
        for (let i = 0; i < 60; ++i) clock.tick();
        // 900 of content in a 480 frame can only reach 420.
        expect(frame.scrollTop).toBe(420);
        expect(landing).toBe('clamped');
    });

    it('gives up at the time budget even when frames are cheap', () => {
        const clock = pump();
        grow(frame, 500);
        settle(frame, 1200, clock, record);
        // Three frames, well inside maxFrames, but past a second of wall clock.
        clock.tick(400);
        clock.tick(400);
        expect(landing).toBeNull();
        clock.tick(400);
        expect(landing).toBe('clamped');
    });

    it('abandons on request without touching the frame', () => {
        const clock = pump();
        grow(frame, 500);
        const abort = settle(frame, 1200, clock, record);
        clock.tick();
        abort();
        expect(landing).toBe('abandoned');

        // The stale write this prevents: back to the library starts a restore,
        // a tap opens an artist, and half a second later 1200 lands on it.
        grow(frame, 5000);
        clock.tick();
        expect(frame.scrollTop).toBe(0);
    });

    it('stops when the user starts scrolling', () => {
        const clock = pump();
        grow(frame, 500);
        settle(frame, 1200, clock, record);
        frame.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(landing).toBe('interrupted');

        grow(frame, 5000);
        frame.scrollTop = 40;
        clock.tick();
        expect(frame.scrollTop).toBe(40);
    });

    it('writes once, not once a frame', async () => {
        const clock = pump();
        const counted = writes(frame);
        grow(frame, 500);
        settle(frame, 1200, clock, record);
        for (let i = 0; i < 5; ++i) clock.tick();
        grow(frame, 5000);
        clock.tick();

        await new Promise(requestAnimationFrame);
        // A loop that wrote every frame would end in the same place and cost 60
        // repaints getting there — on the panel, 60 vc4 atomic commits.
        expect(counted()).toBe(1);
    });
});

describe('FrameViewportScroller', () => {
    let frame: HTMLElement;

    function create(element: HTMLElement | null, clock: Frames) {
        TestBed.configureTestingModule({
            providers: [
                FrameViewportScroller,
                { provide: SCROLL_FRAMES, useValue: clock },
                { provide: ScrollFrame, useValue: { element: signal(element).asReadonly(), set: () => {} } },
            ],
        });
        return TestBed.inject(FrameViewportScroller);
    }

    beforeEach(() => { frame = realFrame(); });
    afterEach(() => frame.remove());

    it('reads the position off the frame, not the window', () => {
        frame.scrollTop = 300;
        expect(create(frame, pump()).getScrollPosition()).toEqual([0, 300]);
    });

    it('answers [0, 0] before App has published a frame', () => {
        expect(create(null, pump()).getScrollPosition()).toEqual([0, 0]);
    });

    it('goes to the top immediately, without a wait', () => {
        const clock = pump();
        const scroller = create(frame, clock);
        frame.scrollTop = 300;
        scroller.scrollToPosition([0, 0]);
        expect(frame.scrollTop).toBe(0);
        expect(scroller.landing()).toBe('top');
        // Every forward navigation takes this path, including a filter
        // keystroke. None of them should start a loop.
        expect(clock.pending).toBe(0);
    });

    it('says so rather than throwing when there is no frame', () => {
        const scroller = create(null, pump());
        scroller.scrollToPosition([0, 900]);
        expect(scroller.landing()).toBe('no-frame');
    });

    it('abandons a restore still waiting when the next one arrives', () => {
        const clock = pump();
        const scroller = create(frame, clock);
        grow(frame, 500);
        scroller.scrollToPosition([0, 1200]);
        clock.tick();

        scroller.scrollToPosition([0, 0]);
        expect(scroller.landing()).toBe('top');

        grow(frame, 5000);
        clock.tick();
        expect(frame.scrollTop).toBe(0);
    });
});
