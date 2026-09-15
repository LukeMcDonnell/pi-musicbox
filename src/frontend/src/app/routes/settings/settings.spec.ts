import { TestBed } from '@angular/core/testing';
import { Settings } from './settings';

function create() {
    TestBed.configureTestingModule({ imports: [Settings] });
    const fixture = TestBed.createComponent(Settings);
    fixture.detectChanges();
    return fixture;
}

function tabs(fixture: ReturnType<typeof create>): HTMLButtonElement[] {
    return Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
}

function panelText(fixture: ReturnType<typeof create>): string {
    return (fixture.nativeElement as HTMLElement)
        .querySelector('[role="tabpanel"]')!
        .textContent!.trim();
}

describe('Settings', () => {
    it('offers the three sections, Interface first', () => {
        const fixture = create();
        expect(tabs(fixture).map((tab) => tab.textContent!.trim()))
            .toEqual(['Interface', 'Library', 'System']);
        expect(tabs(fixture)[0].getAttribute('aria-selected')).toBe('true');
        expect(panelText(fixture)).toContain('Interface');
    });

    it('shows the chosen section, and only that one', () => {
        const fixture = create();
        tabs(fixture)[2].click();
        fixture.detectChanges();
        expect(panelText(fixture)).toContain('System');
        expect(panelText(fixture)).not.toContain('Interface');
        expect(tabs(fixture)[2].getAttribute('aria-selected')).toBe('true');
        expect(tabs(fixture)[0].getAttribute('aria-selected')).toBe('false');
    });

    // Roving tabindex: one stop for the whole tablist, arrows to move within it.
    it('moves between tabs with the arrow keys, wrapping at the ends', () => {
        const fixture = create();
        const list = (fixture.nativeElement as HTMLElement).querySelector('[role="tablist"]')!;
        list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        fixture.detectChanges();
        expect(fixture.componentInstance.active()).toBe('system');
        expect(tabs(fixture)[2].tabIndex).toBe(0);
        expect(tabs(fixture)[0].tabIndex).toBe(-1);

        list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        fixture.detectChanges();
        expect(fixture.componentInstance.active()).toBe('interface');
    });

    it('carries the power control, not a bare heading', () => {
        const fixture = create();
        const host = fixture.nativeElement as HTMLElement;
        expect(host.querySelector('button[aria-label="Power"]')).toBeTruthy();
        expect(host.querySelector('h1')!.textContent!.trim()).toBe('Settings');
    });
});
