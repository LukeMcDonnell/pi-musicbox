import { TestBed } from '@angular/core/testing';
import { PREFERENCES_KEY, Preferences } from '../../../../services/preferences';
import { InterfaceSettings } from './interface-settings';

function create() {
    TestBed.configureTestingModule({ imports: [InterfaceSettings] });
    const fixture = TestBed.createComponent(InterfaceSettings);
    fixture.detectChanges();
    return fixture;
}

function switches(fixture: ReturnType<typeof create>): HTMLButtonElement[] {
    return Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
            '[role="switch"]',
        ),
    );
}

describe('InterfaceSettings', () => {
    beforeEach(() => localStorage.removeItem(PREFERENCES_KEY));
    afterAll(() => localStorage.removeItem(PREFERENCES_KEY));

    it('offers both settings, showing the state they are actually in', () => {
        const fixture = create();
        const [nowPlaying, queue] = switches(fixture);
        expect(nowPlaying.textContent).toContain('Now Playing');
        expect(nowPlaying.getAttribute('aria-checked')).toBe('true');
        expect(queue.textContent).toContain('Playlist');
        expect(queue.getAttribute('aria-checked')).toBe('false');
    });

    it('offers the idle delay, starting from Never', () => {
        const fixture = create();
        const host = fixture.nativeElement as HTMLElement;
        const row = host.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
        expect(row.textContent).toContain('after idle');
        expect(row.textContent).toContain('Never');

        row.click();
        fixture.detectChanges();
        const options = Array.from(
            host.querySelectorAll<HTMLButtonElement>('[role="option"]'),
            (option) => option.textContent!.trim(),
        );
        expect(options.length).toBe(13);
        expect(options[0]).toBe('Never');
        expect(options[12]).toBe('20 minutes');
    });

    it('writes the chosen delay through, and closes the list', () => {
        const fixture = create();
        const host = fixture.nativeElement as HTMLElement;
        host.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.click();
        fixture.detectChanges();

        host.querySelectorAll<HTMLButtonElement>('[role="option"]')[5].click();
        fixture.detectChanges();
        expect(TestBed.inject(Preferences).openNowPlayingAfterIdle()).toBe(5);
        expect(host.querySelector('[role="listbox"]')).toBeNull();
        expect(
            host.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.textContent,
        ).toContain('5 minutes');
    });

    it('writes the preference through, so Album sees it', () => {
        const fixture = create();
        const prefs = TestBed.inject(Preferences);

        switches(fixture)[1].click();
        fixture.detectChanges();
        expect(prefs.openQueueOnAdd()).toBeTrue();
        expect(switches(fixture)[1].getAttribute('aria-checked')).toBe('true');

        switches(fixture)[0].click();
        fixture.detectChanges();
        expect(prefs.openNowPlayingOnPlay()).toBeFalse();
    });
});
