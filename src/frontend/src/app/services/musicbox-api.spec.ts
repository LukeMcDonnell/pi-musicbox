import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SSE_SNAPSHOT_EVENT, type CdInfo, type Snapshot } from '@musicbox/shared';
import { ApiClient } from './api-client';
import { MusicboxApi, RESUME_RECONNECT_MS } from './musicbox-api';

/** Stands in for the browser's EventSource so frames can be pushed by hand. */
class FakeEventSource {
    static readonly CLOSED = 2;
    static last: FakeEventSource | null = null;
    readyState = 1;
    closed = false;
    private readonly listeners = new Map<string, Array<(e: MessageEvent) => void>>();
    constructor() {
        FakeEventSource.last = this;
    }
    addEventListener(type: string, fn: (e: MessageEvent) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    emit(type: string, data: unknown): void {
        for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
    close(): void {
        this.closed = true;
    }
}

function snapshot(cd: CdInfo | null, elapsed = 0): Snapshot {
    return {
        apiVersion: 1, status: 'ok', source: 'cd', state: 'play', bluetooth: null, cd,
        repeat: false, random: false, single: false, consume: false, track: null,
        elapsed, duration: null, queueVersion: 5, queueLength: 2, queuePosition: 0, serverTime: 0,
    };
}

const PENDING: CdInfo = {
    tracks: 2, discId: 'abc-', lookup: 'pending', album: null, artist: null, date: null, image: null,
};

describe('MusicboxApi', () => {
    let original: typeof EventSource;
    beforeEach(() => {
        original = window.EventSource;
        (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
    });
    afterEach(() => {
        (window as unknown as { EventSource: unknown }).EventSource = original;
    });

    it('refetches the queue when a disc is looked up, though MPD\'s version has not moved', () => {
        const getJson = jasmine.createSpy('getJson').and.resolveTo({ version: 5, tracks: [] });
        TestBed.configureTestingModule({
            providers: [{ provide: ApiClient, useValue: { getJson, resolve: (p: string) => p } }],
        });
        TestBed.inject(MusicboxApi);
        const flush = () => TestBed.inject(ApplicationRef).tick();
        const source = FakeEventSource.last!;
        const queueFetches = () => getJson.calls.allArgs().filter(([path]) => path === '/api/queue').length;

        source.emit(SSE_SNAPSHOT_EVENT, snapshot(PENDING));
        flush();
        expect(queueFetches()).toBe(1);

        // Elapsed time moving is not a reason to fetch.
        source.emit(SSE_SNAPSHOT_EVENT, snapshot(PENDING, 3));
        flush();
        expect(queueFetches()).toBe(1);

        source.emit(SSE_SNAPSHOT_EVENT, snapshot({ ...PENDING, lookup: 'found', album: 'Ten' }));
        flush();
        expect(queueFetches()).toBe(2);
    });

    describe('coming back to the foreground', () => {
        let visibility: DocumentVisibilityState;
        let source: FakeEventSource;
        const setVisibility = (state: DocumentVisibilityState) => {
            visibility = state;
            document.dispatchEvent(new Event('visibilitychange'));
        };

        beforeEach(() => {
            visibility = 'visible';
            spyOnProperty(document, 'visibilityState', 'get').and.callFake(() => visibility);
            jasmine.clock().install();
            jasmine.clock().mockDate(new Date(0));
            TestBed.configureTestingModule({
                providers: [{
                    provide: ApiClient,
                    useValue: { getJson: () => Promise.resolve({ version: 0, tracks: [] }), resolve: (p: string) => p },
                }],
            });
            TestBed.inject(MusicboxApi);
            source = FakeEventSource.last!;
        });
        afterEach(() => jasmine.clock().uninstall());

        it('reconnects after a long suspend, which a phone\'s stream may not have survived', () => {
            setVisibility('hidden');
            jasmine.clock().tick(RESUME_RECONNECT_MS);
            setVisibility('visible');
            expect(source.closed).toBeTrue();
            expect(FakeEventSource.last).not.toBe(source);
        });

        it('keeps the stream across a brief glance away', () => {
            setVisibility('hidden');
            jasmine.clock().tick(RESUME_RECONNECT_MS - 1);
            setVisibility('visible');
            expect(source.closed).toBeFalse();
            expect(FakeEventSource.last).toBe(source);
        });

        it('always replaces a stream the browser has given up on', () => {
            source.readyState = FakeEventSource.CLOSED;
            setVisibility('hidden');
            setVisibility('visible');
            expect(FakeEventSource.last).not.toBe(source);
        });

        it('does nothing on the way into the background', () => {
            jasmine.clock().tick(RESUME_RECONNECT_MS * 2);
            setVisibility('hidden');
            expect(FakeEventSource.last).toBe(source);
        });
    });
});
