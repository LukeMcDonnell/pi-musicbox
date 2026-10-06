import { signal } from '@angular/core';
import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import type { LibraryState, SystemStatus, ThumbnailStatus } from '@musicbox/shared';
import { ApiClient } from '../../../../services/api-client';
import { MusicboxApi } from '../../../../services/musicbox-api';
import { libraryState } from '../../../../testing/fixtures';
import {
    STATUS_POLL_MS,
    StatusSettings,
    thumbnailLabel,
    uptimeLabel,
    usageLabel,
} from './status-settings';

const GB = 1024 ** 3;

const NEVER: ThumbnailStatus = {
    state: 'never', scope: null, progress: null, total: null,
    startedAt: null, finishedAt: null, built: null, failed: null,
};

function systemStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
    return {
        uptimeSeconds: 3 * 86_400 + 4 * 3600,
        cpuPercent: 12,
        load: [0.4, 0.3, 0.2],
        memory: { usedBytes: 0.7 * GB, totalBytes: 3.7 * GB },
        disk: { usedBytes: 5.8 * GB, totalBytes: 29 * GB },
        temperatures: [{ name: 'cpu-thermal', celsius: 52.1 }],
        underVoltage: false,
        thumbnails: NEVER,
        ...overrides,
    };
}

function create(opts: { status?: SystemStatus; library?: LibraryState | null; fail?: boolean } = {}) {
    const library = signal<LibraryState | null>(opts.library === undefined ? libraryState() : opts.library);
    const getJson = opts.fail
        ? jasmine.createSpy('getJson').and.rejectWith(new Error('offline'))
        : jasmine.createSpy('getJson').and.resolveTo(opts.status ?? systemStatus());
    TestBed.configureTestingModule({
        imports: [StatusSettings],
        providers: [
            { provide: MusicboxApi, useValue: { library } },
            { provide: ApiClient, useValue: { getJson } },
        ],
    });
    const fixture = TestBed.createComponent(StatusSettings);
    return { fixture, getJson, library };
}

type Fixture = ReturnType<typeof create>['fixture'];

function text(fixture: Fixture): string {
    return (fixture.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ');
}

/** The value beside a <dt>. */
function row(fixture: Fixture, label: string): HTMLElement | undefined {
    const dt = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('dt')).find(
        (d) => d.textContent!.trim() === label,
    );
    return dt?.nextElementSibling as HTMLElement | undefined;
}

describe('status labels', () => {
    it('says uptime in the two largest units', () => {
        expect(uptimeLabel(3 * 86_400 + 4 * 3600 + 59)).toBe('3d 4h');
        expect(uptimeLabel(4 * 3600 + 12 * 60)).toBe('4h 12m');
        expect(uptimeLabel(59)).toBe('0m');
    });

    it('says usage in one unit, as df does', () => {
        expect(usageLabel({ usedBytes: 5.8 * GB, totalBytes: 29 * GB })).toBe('5.8 of 29 GB (20%)');
        expect(usageLabel({ usedBytes: 0.7 * GB, totalBytes: 3.7 * GB })).toBe('0.7 of 3.7 GB (19%)');
        expect(usageLabel({ usedBytes: 100 * 1024 ** 2, totalBytes: 512 * 1024 ** 2 })).toBe('100 of 512 MB (20%)');
    });

    it('says what the thumbnail helper is doing', () => {
        const now = Date.now();
        expect(thumbnailLabel({ ...NEVER, state: 'running', scope: 'library', progress: 1240, total: 3812 }, now))
            .toBe(`Building — ${(1240).toLocaleString()} of ${(3812).toLocaleString()} covers checked`);
        expect(thumbnailLabel({ ...NEVER, state: 'done', scope: 'library', finishedAt: now, built: 12, failed: 1 }, now))
            .toBe('Covers last built just now — 12 new, 1 failed.');
        expect(thumbnailLabel({ ...NEVER, state: 'done', finishedAt: now }, now)).toBe('Covers last built just now.');
        expect(thumbnailLabel(NEVER, now)).toBe('Not built yet.');
        expect(thumbnailLabel({ ...NEVER, state: 'interrupted' }, now)).toContain('stopped part way');
    });
});

