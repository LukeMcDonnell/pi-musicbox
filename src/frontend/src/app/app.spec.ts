import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
    beforeEach(async () => {
        await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
    });

    it('creates without a backend present', () => {
        // EventSource will fail to connect under test; the component must still
        // render, because that is exactly the state at boot before MPD is up.
        const fixture = TestBed.createComponent(App);
        expect(fixture.componentInstance).toBeTruthy();
    });
});
