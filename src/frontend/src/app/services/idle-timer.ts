import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, NgZone, inject } from '@angular/core';

/** What counts as someone being there. Discrete events only — see the header. */
const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * How long this browser has been left alone, and who wants to know.
 *
 * ONE SET OF LISTENERS, ONE TIMESTAMP, however many watchers there are. Two
 * features now ask the same question — raise now-playing after a while, and put
 * the panel to sleep after a while — and a second copy of the listeners would
 * double the cost of every touch for no new information.
 *
 * ONE TIMER PER WATCHER, NEVER RESCHEDULED ON ACTIVITY. An event only writes a
 * timestamp; each watcher's timeout is armed once and, if it lands early because
 * something happened after it was set, re-arms itself for the remainder.
 * Resetting a timeout on every touch would be a wakeup per event during a fling
 * down the library.
 *
 * OUTSIDE THE ANGULAR ZONE, for the same reason: these listeners fire during
 * scrolling, and inside the zone every one of them would schedule a change
 * detection pass that has nothing to check. Nothing here writes a signal; a
 * watcher that needs to is handed the zone back when it fires.
 *
 * Not `scroll`: a scroll is always started by a pointer, a touch or a wheel, and
 * those are already here.
 */
@Injectable({ providedIn: 'root' })
export class IdleTimer {
    private readonly zone = inject(NgZone);

    /** When this browser was last touched. */
    private last = Date.now();

    private readonly watchers = new Set<Watcher>();

    constructor() {
        const doc = inject(DOCUMENT);
        const onActivity = () => {
            this.last = Date.now();
            for (const watcher of this.watchers) watcher.onActivity();
        };
        this.zone.runOutsideAngular(() => {
            // Capture, so a handler that stops propagation cannot hide the user.
            for (const type of ACTIVITY) {
                doc.addEventListener(type, onActivity, { passive: true, capture: true });
            }
        });
        inject(DestroyRef).onDestroy(() => {
            for (const type of ACTIVITY) {
                doc.removeEventListener(type, onActivity, { capture: true });
            }
            for (const watcher of this.watchers) watcher.cancel();
            this.watchers.clear();
        });
    }

    /** Milliseconds since the last thing anybody did here. */
    idleFor(): number {
        return Date.now() - this.last;
    }

    /**
     * Count this moment as activity without there having been an event.
     *
     * For a watcher that has just acted and should start its delay again from
     * now — a setting changing, or a screen woken by something other than a
     * touch, such as the music starting.
     *
     * It re-arms the watchers, exactly as a real event does. Merely moving the
     * timestamp would leave a watcher that has already fired disarmed until
     * somebody touched the screen: wake the panel by starting a record and it
     * would then stay lit for ever.
     */
    poke(): void {
        this.last = Date.now();
        for (const watcher of this.watchers) watcher.onActivity();
    }

    /**
     * Call `onIdle` once `minutes` have passed with nothing happening.
     *
     * 0 minutes means never. After firing it stays quiet until the next activity
     * re-arms it, so a watcher is told once per idle period rather than
     * repeatedly. Returns a handle for changing the delay or stopping.
     */
    watch(minutes: number, onIdle: () => void): IdleWatcher {
        const watcher = new Watcher(this, this.zone, minutes, onIdle);
        this.watchers.add(watcher);
        watcher.arm();
        return {
            setMinutes: (next: number) => watcher.setMinutes(next),
            stop: () => {
                watcher.cancel();
                this.watchers.delete(watcher);
            },
        };
    }
}

export interface IdleWatcher {
    /** Change the delay. The new one runs from now, not from the old deadline. */
    setMinutes(minutes: number): void;
    stop(): void;
}

class Watcher {
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly owner: IdleTimer,
        private readonly zone: NgZone,
        private minutes: number,
        private readonly onIdle: () => void,
    ) {}

    setMinutes(minutes: number): void {
        this.minutes = minutes;
        // A change of mind is itself activity: the new delay runs from now.
        this.owner.poke();
        this.arm();
    }

    onActivity(): void {
        // Null once it has fired: the next thing anybody does starts it again.
        if (this.timer === null) this.arm();
    }

    arm(): void {
        this.cancel();
        if (this.minutes <= 0) return;
        const due = this.minutes * 60_000 - this.owner.idleFor();
        this.zone.runOutsideAngular(() => {
            this.timer = setTimeout(() => this.fire(), Math.max(0, due));
        });
    }

    private fire(): void {
        this.timer = null;
        // Something happened after the timer was set. Wait out what is left.
        if (this.owner.idleFor() < this.minutes * 60_000) {
            this.arm();
            return;
        }
        this.zone.run(() => this.onIdle());
    }

    cancel(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
    }
}
