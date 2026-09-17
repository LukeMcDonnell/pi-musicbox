import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LIBRARY_SCAN_HOURS, type LibraryScan } from '@musicbox/shared';
import { ApiClient } from '../../../../services/api-client';
import { MusicboxApi } from '../../../../services/musicbox-api';
import { SettingSelect, type SettingOption } from '../setting-select/setting-select';
import { SettingSwitch } from '../setting-switch/setting-switch';

/** '4:00 am'. The panel is a clock-on-the-wall, not an ISO timestamp. */
export function hourLabel(hour: number): string {
    if (hour < 0) return 'Never';
    return `${clockLabel(hour, 0)}`;
}

/** '6:59 am'. Twelve-hour, to match the hour the scan is scheduled for. */
function clockLabel(hour: number, minute: number): string {
    const suffix = hour < 12 ? 'am' : 'pm';
    const h = hour % 12 === 0 ? 12 : hour % 12;
    return `${h}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** '48m 40s'. Scans here run for the better part of an hour. */
export function duration(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

/** 'yesterday', 'today at 4:02'. Nobody needs a date for something 20 minutes old. */
export function ago(at: number, now: number): string {
    const seconds = Math.round((now - at) / 1000);
    if (seconds < 90) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minutes ago`;
    const when = new Date(at);
    const time = clockLabel(when.getHours(), when.getMinutes());
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    if (at >= startOfToday.getTime()) return `today at ${time}`;
    if (at >= startOfToday.getTime() - 86_400_000) return `yesterday at ${time}`;
    const days = Math.floor((startOfToday.getTime() - at) / 86_400_000) + 1;
    if (days < 7) return `${days} days ago`;
    return when.toLocaleDateString();
}

/**
 * The Library tab: what MPD has indexed, and when it goes looking again.
 *
 * MPD runs `auto_update "no"` because inotify cannot see changes made on the far
 * side of an NFS mount, so every scan is explicit. That is what this screen is
 * for. A scan on the real library takes the better part of an hour and cannot be
 * cancelled, which is why the expensive one asks first.
 */
