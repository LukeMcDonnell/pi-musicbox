import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { SettingsResponse } from '@musicbox/shared';
import { ApiClient } from '../../../../services/api-client';
import { MusicboxApi } from '../../../../services/musicbox-api';
import { SystemSettings } from './system-settings';

function create(minutes: number | null = 0) {
    const settings = signal<SettingsResponse | null>(
        minutes === null ? null : { panelSleepAfterMinutes: minutes },
    );
    const patchJson = jasmine
        .createSpy('patchJson')
        .and.callFake(async (_path: string, body: unknown) => {
            // The server answers with the complete set, as the routes do.
            return { ...(body as object) } as SettingsResponse;
        });

    TestBed.configureTestingModule({
        imports: [SystemSettings],
        providers: [
            { provide: MusicboxApi, useValue: { settings } },
            { provide: ApiClient, useValue: { patchJson } },
        ],
    });
    const fixture = TestBed.createComponent(SystemSettings);
    fixture.detectChanges();
    return { fixture, settings, patchJson };
}

function row(fixture: ReturnType<typeof create>['fixture']): HTMLButtonElement {
    return (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        '[aria-haspopup="listbox"]',
    )!;
}

function options(fixture: ReturnType<typeof create>['fixture']): string[] {
    return Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
            '[role="option"]',
        ),
        (option) => option.textContent!.trim(),
    );
}

describe('SystemSettings', () => {
    it('creates without a backend present', () => {
        // Before the first SSE frame there are no settings at all.
        const { fixture } = create(null);
        expect(fixture.componentInstance).toBeTruthy();
        expect(row(fixture).textContent).toContain('Never');
    });

    it('offers the same delays as the idle setting on the Interface tab', () => {
        const { fixture } = create(0);
        row(fixture).click();
        fixture.detectChanges();
        const shown = options(fixture);
        expect(shown.length).toBe(13);
        expect(shown[0]).toBe('Never');
        expect(shown[1]).toBe('1 minute');
        expect(shown[12]).toBe('20 minutes');
    });

    it('shows what the BOX says, not a local copy', () => {
        const { fixture, settings } = create(0);
        expect(row(fixture).textContent).toContain('Never');

        // Changed from a phone; it arrives here over the same stream.
        settings.set({ panelSleepAfterMinutes: 10 });
        fixture.detectChanges();
        expect(row(fixture).textContent).toContain('10 minutes');
    });

    it('PATCHes the change to the box', async () => {
        const { fixture, patchJson } = create(0);
        row(fixture).click();
        fixture.detectChanges();

        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
            '[role="option"]',
        )[5]!.click();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(patchJson).toHaveBeenCalledWith('/api/settings', { panelSleepAfterMinutes: 5 });
    });

    it('shows the new value while the request is in flight', async () => {
        // Otherwise the dropdown snaps back to the old answer for a round trip.
        let release: (value: SettingsResponse) => void = () => {};
        const { fixture, patchJson } = create(0);
        patchJson.and.returnValue(
            new Promise<SettingsResponse>((resolve) => {
                release = resolve;
            }),
        );

        row(fixture).click();
        fixture.detectChanges();
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
            '[role="option"]',
        )[2]!.click();
        fixture.detectChanges();
        expect(row(fixture).textContent).toContain('2 minutes');

        release({ panelSleepAfterMinutes: 2 });
        await fixture.whenStable();
    });

    it('reports a refusal instead of pretending it worked', async () => {
        const { fixture, patchJson } = create(0);
        patchJson.and.rejectWith(new Error('invalid value for panelSleepAfterMinutes'));

        row(fixture).click();
        fixture.detectChanges();
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
            '[role="option"]',
        )[1]!.click();
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        const alert = (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]');
        expect(alert?.textContent).toContain('invalid value');
        // And the row falls back to what the box actually says.
        expect(row(fixture).textContent).toContain('Never');
    });
});
