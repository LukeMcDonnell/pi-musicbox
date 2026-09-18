import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { LibraryScan, LibraryState, SettingsResponse } from '@musicbox/shared';
import { ApiClient } from '../../../../services/api-client';
import { MusicboxApi } from '../../../../services/musicbox-api';
import { LibrarySettings, duration, hourLabel } from './library-settings';
import { boxSettings, libraryState } from '../../../../testing/fixtures';

function create(
    opts: {
        settings?: SettingsResponse | null;
        library?: LibraryState | null;
    } = {},
) {
    const settings = signal<SettingsResponse | null>(
        opts.settings === undefined ? boxSettings() : opts.settings,
    );
    const library = signal<LibraryState | null>(
        opts.library === undefined ? libraryState() : opts.library,
    );
    const patchJson = jasmine
        .createSpy('patchJson')
        .and.callFake(async (_path: string, body: unknown) => ({ ...(body as object) }));
    const post = jasmine.createSpy('post').and.resolveTo(undefined);
    const refreshLibrary = jasmine.createSpy('refreshLibrary').and.resolveTo(undefined);

    TestBed.configureTestingModule({
        imports: [LibrarySettings],
        providers: [
            { provide: MusicboxApi, useValue: { settings, library, refreshLibrary } },
            { provide: ApiClient, useValue: { patchJson, post } },
        ],
    });
    const fixture = TestBed.createComponent(LibrarySettings);
    fixture.detectChanges();
    return { fixture, settings, library, patchJson, post, refreshLibrary };
}

type Fixture = ReturnType<typeof create>['fixture'];

function host(fixture: Fixture): HTMLElement {
    return fixture.nativeElement as HTMLElement;
}

function text(fixture: Fixture): string {
    return host(fixture).textContent!.replace(/\s+/g, ' ');
}

function selectRow(fixture: Fixture): HTMLButtonElement {
    return host(fixture).querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
}

function switchRow(fixture: Fixture): HTMLButtonElement {
    return host(fixture).querySelector<HTMLButtonElement>('[role="switch"]')!;
}

function button(fixture: Fixture, label: string): HTMLButtonElement | undefined {
    return Array.from(host(fixture).querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.textContent!.trim() === label,
    );
}

function options(fixture: Fixture): string[] {
    return Array.from(
        host(fixture).querySelectorAll<HTMLButtonElement>('[role="option"]'),
        (o) => o.textContent!.trim(),
    );
}

/** The measured full scan on the real library: 48m40s. */
const FULL_SCAN_MS = (48 * 60 + 40) * 1000;

function scanFinished(over: Partial<LibraryScan> = {}): LibraryScan {
    const finishedAt = Date.now() - 2 * 60_000;
    return {
        startedAt: finishedAt - FULL_SCAN_MS,
        finishedAt,
        trigger: 'scheduled',
        outcome: 'completed',
        songsBefore: 37289,
        songsAfter: 37300,
        ...over,
    };
}

describe('library-settings helpers', () => {
    it('labels an hour as a person reads a clock, and -1 as never', () => {
        expect(hourLabel(-1)).toBe('Never');
        expect(hourLabel(0)).toBe('12:00 am');
        expect(hourLabel(4)).toBe('4:00 am');
        expect(hourLabel(12)).toBe('12:00 pm');
        expect(hourLabel(23)).toBe('11:00 pm');
    });

    it('states a scan length in the units a scan actually takes', () => {
        expect(duration(40 * 1000)).toBe('40s');
        expect(duration(90 * 1000)).toBe('1m 30s');
        // The measured full scan on this library.
        expect(duration((48 * 60 + 40) * 1000)).toBe('48m 40s');
        expect(duration(2 * 3600 * 1000)).toBe('2h 0m');
    });

});

