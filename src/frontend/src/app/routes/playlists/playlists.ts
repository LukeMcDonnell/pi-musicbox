import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
    LucideEllipsisVertical,
    LucideListMusic,
    LucideListEnd,
    LucidePlay,
    LucidePlus,
} from '@lucide/angular';
import type { PlaylistSummary } from '@musicbox/shared';
import {
    PlaylistDialog,
    type PlaylistDialogView,
} from '../../components/playlist-dialog/playlist-dialog';
import { CoverGrid } from '../../components/cover-grid/cover-grid';
import { ApiClient } from '../../services/api-client';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { PlaylistsStore } from '../../services/playlists-store';
import { Preferences } from '../../services/preferences';
import { runtime } from '../album/album';

/** The box's playlists: open one, play or queue it, or make a new one. */
@Component({
    selector: 'app-playlists',
    imports: [
        CoverGrid,
        LucideEllipsisVertical,
        LucideListMusic,
        LucideListEnd,
        LucidePlay,
        LucidePlus,
        PlaylistDialog,
    ],
    templateUrl: './playlists.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Playlists {
    private readonly store = inject(PlaylistsStore);
    private readonly sheet = inject(NowPlayingSheet);
    private readonly prefs = inject(Preferences);
    private readonly router = inject(Router);
    private readonly client = inject(ApiClient);

    readonly playlists = computed(() => this.store.playlists() ?? []);
    readonly loading = computed(() => this.store.playlists() === null);

    readonly dialog = signal<PlaylistDialogView | null>(null);
    readonly busy = signal(false);
    readonly error = signal<string | null>(null);

    private readonly artFailed = signal<ReadonlySet<string>>(new Set());

    /** Resolved, as every cover must be — see ApiClient.resolve — less any that failed. */
    coversOf(playlist: PlaylistSummary): string[] {
        const failed = this.artFailed();
        return (playlist.covers ?? []).map((c) => this.client.resolve(c)).filter((uri) => !failed.has(uri));
    }

    onArtError(uri: string): void {
        this.artFailed.update((failed) => new Set(failed).add(uri));
    }

    subtitleOf(playlist: PlaylistSummary): string {
        return summaryOf(playlist);
    }

    open(playlist: PlaylistSummary): void {
        void this.router.navigate(['/playlists/playlist'], { queryParams: { name: playlist.name } });
    }

    async play(playlist: PlaylistSummary): Promise<void> {
        if (await this.send(() => this.store.play(playlist.name)) && this.prefs.openNowPlayingOnPlay()) {
            this.sheet.show();
        }
    }

    async queue(playlist: PlaylistSummary): Promise<void> {
        if (await this.send(() => this.store.queue(playlist.name)) && this.prefs.openQueueOnAdd()) {
            this.sheet.showQueue();
        }
    }

    /** True when the request was accepted. */
    private async send(action: () => Promise<void>): Promise<boolean> {
        if (this.busy()) return false;
        this.busy.set(true);
        this.error.set(null);
        try {
            await action();
            return true;
        } catch (err) {
            this.error.set((err as Error).message);
            return false;
        } finally {
            this.busy.set(false);
        }
    }
}

/** "12 tracks · 48:10", or "Empty". */
export function summaryOf(playlist: PlaylistSummary): string {
    if (playlist.trackCount === 0) return 'Empty';
    const count = playlist.trackCount === 1 ? '1 track' : `${playlist.trackCount} tracks`;
    return playlist.duration === null ? count : `${count} · ${runtime(playlist.duration)}`;
}
