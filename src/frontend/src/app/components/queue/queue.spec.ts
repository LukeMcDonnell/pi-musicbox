import { TestBed } from '@angular/core/testing';
import type { Snapshot, Track } from '@musicbox/shared';
import { Queue } from './queue';
import { MusicboxApi } from '../../musicbox-api';

function track(id: number, title: string): Track {
    return { id, title, file: `x/${title}.flac`, image: null };
}

/** A snapshot carrying only what the queue reads. */
function snapshot(over: Partial<Snapshot> = {}): Snapshot {
    return {
        apiVersion: 1,
        status: 'ok',
        source: 'mpd',
        state: 'play',
        bluetooth: null,
        repeat: false,
        random: false,
        single: false,
        consume: false,
        track: null,
        elapsed: 0,
        duration: null,
        queueVersion: 7,
        queueLength: 4,
        queuePosition: 1,
        serverTime: 0,
        ...over,
    };
}

describe('Queue', () => {
    it('creates without a backend present', () => {
        // Same reason as the now-playing spec: EventSource will not connect
        // under test, and that is the state at boot before MPD is up.
        TestBed.configureTestingModule({ imports: [Queue] });
        const fixture = TestBed.createComponent(Queue);
        fixture.detectChanges();
        expect(fixture.componentInstance).toBeTruthy();
    });

    describe('split at queuePosition', () => {
        const tracks = [track(10, 'a'), track(11, 'b'), track(12, 'c'), track(13, 'd')];

        function make(over: Partial<Snapshot> = {}) {
            const api = {
                queue: () => tracks,
                snapshot: () => snapshot(over),
                hasQueue: () => true,
                resolve: (p: string) => p,
            };
            TestBed.configureTestingModule({
                imports: [Queue],
                providers: [{ provide: MusicboxApi, useValue: api }],
            });
            return TestBed.createComponent(Queue).componentInstance;
        }

        it('puts what is after the current track in Up next', () => {
            expect(make().upNext().map((t) => t.title)).toEqual(['c', 'd']);
        });

        it('lists Back to most recent first', () => {
            expect(make({ queuePosition: 3 }).backTo().map((t) => t.title)).toEqual(['c', 'b', 'a']);
        });

        it('leaves the playing track out of both lists', () => {
            const queue = make();
            const shown = [...queue.upNext(), ...queue.backTo()].map((t) => t.id);
            expect(shown).not.toContain(11);
        });

        it('treats nothing-selected as the whole queue being up next', () => {
            const queue = make({ queuePosition: null });
            expect(queue.upNext().length).toBe(4);
            expect(queue.backTo().length).toBe(0);
        });

        it('shows Up next by default', () => {
            const queue = make();
            expect(queue.rows()).toEqual(queue.upNext());
        });
    });
});
