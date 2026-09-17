import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { PlaybackState, SettingsResponse, Snapshot } from '@musicbox/shared';
import { ApiClient, ApiError } from './api-client';
import { IS_PANEL } from './panel-client';
import { MusicboxApi } from './musicbox-api';
import { PanelSleep } from './panel-sleep';
import { boxSettings } from '../testing/fixtures';

const MINUTE = 60_000;

function snapshot(state: PlaybackState): Snapshot {
    return {
        apiVersion: 1,
        status: 'ok',
        source: 'mpd',
        state,
        bluetooth: null,
        repeat: false,
        random: false,
        single: false,
        consume: false,
        track: null,
        elapsed: 0,
        duration: null,
        queueVersion: 1,
        queueLength: 0,
        queuePosition: null,
        serverTime: 0,
    };
}

function setup(opts: { isPanel?: boolean; minutes?: number; state?: PlaybackState } = {}) {
    const settings = signal<SettingsResponse | null>(
        boxSettings({ panelSleepAfterMinutes: opts.minutes ?? 1 }),
    );
    const snap = signal<Snapshot | null>(snapshot(opts.state ?? 'pause'));
    const post = jasmine.createSpy('post').and.resolveTo(undefined);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            { provide: MusicboxApi, useValue: { settings, snapshot: snap } },
            { provide: ApiClient, useValue: { post } },
            { provide: IS_PANEL, useValue: opts.isPanel ?? true },
        ],
    });
    const sleep = TestBed.inject(PanelSleep);
    TestBed.tick();
    return { sleep, settings, snapshot: snap, post };
}

/** The backlight states asked for, in order. */
function asked(post: jasmine.Spy): boolean[] {
    return post.calls.allArgs().map(([, body]) => (body as { on: boolean }).on);
}

/** Let the awaited post() settle without advancing the mock clock. */
const flush = () => Promise.resolve().then(() => undefined);

function touch(): void {
    document.dispatchEvent(new Event('pointerdown'));
}

