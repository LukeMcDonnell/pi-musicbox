import { TestBed } from '@angular/core/testing';
import { NowPlayingMini } from './now-playing-mini';

describe('NowPlayingMini', () => {
    it('creates without a backend present', () => {
        // Same reason as the now-playing spec: EventSource will not connect
        // under test, and that is the state at boot before MPD is up.
        TestBed.configureTestingModule({ imports: [NowPlayingMini] });
        const fixture = TestBed.createComponent(NowPlayingMini);
        fixture.detectChanges();
        expect(fixture.componentInstance).toBeTruthy();
    });
});