@Component({
    selector: 'app-library-settings',
    imports: [SettingSelect, SettingSwitch],
    template: `
        <h2 class="text-lg font-semibold">Library</h2>

        <div class="flex flex-col pt-1">
            <app-setting-select
                label="Scan for new music daily at"
                [value]="scanHour()"
                [options]="hourOptions"
                (selected)="setScanHour($event)" />
            <app-setting-switch
                label="Scan after starting up"
                [checked]="scanOnBoot()"
                (toggled)="setScanOnBoot($event)" />
        </div>

        <div class="pt-4" aria-live="polite">
            @if (scanning()) {
                <p class="text-[0.95rem]">Scanning the library…</p>
                <p class="pt-1 text-[0.85rem] text-muted">
                    Started {{ startedLabel() }}. This takes about an hour on a full
                    library, and it cannot be stopped once it has begun.
                </p>
            } @else {
                <p class="text-[0.95rem]">{{ lastScanLabel() }}</p>
            }
        </div>

        <div class="flex flex-wrap gap-2 pt-3">
            <button type="button"
                    class="min-h-11 cursor-pointer touch-manipulation rounded-full bg-accent px-5
                           text-[0.95rem] font-semibold text-on-accent select-none
                           active:bg-raised disabled:opacity-40"
                    [disabled]="busy()" (click)="scan()">
                Scan now
            </button>
            @if (confirming()) {
                <button type="button"
                        class="min-h-11 cursor-pointer touch-manipulation rounded-full bg-warn px-5
                               text-[0.95rem] font-semibold text-on-accent select-none
                               active:bg-raised disabled:opacity-40"
                        [disabled]="busy()" (click)="rescan()">
                    Confirm full rescan
                </button>
                <button type="button"
                        class="min-h-11 cursor-pointer touch-manipulation rounded-full px-4
                               text-[0.95rem] font-semibold text-muted select-none active:bg-raised"
                        (click)="confirming.set(false)">
                    Cancel
                </button>
            } @else {
                <button type="button"
                        class="min-h-11 cursor-pointer touch-manipulation rounded-full border
                               border-muted px-5 text-[0.95rem] font-semibold text-muted
                               select-none active:bg-raised disabled:opacity-40"
                        [disabled]="busy()" (click)="confirming.set(true)">
                    Full rescan
                </button>
            }
        </div>

        @if (confirming()) {
            <p class="pt-2 text-[0.85rem] text-muted">
                A full rescan re-reads every tag rather than only what changed — about
                an hour. Use it after retagging music the box has already seen.
            </p>
        }

        @if (error(); as message) {
            <p class="pt-2 text-[0.9rem] text-warn" role="alert">{{ message }}</p>
        }

        <div class="pt-5 text-[0.85rem] text-muted">
            <p>{{ statsLabel() }}</p>
            <p class="pt-1">
                {{ musicRoot() }}<!--
                -->@if (unreachable()) {<span class="text-warn"> — not reachable</span>}
            </p>
            @if (nextScanLabel(); as next) {
                <p class="pt-1">{{ next }}</p>
            }
        </div>
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibrarySettings {
    private readonly api = inject(MusicboxApi);
    private readonly client = inject(ApiClient);

    protected readonly hourOptions: readonly SettingOption[] = LIBRARY_SCAN_HOURS.map((hour) => ({
        value: hour,
        label: hourLabel(hour),
    }));

    protected readonly error = signal<string | null>(null);
    protected readonly confirming = signal(false);
    /** True from the tap until the server has answered. */
    private readonly sending = signal(false);

    /** As in system-settings: the asked-for value wins until the box answers. */
    private readonly pendingHour = signal<number | null>(null);
    private readonly pendingBoot = signal<boolean | null>(null);

    private readonly state = computed(() => this.api.library());

    protected readonly scanning = computed(() => this.state()?.scanning ?? false);
    protected readonly busy = computed(() => this.sending() || this.scanning());
    protected readonly musicRoot = computed(() => this.state()?.musicRoot ?? '');
    protected readonly unreachable = computed(() => this.state()?.musicRootReadable === false);

    protected readonly scanHour = computed(
        () => this.pendingHour() ?? this.api.settings()?.libraryScanHour ?? -1,
    );
    protected readonly scanOnBoot = computed(
        () => this.pendingBoot() ?? this.api.settings()?.libraryScanOnBoot ?? false,
    );

    constructor() {
        // Re-probes the music share, which the stream's own frame deliberately
        // does not do.
        void this.api.refreshLibrary();
    }

    protected startedLabel(): string {
        const at = this.state()?.scanStartedAt;
        return at == null ? 'a moment ago' : ago(at, Date.now());
    }

    protected lastScanLabel(): string {
        const scan = this.state()?.lastScan ?? null;
        if (scan === null) return 'This library has never been scanned.';
        if (scan.finishedAt === null) {
            return `A scan started ${ago(scan.startedAt, Date.now())} was interrupted — the index may be incomplete.`;
        }
        const took = duration(scan.finishedAt - scan.startedAt);
        const when = ago(scan.finishedAt, Date.now());
        if (scan.outcome === 'interrupted') {
            return `Last scan ${when} stopped after ${took} — MPD restarted under it, so the index may be incomplete.`;
        }
        return `Last scanned ${when}, and it took ${took}.${this.addedLabel(scan)}`;
    }

    private addedLabel(scan: LibraryScan): string {
        if (scan.songsBefore === null || scan.songsAfter === null) return '';
        const change = scan.songsAfter - scan.songsBefore;
        if (change === 0) return ' Nothing had changed.';
        const n = Math.abs(change);
        return change > 0
            ? ` ${n} ${n === 1 ? 'song' : 'songs'} added.`
            : ` ${n} ${n === 1 ? 'song' : 'songs'} gone.`;
    }

    protected statsLabel(): string {
        const stats = this.state()?.stats ?? null;
        if (stats === null) return 'Nothing indexed yet.';
        const hours = Math.round(stats.playtimeSeconds / 3600);
        return `${stats.songs.toLocaleString()} songs, ${stats.albums.toLocaleString()} albums, ${stats.artists.toLocaleString()} artists, ${hours.toLocaleString()} hours`;
    }

    protected nextScanLabel(): string | null {
        const at = this.state()?.nextScanAt ?? null;
        if (at === null) return null;
        const when = new Date(at);
        const day = when.getDate() === new Date().getDate() ? 'today' : 'tomorrow';
        return `Next scan ${day} at ${clockLabel(when.getHours(), when.getMinutes())}`;
    }

    protected async setScanHour(hour: number): Promise<void> {
        this.pendingHour.set(hour);
        this.error.set(null);
        try {
            await this.client.patchJson('/api/settings', { libraryScanHour: hour });
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.pendingHour.set(null);
        }
    }

    protected async setScanOnBoot(on: boolean): Promise<void> {
        this.pendingBoot.set(on);
        this.error.set(null);
        try {
            await this.client.patchJson('/api/settings', { libraryScanOnBoot: on });
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.pendingBoot.set(null);
        }
    }

    protected scan(): Promise<void> {
        return this.send('/api/library/scan');
    }

    protected rescan(): Promise<void> {
        this.confirming.set(false);
        return this.send('/api/library/rescan');
    }

    private async send(path: string): Promise<void> {
        this.sending.set(true);
        this.error.set(null);
        try {
            await this.client.post(path);
            // The 202 says it started; the state it started arrives on the stream.
            await this.api.refreshLibrary();
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.sending.set(false);
        }
    }
}