describe('PanelSleep', () => {
    beforeEach(() => {
        jasmine.clock().install();
        jasmine.clock().mockDate(new Date(0));
    });
    afterEach(() => {
        TestBed.resetTestingModule();
        jasmine.clock().uninstall();
    });

    it('does nothing at all on a phone — this is the panel own screen', async () => {
        const { post, sleep } = setup({ isPanel: false, minutes: 1 });
        jasmine.clock().tick(10 * MINUTE);
        await flush();
        expect(post).not.toHaveBeenCalled();
        expect(sleep.asleep()).toBeFalse();
    });

    it('turns the backlight off after the delay when nothing is playing', async () => {
        const { post, sleep } = setup({ minutes: 1, state: 'pause' });
        jasmine.clock().tick(MINUTE - 1);
        expect(post).withContext('a moment early').not.toHaveBeenCalled();

        jasmine.clock().tick(1);
        await flush();
        expect(post).toHaveBeenCalledWith('/api/panel/backlight', { on: false });
        expect(sleep.asleep()).toBeTrue();
    });

    it('never sleeps while something is playing, whatever the source', async () => {
        // state === 'play' is the source-independent answer, so a phone playing
        // over Bluetooth keeps the screen awake with no special case.
        const { post, sleep } = setup({ minutes: 1, state: 'play' });
        jasmine.clock().tick(30 * MINUTE);
        await flush();
        expect(post).not.toHaveBeenCalled();
        expect(sleep.asleep()).toBeFalse();
    });

    it('Never means never', async () => {
        const { post } = setup({ minutes: 0 });
        jasmine.clock().tick(60 * MINUTE);
        await flush();
        expect(post).not.toHaveBeenCalled();
    });

    it('counts the idle period from the last touch on the panel', async () => {
        const { post } = setup({ minutes: 1 });
        jasmine.clock().tick(50_000);
        touch();
        jasmine.clock().tick(50_000);
        await flush();
        expect(post).withContext('only 50s since that touch').not.toHaveBeenCalled();

        jasmine.clock().tick(10_000);
        await flush();
        expect(asked(post)).toEqual([false]);
    });

    it('wakes on a touch, and says so before the request lands', async () => {
        const { post, sleep } = setup({ minutes: 1 });
        jasmine.clock().tick(MINUTE);
        await flush();
        expect(sleep.asleep()).toBeTrue();

        sleep.wake();
        // Set immediately: the overlay has to come off on the touch itself, not
        // a round trip later.
        expect(sleep.asleep()).toBeFalse();
        await flush();
        expect(asked(post)).toEqual([false, true]);
    });

    it('wakes when playback starts', async () => {
        const { post, sleep, snapshot: snap } = setup({ minutes: 1, state: 'pause' });
        jasmine.clock().tick(MINUTE);
        await flush();
        expect(sleep.asleep()).toBeTrue();

        // Started from a phone while the panel sat dark.
        snap.set(snapshot('play'));
        TestBed.tick();
        await flush();
        expect(asked(post)).toEqual([false, true]);
        expect(sleep.asleep()).toBeFalse();
    });

    it('sleeps again after being woken', async () => {
        const { post, sleep } = setup({ minutes: 1 });
        jasmine.clock().tick(MINUTE);
        await flush();
        sleep.wake();
        await flush();

        jasmine.clock().tick(MINUTE);
        await flush();
        expect(asked(post)).toEqual([false, true, false]);
    });

    it('takes a new delay from the box without waiting out the old one', async () => {
        const { post, settings } = setup({ minutes: 20 });
        jasmine.clock().tick(5 * MINUTE);
        settings.set(boxSettings({ panelSleepAfterMinutes: 1 }));
        TestBed.tick();

        jasmine.clock().tick(MINUTE);
        await flush();
        expect(asked(post)).toEqual([false]);
    });

    it('stops when the box is set back to Never', async () => {
        const { post, settings } = setup({ minutes: 1 });
        settings.set(boxSettings({ panelSleepAfterMinutes: 0 }));
        TestBed.tick();
        jasmine.clock().tick(60 * MINUTE);
        await flush();
        expect(post).not.toHaveBeenCalled();
    });

    it('does not believe the screen is dark when the box refused', async () => {
        // 409 with no panel stream, or 503 on a box with no backlight. An overlay
        // over a working UI would swallow the next tap for nothing.
        const { post, sleep } = setup({ minutes: 1 });
        post.and.rejectWith(new Error('no panel client is connected'));
        jasmine.clock().tick(MINUTE);
        await flush();
        await flush();
        expect(sleep.asleep()).toBeFalse();
    });

    it('a touch during the sleep request still wakes the screen', async () => {
        // The bug this guards: an in-flight guard that DROPS the wake leaves a
        // dark panel that no further touch can fix, because every later touch
        // finds the page already awake and sends nothing.
        let release: () => void = () => {};
        const { post, sleep } = setup({ minutes: 1 });
        post.and.returnValue(
            new Promise<void>((resolve) => {
                release = resolve;
            }),
        );

        jasmine.clock().tick(MINUTE);
        await flush();
        expect(sleep.asleep()).toBeTrue();

        sleep.wake(); // while the sleep POST is still in flight
        release();
        await flush();
        await flush();

        expect(asked(post)).toEqual([false, true]);
        expect(sleep.asleep()).toBeFalse();
    });
    it('sleeps a delay after a record ends, with nobody touching the panel', async () => {
        // The reported fault: the deadline passes DURING the album, sleep() is
        // refused because something is playing, and nothing armed the timer
        // again — so the screen stayed lit for the rest of the uptime.
        const { post, sleep, snapshot: snap } = setup({ minutes: 1, state: 'play' });
        jasmine.clock().tick(30 * MINUTE);
        await flush();
        expect(post).withContext('not while it plays').not.toHaveBeenCalled();

        snap.set(snapshot('stop'));
        TestBed.tick();
        jasmine.clock().tick(MINUTE - 1);
        await flush();
        expect(post).withContext('the record only just ended').not.toHaveBeenCalled();

        jasmine.clock().tick(1);
        await flush();
        expect(asked(post)).toEqual([false]);
        expect(sleep.asleep()).toBeTrue();
    });

    it('counts the delay from the end of the record, not the last touch', async () => {
        const { post, snapshot: snap } = setup({ minutes: 1, state: 'play' });
        jasmine.clock().tick(50_000);
        snap.set(snapshot('pause'));
        TestBed.tick();

        jasmine.clock().tick(10_001);
        await flush();
        expect(post).withContext('a minute since the start, not since the pause').not.toHaveBeenCalled();

        jasmine.clock().tick(50_000);
        await flush();
        expect(asked(post)).toEqual([false]);
    });

    it('retries a refused sleep a delay later rather than giving up', async () => {
        const { post, sleep } = setup({ minutes: 1 });
        post.and.rejectWith(new ApiError('no panel client is connected', 409));
        jasmine.clock().tick(MINUTE);
        await flush();
        await flush();
        expect(asked(post)).toEqual([false]);

        jasmine.clock().tick(MINUTE - 1);
        await flush();
        expect(asked(post)).withContext('one attempt per delay, not a spin').toEqual([false]);

        post.and.resolveTo(undefined);
        jasmine.clock().tick(1);
        await flush();
        expect(asked(post)).toEqual([false, false]);
        expect(sleep.asleep()).toBeTrue();
    });

    it('stops asking a box that has no backlight at all', async () => {
        const { post } = setup({ minutes: 1 });
        post.and.rejectWith(new ApiError('this box has no panel backlight', 503));
        for (let i = 0; i < 10; i++) {
            jasmine.clock().tick(MINUTE);
            await flush();
            await flush();
        }
        expect(asked(post)).withContext('503 will not change').toEqual([false]);
    });
});
