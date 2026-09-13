import { TestBed } from '@angular/core/testing';
import { NowPlaying } from './now-playing';

describe('NowPlaying', () => {
    beforeEach(async () => {
        await TestBed.configureTestingModule({ imports: [NowPlaying] }).compileComponents();
    });

    it('creates without a backend present', () => {
        // EventSource will fail to connect under test; the component must still
        // render, because that is exactly the state at boot before MPD is up.
        const fixture = TestBed.createComponent(NowPlaying);
        fixture.detectChanges();
        expect(fixture.componentInstance).toBeTruthy();
    });
});
