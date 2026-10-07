import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import type { MetadataStatus, SystemStatus, ThumbnailStatus, Usage } from '@musicbox/shared';
import { ago } from '../../../../services/ago';
import { ApiClient } from '../../../../services/api-client';
import { MusicboxApi } from '../../../../services/musicbox-api';
import { libraryStatsLabel } from '../library-settings/library-settings';

/** Long enough to be no load on the Pi, short enough that CPU still looks live. */
export const STATUS_POLL_MS = 3000;

/** The Pi 4's firmware starts throttling at 80 °C. */
export const HOT_CELSIUS = 80;

/** '3d 4h', '4h 12m', '12m'. */
export function uptimeLabel(seconds: number): string {
    const d = Math.floor(seconds / 86_400);
    const h = Math.floor((seconds % 86_400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** '5.8 of 29 GB (20%)', in one unit chosen by the total, as df -h counts. */
export function usageLabel(usage: Usage): string {
    const unit = usage.totalBytes >= GB ? GB : MB;
    const name = unit === GB ? 'GB' : 'MB';
    const fmt = (bytes: number) => {
        const n = bytes / unit;
        return n >= 10 || unit === MB ? Math.round(n).toLocaleString() : n.toFixed(1);
    };
    const pct = usage.totalBytes > 0 ? Math.round((usage.usedBytes / usage.totalBytes) * 100) : 0;
    return `${fmt(usage.usedBytes)} of ${fmt(usage.totalBytes)} ${name} (${pct}%)`;
}

export function thumbnailLabel(t: ThumbnailStatus, now: number): string {
    const what = t.scope === 'cd' ? 'CD covers' : 'Covers';
    switch (t.state) {
        case 'running':
            return `Building — ${(t.progress ?? 0).toLocaleString()} of ${(t.total ?? 0).toLocaleString()} ${what.toLowerCase()} checked`;
        case 'interrupted':
            return 'A build stopped part way through. The next library scan picks it up again.';
        case 'never':
            return 'Not built yet.';
        case 'done': {
            const when = t.finishedAt === null ? '' : ` ${ago(t.finishedAt, now)}`;
            const counts = [
                t.built !== null ? `${t.built.toLocaleString()} new` : null,
                t.failed ? `${t.failed.toLocaleString()} failed` : null,
            ].filter((x) => x !== null);
            return `${what} last built${when}${counts.length ? ` — ${counts.join(', ')}` : ''}.`;
        }
    }
}

/** What the metadata harvest is doing, or how its last run went. */
export function metadataRunLabel(m: MetadataStatus, now: number): string {
    if (m.phase !== null) {
        return `Fetching ${m.phase} — ${(m.progress ?? 0).toLocaleString()} of ${(m.total ?? 0).toLocaleString()}`;
    }
    const last = m.lastRun;
    if (last === null) return 'Not run since the server started. It runs two minutes after start.';
    const when = ago(last.finishedAt, now);
    if (last.stopped !== null) return `Last run stopped ${when}: ${last.stopped}. It tries again within six hours.`;
    const updated = last.albums + last.artists;
    const retry = last.unsure > 0 ? ` ${count(last.unsure, 'artist')} to retry for similar artists.` : '';
    return updated === 0
        ? `Up to date — last checked ${when}.${retry}`
        : `Last run finished ${when} — ${count(last.albums, 'album')}, ${count(last.artists, 'artist')} updated.${retry}`;
}

/** How much of the library has each kind of metadata. */
export function metadataCoverageLabels(m: MetadataStatus): string[] {
    const c = m.coverage;
    const artists = (c.libraryArtists ?? c.artists).toLocaleString();
    const albums = (c.libraryAlbums ?? c.albums).toLocaleString();
    return [
        `Biographies for ${c.bios.toLocaleString()} of ${artists} artists, similar artists for ${c.similar.toLocaleString()}` +
            (m.hasToken ? `, listen counts for ${c.listens.toLocaleString()}.` : '.'),
        `Album intros for ${c.abouts.toLocaleString()} of ${albums} albums.`,
    ];
}

function count(n: number, noun: string): string {
    return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The Status tab: how the box itself is doing. Read-only.
 *
 * Polled while open rather than carried on the stream — see decisions.md.
 */
@Component({
    selector: 'app-status-settings',
    template: `
        <h2 class="text-lg font-semibold">Status</h2>

        @if (status(); as s) {
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pt-2 text-[0.95rem]">
                <dt class="text-muted">Up</dt>
                <dd>{{ uptime() }}</dd>

                <dt class="text-muted">CPU</dt>
                <dd>{{ cpu() }}</dd>

                @for (t of s.temperatures; track t.name) {
                    <dt class="text-muted">{{ s.temperatures.length > 1 ? t.name : 'Temperature' }}</dt>
                    <dd [class.text-warn]="t.celsius >= hot">{{ t.celsius.toFixed(1) }} °C</dd>
                }

                @if (s.underVoltage !== null) {
                    <dt class="text-muted">Power</dt>
                    <dd [class.text-warn]="s.underVoltage">
                        {{ s.underVoltage ? 'Under-voltage — the supply is not keeping up' : 'OK' }}
                    </dd>
                }

                @if (s.memory; as memory) {
                    <dt class="text-muted">Memory</dt>
                    <dd>{{ usage(memory) }}</dd>
                }

                @if (s.disk; as disk) {
                    <dt class="text-muted">SD card</dt>
                    <dd>{{ usage(disk) }}</dd>
                }
            </dl>
        } @else if (!error()) {
            <p class="pt-2 text-[0.95rem] text-muted">Reading…</p>
        }

        @if (error(); as message) {
            <p class="pt-2 text-[0.9rem] text-warn" role="alert">{{ message }}</p>
        }

        <h3 class="pt-5 text-[0.95rem] font-semibold">Library</h3>
        <div class="pt-1 text-[0.85rem] text-muted" aria-live="polite">
            <p>{{ scanLabel() }}</p>
            <p class="pt-1">{{ statsLabel() }}</p>
        </div>

        @if (status()?.thumbnails; as thumbs) {
            <h3 class="pt-5 text-[0.95rem] font-semibold">Cover thumbnails</h3>
            <p class="pt-1 text-[0.85rem] text-muted">{{ thumbnail(thumbs) }}</p>
            @if (thumbs.state === 'running' && thumbs.total) {
                <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-surface" role="progressbar"
                     aria-label="Cover thumbnails" aria-valuemin="0"
                     [attr.aria-valuemax]="thumbs.total" [attr.aria-valuenow]="thumbs.progress">
                    <div class="h-full bg-accent" [style.width.%]="(100 * (thumbs.progress ?? 0)) / thumbs.total"></div>
                </div>
            }
        }

        @if (status()?.metadata; as meta) {
            <h3 class="pt-5 text-[0.95rem] font-semibold">Online metadata</h3>
            <div class="pt-1 text-[0.85rem] text-muted" aria-live="polite">
                <p>{{ metadataRun(meta) }}</p>
                @if (meta.phase !== null && meta.total) {
                    <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-surface" role="progressbar"
                         aria-label="Online metadata" aria-valuemin="0"
                         [attr.aria-valuemax]="meta.total" [attr.aria-valuenow]="meta.progress">
                        <div class="h-full bg-accent" [style.width.%]="(100 * (meta.progress ?? 0)) / meta.total"></div>
                    </div>
                }
                @for (line of coverage(meta); track $index) {
                    <p class="pt-1">{{ line }}</p>
                }
                @if (!meta.hasToken) {
                    <p class="pt-1 text-warn">No ListenBrainz token, so no popular tracks. See the README.</p>
                }
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatusSettings {
    private readonly api = inject(MusicboxApi);
    private readonly client = inject(ApiClient);

    protected readonly hot = HOT_CELSIUS;
    protected readonly status = signal<SystemStatus | null>(null);
    protected readonly error = signal<string | null>(null);

    protected readonly uptime = computed(() => uptimeLabel(this.status()?.uptimeSeconds ?? 0));
    protected readonly cpu = computed(() => {
        const s = this.status();
        if (!s) return '';
        const load = `load ${s.load[0].toFixed(2)}`;
        return s.cpuPercent === null ? load : `${s.cpuPercent}%, ${load}`;
    });

    private readonly library = computed(() => this.api.library());
    protected readonly statsLabel = computed(() => libraryStatsLabel(this.library()?.stats ?? null));

    constructor() {
        void this.poll();
        const timer = setInterval(() => void this.poll(), STATUS_POLL_MS);
        inject(DestroyRef).onDestroy(() => clearInterval(timer));
    }

    protected usage(u: Usage): string {
        return usageLabel(u);
    }

    protected thumbnail(t: ThumbnailStatus): string {
        return thumbnailLabel(t, Date.now());
    }

    protected metadataRun(m: MetadataStatus): string {
        return metadataRunLabel(m, Date.now());
    }

    protected coverage(m: MetadataStatus): string[] {
        return metadataCoverageLabels(m);
    }

    protected scanLabel(): string {
        const state = this.library();
        if (!state) return '';
        if (state.scanning) {
            const at = state.scanStartedAt;
            return `Scanning — started ${at === null ? 'a moment ago' : ago(at, Date.now())}.`;
        }
        const finished = state.lastScan?.finishedAt ?? null;
        return finished === null ? 'Not scanning.' : `Not scanning. Last scan finished ${ago(finished, Date.now())}.`;
    }

    private async poll(): Promise<void> {
        try {
            this.status.set(await this.client.getJson<SystemStatus>('/api/system/status'));
            this.error.set(null);
        } catch (err) {
            this.error.set((err as Error).message);
        }
    }
}