describe('StatusSettings', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('shows the box as the server reports it', fakeAsync(() => {
        const { fixture } = create();
        flushMicrotasks();
        fixture.detectChanges();
        expect(row(fixture, 'Up')!.textContent!.trim()).toBe('3d 4h');
        expect(row(fixture, 'CPU')!.textContent!.trim()).toBe('12%, load 0.40');
        expect(row(fixture, 'Temperature')!.textContent!.trim()).toBe('52.1 °C');
        expect(row(fixture, 'Temperature')!.classList).not.toContain('text-warn');
        expect(row(fixture, 'Power')!.textContent!.trim()).toBe('OK');
        expect(row(fixture, 'SD card')!.textContent!.trim()).toBe('5.8 of 29 GB (20%)');
        expect(text(fixture)).toContain('Nothing indexed yet.');
        expect(text(fixture)).toContain('Not built yet.');
        fixture.destroy();
    }));

    it('warns when it is hot or the supply sags', fakeAsync(() => {
        const { fixture } = create({
            status: systemStatus({ temperatures: [{ name: 'cpu-thermal', celsius: 81 }], underVoltage: true }),
        });
        flushMicrotasks();
        fixture.detectChanges();
        expect(row(fixture, 'Temperature')!.classList).toContain('text-warn');
        expect(row(fixture, 'Power')!.classList).toContain('text-warn');
        fixture.destroy();
    }));

    it('hides what a dev machine does not have', fakeAsync(() => {
        const { fixture } = create({
            status: systemStatus({ temperatures: [], underVoltage: null, cpuPercent: null, disk: null }),
        });
        flushMicrotasks();
        fixture.detectChanges();
        expect(row(fixture, 'Temperature')).toBeUndefined();
        expect(row(fixture, 'Power')).toBeUndefined();
        expect(row(fixture, 'SD card')).toBeUndefined();
        expect(row(fixture, 'CPU')!.textContent!.trim()).toBe('load 0.40');
        fixture.destroy();
    }));

    it('draws progress while thumbnails build', fakeAsync(() => {
        const { fixture } = create({
            status: systemStatus({ thumbnails: { ...NEVER, state: 'running', scope: 'library', progress: 25, total: 100 } }),
        });
        flushMicrotasks();
        fixture.detectChanges();
        const bar = (fixture.nativeElement as HTMLElement).querySelector('[role="progressbar"]')!;
        expect(bar.getAttribute('aria-valuenow')).toBe('25');
        expect((bar.firstElementChild as HTMLElement).style.width).toBe('25%');
        fixture.destroy();
    }));

    it('says when the library is scanning', fakeAsync(() => {
        const { fixture } = create({ library: libraryState({ scanning: true, scanStartedAt: Date.now() }) });
        flushMicrotasks();
        fixture.detectChanges();
        expect(text(fixture)).toContain('Scanning — started just now.');
        fixture.destroy();
    }));

    it('polls while open, and stops when closed', fakeAsync(() => {
        const { fixture, getJson } = create();
        flushMicrotasks();
        expect(getJson).toHaveBeenCalledOnceWith('/api/system/status');
        tick(STATUS_POLL_MS);
        expect(getJson).toHaveBeenCalledTimes(2);
        fixture.destroy();
        tick(STATUS_POLL_MS * 3);
        expect(getJson).toHaveBeenCalledTimes(2);
    }));

    it('says why when the box does not answer', fakeAsync(() => {
        const { fixture } = create({ fail: true });
        flushMicrotasks();
        fixture.detectChanges();
        expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')!.textContent).toContain('offline');
        fixture.destroy();
    }));
});
