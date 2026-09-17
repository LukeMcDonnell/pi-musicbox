import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { LibraryState } from '@musicbox/shared';
import { ApiClient } from '../../../../services/api-client';
import { MusicboxApi } from '../../../../services/musicbox-api';
import { PowerButton } from './power-button';

let post: jasmine.Spy;
let library: ReturnType<typeof signal<LibraryState | null>>;

function create() {
    post = jasmine.createSpy('post').and.resolveTo(undefined);
    // The modal warns when a scan is running: restarting abandons it.
    library = signal<LibraryState | null>(null);
    TestBed.configureTestingModule({
        imports: [PowerButton],
        providers: [
            { provide: ApiClient, useValue: { post } },
            { provide: MusicboxApi, useValue: { library } },
        ],
    });
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

/** Press one of the modal's action buttons by its label. */
function choose(fixture: ReturnType<typeof create>, label: string): void {
    Array.from(dialog(fixture)!.querySelectorAll('button'))
        .find((button) => button.textContent!.trim() === label)!
        .click();
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

    it('asks the box to shut down, and says so instead of closing', async () => {
        const fixture = create();
        trigger(fixture).click();
        fixture.detectChanges();
        choose(fixture, 'Shut down');
        await fixture.whenStable();
        fixture.detectChanges();

        expect(post).toHaveBeenCalledWith('/api/power/shutdown');
        // The modal stays: on a shutdown nothing will ever arrive to replace it,
        // and a settings screen reappearing would read as "it did not work".
        expect(dialog(fixture)!.textContent).toContain('Shutting down');
        expect(dialog(fixture)!.textContent).not.toContain('Playback stops');
    });

    it('asks the box to restart', async () => {
        const fixture = create();
        trigger(fixture).click();
        fixture.detectChanges();
        choose(fixture, 'Restart');
        await fixture.whenStable();
        fixture.detectChanges();

        expect(post).toHaveBeenCalledWith('/api/power/restart');
        expect(dialog(fixture)!.textContent).toContain('Restarting');
    });

    it('cannot be dismissed once the box is going down', async () => {
        const fixture = create();
        trigger(fixture).click();
        fixture.detectChanges();
        choose(fixture, 'Shut down');
        await fixture.whenStable();
        fixture.detectChanges();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        host(fixture).querySelector<HTMLElement>('.fixed')!.click();
        fixture.detectChanges();
        expect(dialog(fixture)).withContext('Escape and the backdrop').not.toBeNull();
    });

    it('sends the request once, however many times it is pressed', async () => {
        const fixture = create();
        trigger(fixture).click();
        fixture.detectChanges();
        choose(fixture, 'Shut down');
        choose(fixture, 'Shut down');
        await fixture.whenStable();
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('reports a box that cannot do it, and stays dismissable', async () => {
        // 503 where setup-server.sh has not installed the power units.
        const fixture = create();
        post.and.rejectWith(new Error('power control is not configured'));
        trigger(fixture).click();
        fixture.detectChanges();
        choose(fixture, 'Restart');
        await fixture.whenStable();
        fixture.detectChanges();

        expect(dialog(fixture)!.querySelector('[role="alert"]')!.textContent)
            .toContain('not configured');
        // Nothing is happening, so the way out has to come back.
        host(fixture).querySelector<HTMLElement>('.fixed')!.click();
        fixture.detectChanges();
        expect(dialog(fixture)).toBeNull();
    });
});
