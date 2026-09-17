import { TestBed } from '@angular/core/testing';
import { IdleTimer } from './idle-timer';

const MINUTE = 60_000;

/** Someone touching the screen. Capture-phase, so the target does not matter. */
function activity(): void {
    document.dispatchEvent(new Event('pointerdown'));
}

describe('IdleTimer', () => {
    beforeEach(() => {
        jasmine.clock().install();
        jasmine.clock().mockDate(new Date(0));
        TestBed.resetTestingModule();
    });
    afterEach(() => {
        // Destroy first: the listeners come off with the injector.
        TestBed.resetTestingModule();
        jasmine.clock().uninstall();
    });

    it('restart waits a whole delay again, however long it has been idle', () => {
        const idle = TestBed.inject(IdleTimer);
        let fired = 0;
        const watcher = idle.watch(1, () => fired++);

        jasmine.clock().tick(10 * MINUTE);
        expect(fired).toBe(1);

        watcher.restart();
        jasmine.clock().tick(MINUTE - 1);
        expect(fired).withContext('not from the shared clock, which is long past').toBe(1);
        jasmine.clock().tick(1);
        expect(fired).toBe(2);
    });

    it('restart leaves the other watchers where they were', () => {
        // This is the whole reason restart() exists rather than poke(): poke
        // moves the shared timestamp, which would push every other watcher out.
        const idle = TestBed.inject(IdleTimer);
        let mine = 0;
        let theirs = 0;
        const watcher = idle.watch(1, () => mine++);
        idle.watch(2, () => theirs++);

        jasmine.clock().tick(MINUTE);
        expect(mine).toBe(1);
        watcher.restart();

        jasmine.clock().tick(MINUTE);
        expect(theirs).withContext('still due two minutes in').toBe(1);
        expect(mine).toBe(2);
    });

    it('restart before the deadline pushes it out', () => {
        const idle = TestBed.inject(IdleTimer);
        let fired = 0;
        const watcher = idle.watch(1, () => fired++);

        jasmine.clock().tick(50_000);
        watcher.restart();
        jasmine.clock().tick(10_001);
        expect(fired).withContext('a minute since the start, not since the restart').toBe(0);
        jasmine.clock().tick(50_000);
        expect(fired).toBe(1);
    });

    it('a touch after a restart is still what the deadline runs from', () => {
        const idle = TestBed.inject(IdleTimer);
        let fired = 0;
        const watcher = idle.watch(1, () => fired++);

        watcher.restart();
        jasmine.clock().tick(30_000);
        activity();
        jasmine.clock().tick(30_001);
        expect(fired).withContext('only 30s since that touch').toBe(0);
        jasmine.clock().tick(30_000);
        expect(fired).toBe(1);
    });

    it('Never means never, restart or no restart', () => {
        const idle = TestBed.inject(IdleTimer);
        let fired = 0;
        const watcher = idle.watch(0, () => fired++);

        watcher.restart();
        jasmine.clock().tick(60 * MINUTE);
        expect(fired).toBe(0);
    });
});