describe('LibrarySettings', () => {
    it('creates without a backend present', () => {
        // Before the first SSE frame there is neither a setting nor a library.
        const { fixture } = create({ settings: null, library: null });
        expect(fixture.componentInstance).toBeTruthy();
        expect(selectRow(fixture).textContent).toContain('Never');
        expect(text(fixture)).toContain('Nothing indexed yet.');
    });

    it('asks for the library state on open, which is what re-probes the share', () => {
        const { refreshLibrary } = create();
        expect(refreshLibrary).toHaveBeenCalled();
    });

    it('offers never plus every hour of the day', () => {
        const { fixture } = create();
        selectRow(fixture).click();
        fixture.detectChanges();
        const shown = options(fixture);
        expect(shown.length).toBe(25);
        expect(shown[0]).toBe('Never');
        expect(shown[1]).toBe('12:00 am');
        expect(shown[24]).toBe('11:00 pm');
    });

    it('shows the hour the BOX says, not a local copy', () => {
        const { fixture, settings } = create();
        expect(selectRow(fixture).textContent).toContain('Never');
        settings.set(boxSettings({ libraryScanHour: 4 }));
        fixture.detectChanges();
        expect(selectRow(fixture).textContent).toContain('4:00 am');
    });

    it('PATCHes a chosen hour', async () => {
        const { fixture, patchJson } = create();
        selectRow(fixture).click();
        fixture.detectChanges();
        // Index 5 is 4:00 am: never, then midnight through three.
        host(fixture).querySelectorAll<HTMLButtonElement>('[role="option"]')[5]!.click();
        fixture.detectChanges();
        await fixture.whenStable();
        expect(patchJson).toHaveBeenCalledWith('/api/settings', { libraryScanHour: 4 });
    });

    it('reports a refused hour and falls back to what the box says', async () => {
        const { fixture, patchJson } = create();
        patchJson.and.rejectWith(new Error('invalid value for libraryScanHour'));
        selectRow(fixture).click();
        fixture.detectChanges();
        host(fixture).querySelectorAll<HTMLButtonElement>('[role="option"]')[5]!.click();
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(host(fixture).querySelector('[role="alert"]')?.textContent).toContain('invalid value');
        expect(selectRow(fixture).textContent).toContain('Never');
    });

    it('PATCHes the scan-on-boot switch', async () => {
        const { fixture, patchJson } = create();
        expect(switchRow(fixture).getAttribute('aria-checked')).toBe('false');
        switchRow(fixture).click();
        fixture.detectChanges();
        await fixture.whenStable();
        expect(patchJson).toHaveBeenCalledWith('/api/settings', { libraryScanOnBoot: true });
    });

    it('scans on request', async () => {
        const { fixture, post } = create();
        button(fixture, 'Scan now')!.click();
        fixture.detectChanges();
        await fixture.whenStable();
        expect(post).toHaveBeenCalledWith('/api/library/scan');
    });

    it('does not rescan until the ask is confirmed', async () => {
        // An hour of NFS work that cannot be cancelled deserves a second tap.
        const { fixture, post } = create();
        button(fixture, 'Full rescan')!.click();
        fixture.detectChanges();
        expect(post).not.toHaveBeenCalled();
        expect(text(fixture)).toContain('re-reads every tag');

        button(fixture, 'Confirm full rescan')!.click();
        fixture.detectChanges();
        await fixture.whenStable();
        expect(post).toHaveBeenCalledWith('/api/library/rescan');
    });

    it('abandons a rescan that is cancelled', () => {
        const { fixture, post } = create();
        button(fixture, 'Full rescan')!.click();
        fixture.detectChanges();
        button(fixture, 'Cancel')!.click();
        fixture.detectChanges();
        expect(post).not.toHaveBeenCalled();
        expect(button(fixture, 'Full rescan')).toBeDefined();
    });

    it('says so while a scan is running, and offers no way to start another', () => {
        const { fixture } = create({
            library: libraryState({
                scanning: true,
                scanStartedAt: Date.now() - 10 * 60_000,
                scanTrigger: 'manual',
            }),
        });
        expect(text(fixture)).toContain('Scanning the library…');
        expect(text(fixture)).toContain('cannot be stopped');
        expect(button(fixture, 'Scan now')!.disabled).toBe(true);
        expect(button(fixture, 'Full rescan')!.disabled).toBe(true);
    });

    it('reports a refused scan in the server\'s own words', async () => {
        const { fixture, post } = create();
        post.and.rejectWith(new Error('the music share is not reachable'));
        button(fixture, 'Scan now')!.click();
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(host(fixture).querySelector('[role="alert"]')?.textContent).toContain(
            'not reachable',
        );
    });

    it('shows the last scan with how long it took and what changed', () => {
        const { fixture } = create({ library: libraryState({ lastScan: scanFinished() }) });
        const shown = text(fixture);
        expect(shown).toContain('Last scanned');
        expect(shown).toContain('48m 40s');
        expect(shown).toContain('11 songs added');
    });

    it('does not present an interrupted scan as a success', () => {
        const { fixture } = create({
            library: libraryState({
                lastScan: scanFinished({ outcome: 'interrupted', songsAfter: 20000 }),
            }),
        });
        const shown = text(fixture);
        expect(shown).toContain('MPD restarted under it');
        expect(shown).toContain('may be incomplete');
        expect(shown).not.toContain('Last scanned');
    });

    it('says when a scan was lost rather than inventing a duration for it', () => {
        const { fixture } = create({
            library: libraryState({
                lastScan: scanFinished({ finishedAt: null, outcome: 'interrupted' }),
            }),
        });
        expect(text(fixture)).toContain('was interrupted');
    });

    it('says when the library has never been scanned', () => {
        const { fixture } = create({ library: libraryState({ lastScan: null }) });
        expect(text(fixture)).toContain('never been scanned');
    });

    it('shows what the library holds', () => {
        const { fixture } = create({
            library: libraryState({
                stats: {
                    songs: 37289,
                    albums: 2731,
                    artists: 535,
                    playtimeSeconds: 3_600_000,
                    lastUpdatedAt: 1,
                },
            }),
        });
        const shown = text(fixture);
        expect(shown).toContain('37,289 songs');
        expect(shown).toContain('2,731 albums');
        expect(shown).toContain('535 artists');
        expect(shown).toContain('1,000 hours');
    });

    it('names the music folder, and says when it cannot be reached', () => {
        const { fixture } = create();
        expect(text(fixture)).toContain('/srv/music/Music');
        expect(text(fixture)).not.toContain('not reachable');
    });

    it('calls out an unreachable share, because it explains a scan that did nothing', () => {
        const { fixture } = create({ library: libraryState({ musicRootReadable: false }) });
        expect(text(fixture)).toContain('not reachable');
    });

    it('says when the next scheduled scan is due', () => {
        const at = new Date();
        at.setHours(at.getHours() + 1, 0, 0, 0);
        const { fixture } = create({ library: libraryState({ nextScanAt: at.getTime() }) });
        expect(text(fixture)).toContain('Next scan');
    });
});
