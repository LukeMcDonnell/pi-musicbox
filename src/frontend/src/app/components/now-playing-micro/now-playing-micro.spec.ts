import { TestBed } from '@angular/core/testing';
import { NowPlayingMicro } from './now-playing-micro';

describe('NowPlayingMicro', () => {
    it('creates without a backend present', () => {
        // Same reason as the now-playing spec: EventSource will not connect
        // under test, and that is the state at boot before MPD is up.
        TestBed.configureTestingModule({ imports: [NowPlayingMicro] });
        const fixture = TestBed.createComponent(NowPlayingMicro);
        fixture.detectChanges();
        expect(fixture.componentInstance).toBeTruthy();
    });
});
