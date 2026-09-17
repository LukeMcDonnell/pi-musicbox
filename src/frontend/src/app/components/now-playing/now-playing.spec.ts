import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MusicboxApi } from '../../services/musicbox-api';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { NowPlaying, audioFormat } from './now-playing';

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

describe('audioFormat', () => {
    it('reads MPD raw format as bits over kHz', () => {
        // The four that cover 96% of this library, measured over 200 albums.
        expect(audioFormat('44100:16:2')).toBe('16/44.1');
        expect(audioFormat('44100:24:2')).toBe('24/44.1');
        expect(audioFormat('96000:24:2')).toBe('24/96');
        expect(audioFormat('192000:24:2')).toBe('24/192');
        // A whole-number rate loses its ".0".
        expect(audioFormat('48000:16:2')).toBe('16/48');
    });

    it('names the channel count only when it is not stereo', () => {
        // One file here is 6-channel; everything else is 2.
        expect(audioFormat('88200:24:6')).toBe('24/88.2 · 6ch');
        expect(audioFormat('88200:24:2')).toBe('24/88.2');
    });

    it('leads with the encoding, which is what separates lossy from lossless', () => {
        // The case that makes the encoding worth carrying: all 556 MP3s here
        // decode to 44100:16:2, exactly as a CD rip does. Without the container
        // the two are the same badge.
        expect(audioFormat('44100:16:2', 'FLAC')).toBe('FLAC 16/44.1');
        expect(audioFormat('44100:16:2', 'MP3')).toBe('MP3 16/44.1');
        expect(audioFormat('96000:24:2', 'FLAC')).toBe('FLAC 24/96');
    });

    it('shows whichever half it has', () => {
        expect(audioFormat(undefined, 'FLAC')).toBe('FLAC');
        expect(audioFormat('96000:24:2')).toBe('24/96');
        // An unparseable format still leaves the container worth saying.
        expect(audioFormat('dsd64:2', 'DSF')).toBe('DSF');
    });

    it('is null for anything it cannot parse, rather than guessing', () => {
        // MPD emits `dsd64:2` for DSD and `*` for a component it cannot
        // determine. A badge is not worth a guess.
        expect(audioFormat('dsd64:2')).toBeNull();
        expect(audioFormat('44100:*:2')).toBeNull();
        expect(audioFormat('*')).toBeNull();
        expect(audioFormat('')).toBeNull();
        // A Bluetooth track has neither: there is no file.
        expect(audioFormat(undefined)).toBeNull();
        expect(audioFormat(undefined, undefined)).toBeNull();
    });
});
