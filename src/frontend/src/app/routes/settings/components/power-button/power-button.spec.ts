import { TestBed } from '@angular/core/testing';
import { PowerButton } from './power-button';

function create() {
    TestBed.configureTestingModule({ imports: [PowerButton] });
    const fixture = TestBed.createComponent(PowerButton);
    fixture.detectChanges();
    return fixture;
}

function host(fixture: ReturnType<typeof create>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
}

function trigger(fixture: ReturnType<typeof create>): HTMLButtonElement {
    return host(fixture).querySelector<HTMLButtonElement>('button[aria-label="Power"]')!;
}

function dialog(fixture: ReturnType<typeof create>): HTMLElement | null {
    return host(fixture).querySelector('[role="dialog"]');
}

function actions(fixture: ReturnType<typeof create>): string[] {
    return Array.from(
        dialog(fixture)!.querySelectorAll('button'),
        (button) => button.textContent!.trim(),
    );
}

describe('PowerButton', () => {
    it('asks before doing anything: nothing is open until it is pressed', () => {
        const fixture = create();
        expect(dialog(fixture)).toBeNull();
        expect(trigger(fixture).getAttribute('aria-expanded')).toBe('false');
    });

    it('offers restart, shut down and a way out', () => {
        const fixture = create();
        trigger(fixture).click();
        fixture.detectChanges();
        expect(actions(fixture)).toEqual(['Restart', 'Shut down', 'Cancel']);
        expect(trigger(fixture).getAttribute('aria-expanded')).toBe('true');
    });

    // The whole point of the modal: a stray tap on the backdrop must not choose.
    it('closes on the backdrop and on Escape', () => {
        const fixture = create();
        trigger(fixture).click();
        fixture.detectChanges();
        dialog(fixture)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        fixture.detectChanges();
        expect(dialog(fixture)).withContext('a tap on the card itself').not.toBeNull();

        host(fixture).querySelector<HTMLElement>('.fixed')!.click();
        fixture.detectChanges();
        expect(dialog(fixture)).toBeNull();

        trigger(fixture).click();
        fixture.detectChanges();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        fixture.detectChanges();
        expect(dialog(fixture)).toBeNull();
    });

    it('lands focus on Cancel, never on an action', () => {
        const fixture = create();
        trigger(fixture).click();
        fixture.detectChanges();
        expect(document.activeElement!.textContent!.trim()).toBe('Cancel');
    });

    it('closes when a choice is made — there is nothing to send it to yet', () => {
        const fixture = create();
        trigger(fixture).click();
        fixture.detectChanges();
        const shutdown = Array.from(dialog(fixture)!.querySelectorAll('button'))
            .find((button) => button.textContent!.trim() === 'Shut down')!;
        shutdown.click();
        fixture.detectChanges();
        expect(dialog(fixture)).toBeNull();
        expect(document.activeElement).toBe(trigger(fixture));
    });
});
