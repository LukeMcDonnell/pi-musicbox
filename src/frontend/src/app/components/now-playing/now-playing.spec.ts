import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MusicboxApi } from '../../services/musicbox-api';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { NowPlaying } from './now-playing';

describe('NowPlaying', () => {
    it('creates without a backend present', async () => {
        // EventSource will fail to connect under test; the component must still
        // render, because that is exactly the state at boot before MPD is up.
        await TestBed.configureTestingModule({ imports: [NowPlaying] }).compileComponents();
        const fixture = TestBed.createComponent(NowPlaying);
        fixture.detectChanges();
        expect(fixture.componentInstance).toBeTruthy();
    });

    // Queue on an album, with "Open Playlist when queueing" on: the request is
    // made before the box has told us the album landed.
    it('opens on the queue only once there is a queue to open on', async () => {
        const hasQueue = signal(false);
        const api = {
            snapshot: () => null,
            stream: () => 'live',
            mpdAvailable: () => true,
            hasQueue,
            queue: () => [],
            elapsedNow: () => null,
            bluetooth: () => null,
            resolve: (path: string) => path,
        };
        TestBed.configureTestingModule({
            imports: [NowPlaying],
            providers: [{ provide: MusicboxApi, useValue: api }],
        });
        const fixture = TestBed.createComponent(NowPlaying);
        const scrolled = spyOn(fixture.componentInstance, 'scrollToQueue');
        // detectChanges runs the effect, tick() the render hook it queues.
        // Not whenStable(): the 1Hz ticker never lets this component's zone
        // settle, so awaiting it hangs the runner.
        const render = () => {
            fixture.detectChanges();
            TestBed.inject(ApplicationRef).tick();
        };
        render();

        const sheet = TestBed.inject(NowPlayingSheet);
        sheet.showQueue();
        render();
        // Scrolling now would land on an element that does not exist yet.
        expect(scrolled).not.toHaveBeenCalled();
        expect(sheet.atQueue()).withContext('still pending').toBeTrue();

        hasQueue.set(true);
        render();
        expect(scrolled).toHaveBeenCalled();
        expect(sheet.atQueue()).withContext('settled').toBeFalse();
    });

    it('does not scroll for a plain open', async () => {
        await TestBed.configureTestingModule({ imports: [NowPlaying] }).compileComponents();
        const fixture = TestBed.createComponent(NowPlaying);
        const scrolled = spyOn(fixture.componentInstance, 'scrollToQueue');
        fixture.detectChanges();

        TestBed.inject(NowPlayingSheet).show();
        fixture.detectChanges();
        TestBed.inject(ApplicationRef).tick();
        expect(scrolled).not.toHaveBeenCalled();
    });
});
