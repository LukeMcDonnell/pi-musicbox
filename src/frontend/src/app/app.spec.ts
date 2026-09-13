import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [App],
            providers: [provideRouter(routes)],
        }).compileComponents();
    });

    it('creates without a backend present', () => {
        // EventSource will fail to connect under test; the component must still
        // render, because that is exactly the state at boot before MPD is up.
        const fixture = TestBed.createComponent(App);
        expect(fixture.componentInstance).toBeTruthy();
    });

    it('opens now-playing from the mini bar and closes it again', () => {
        const fixture = TestBed.createComponent(App);
        fixture.detectChanges();
        const root = fixture.nativeElement as HTMLElement;
        const view = root.querySelector('app-now-playing')!;

        root.querySelector<HTMLButtonElement>('[aria-label="Open now playing"]')!.click();
        fixture.detectChanges();
        expect(view.hasAttribute('inert')).toBeFalse();

        const close = Array.from(view.querySelectorAll('button')).find(
            (b) => b.textContent?.trim() === 'Close',
        );
        close!.click();
        fixture.detectChanges();
        expect(view.hasAttribute('inert')).toBeTrue();
    });
});
