import { CdkDrag, CdkDragHandle, CdkDropList, moveItemInArray, type CdkDragDrop } from '@angular/cdk/drag-drop';
import {
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    computed,
    effect,
    inject,
    input,
    signal,
    untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import {
    LucideChevronLeft,
    LucideEllipsisVertical,
    LucideGripVertical,
    LucideListMusic,
    LucideListEnd,
    LucideMusic,
    LucidePlay,
    LucideShuffle,
    LucideX,
} from '@lucide/angular';
import type { PlaylistResponse, Track } from '@musicbox/shared';
import { clock } from '../../components/now-playing/now-playing';
import {
    PlaylistDialog,
    type PlaylistDialogResult,
    type PlaylistDialogView,
} from '../../components/playlist-dialog/playlist-dialog';
import { CoverArt } from '../../components/cover-art/cover-art';
import { CoverGrid } from '../../components/cover-grid/cover-grid';
import { ApiClient } from '../../services/api-client';
import { TrackMenu, type TrackAction } from '../../components/track-menu/track-menu';
import { AppHistory } from '../../services/app-history';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { PlaylistsStore } from '../../services/playlists-store';
import { Preferences } from '../../services/preferences';
import { summaryOf } from '../playlists/playlists';

/** How long Undo stays offered after a removal. */
const UNDO_MS = 5000;

/** One playlist: its name, Play and Queue, and its tracks in order. */
@Component({
    selector: 'app-playlist',
    imports: [
        CdkDrag,
        CdkDragHandle,
        CdkDropList,
        CoverArt,
        CoverGrid,
        LucideChevronLeft,
        LucideEllipsisVertical,
        LucideGripVertical,
        LucideListMusic,
        LucideListEnd,
        LucideMusic,
        LucidePlay,
        LucideShuffle,
        LucideX,
        PlaylistDialog,
        TrackMenu,
    ],
    templateUrl: './playlist.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Playlist {
    private readonly store = inject(PlaylistsStore);
    private readonly sheet = inject(NowPlayingSheet);
    private readonly prefs = inject(Preferences);
    private readonly router = inject(Router);
    private readonly history = inject(AppHistory);
    private readonly client = inject(ApiClient);

    /** Bound from `?name=` by withComponentInputBinding(). */
    readonly name = input<string>('');

    readonly data = signal<PlaylistResponse | null>(null);
    readonly error = signal<string | null>(null);
    readonly busy = signal(false);
    readonly dialog = signal<PlaylistDialogView | null>(null);

    /** The track whose ⋮ menu is open, or null. */
    readonly menuTrack = signal<Track | null>(null);
    readonly trackActions: readonly TrackAction[] = ['remove', 'artist', 'album'];

    /** Edit mode: a grip to drag each row by, and a × to remove it. */
    readonly editing = signal(false);
    /** The last removal, for Undo, until it times out or the next edit. */
    readonly removed = signal<{ file: string; pos: number; title: string } | null>(null);
    private undoTimer: ReturnType<typeof setTimeout> | undefined;

    readonly loading = computed(() => this.data() === null && this.error() === null);
    readonly tracks = computed(() => this.data()?.tracks ?? []);
    readonly summary = computed(() => {
        const data = this.data();
        return data === null ? null : summaryOf(data.playlist);
    });

    private readonly artFailed = signal<ReadonlySet<string>>(new Set());

    /** Different album covers, in playlist order, for the header. CoverGrid picks four or one. */
    readonly covers = computed(() => {
        const seen = new Set<string>();
        for (const track of this.tracks()) {
            const uri = this.artOf(track);
            if (uri !== null) seen.add(uri);
            if (seen.size === 4) break;
        }
        return [...seen];
    });

    /** This playlist's entry in the streamed list; its `modified` changing means refetch. */
    private readonly stamp = computed(
        () => this.store.playlists()?.find((p) => p.name === this.name())?.modified ?? null,
    );

    private request = 0;

    constructor() {
        inject(DestroyRef).onDestroy(() => clearTimeout(this.undoTimer));
        effect(() => {
            const name = this.name();
            const stamp = this.stamp();
            if (name === '') return;
            // Gone from the list mid-rename: the URL is about to change, so do not fetch the old name.
            if (stamp === null && untracked(this.data)?.playlist.name === name) return;
            void this.load(name);
        });
    }

    private async load(name: string): Promise<void> {
        const request = ++this.request;
        try {
            const data = await this.store.fetchPlaylist(name);
            if (request === this.request) {
                this.data.set(data);
                this.error.set(null);
            }
        } catch (err) {
            if (request === this.request) this.error.set((err as Error).message);
        }
    }

    /** Resolved, as every cover must be — see ApiClient.resolve. Null when there is none or it failed. */
    artOf(track: Track): string | null {
        if (!track.image) return null;
        const uri = this.client.resolve(track.image);
        return this.artFailed().has(uri) ? null : uri;
    }

    onArtError(uri: string): void {
        this.artFailed.update((failed) => new Set(failed).add(uri));
    }

    titleOf(track: Track): string {
        return track.title || track.file || 'Unknown track';
    }

    /** "Artist · Album", whichever of the two it has. */
    sourceOf(track: Track): string {
        return [track.artist, track.album].filter((s) => s).join(' · ');
    }

    durationOf(track: Track): string {
        return clock(track.duration ?? null);
    }

    async play(): Promise<void> {
        if (await this.send(() => this.store.play(this.name())) && this.prefs.openNowPlayingOnPlay()) {
            this.sheet.show();
        }
    }

    async queue(): Promise<void> {
        if (await this.send(() => this.store.queue(this.name())) && this.prefs.openQueueOnAdd()) {
            this.sheet.showQueue();
        }
    }

    /**
     * Moved locally before the server answers — the one optimistic update in
     * this UI, because a dropped row snapping back and then jumping reads as a
     * failed drag. The answer replaces it; a refusal reloads.
     */
    async drop(event: CdkDragDrop<Track[]>): Promise<void> {
        const { previousIndex: from, currentIndex: to } = event;
        const track = this.tracks()[from];
        if (from === to || track?.file === undefined || this.busy()) return;
        this.data.update((data) => {
            if (data === null) return data;
            const tracks = [...data.tracks];
            moveItemInArray(tracks, from, to);
            return { ...data, tracks };
        });
        const file = track.file;
        await this.edit(() => this.store.moveTrack(this.name(), from, to, file));
    }

    async remove(track: Track, pos: number): Promise<void> {
        const file = track.file;
        if (file === undefined) return;
        if (await this.edit(() => this.store.removeTrack(this.name(), pos, file))) {
            this.removed.set({ file, pos, title: this.titleOf(track) });
            clearTimeout(this.undoTimer);
            this.undoTimer = setTimeout(() => this.removed.set(null), UNDO_MS);
        }
    }

    /** By identity: the same song can be in a playlist twice. */
    removeFromMenu(track: Track): Promise<void> {
        const pos = this.tracks().indexOf(track);
        return pos === -1 ? Promise.resolve() : this.remove(track, pos);
    }

    /** Put the last removed track back where it was. */
    async undo(): Promise<void> {
        const removed = this.removed();
        if (removed === null) return;
        const name = this.name();
        if (await this.send(() => this.store.addTrack(name, removed.file, removed.pos))) {
            this.removed.set(null);
            await this.load(name);
        }
    }

    toggleEditing(): void {
        this.editing.update((on) => !on);
        this.removed.set(null);
    }

    /** True when the server took it; its answer is the playlist. A refusal reloads, since the screen may be stale. */
    private async edit(action: () => Promise<PlaylistResponse>): Promise<boolean> {
        if (this.busy()) return false;
        this.busy.set(true);
        this.error.set(null);
        this.removed.set(null);
        try {
            this.data.set(await action());
            return true;
        } catch (err) {
            this.error.set((err as Error).message);
            void this.load(this.name()).then(() => this.error.set((err as Error).message));
            return false;
        } finally {
            this.busy.set(false);
        }
    }

    onDialogDone(result: PlaylistDialogResult): void {
        if (result.kind === 'deleted') {
            void this.router.navigate(['/playlists'], { replaceUrl: true });
        } else if (result.kind === 'renamed') {
            void this.router.navigate([], { queryParams: { name: result.name }, replaceUrl: true });
        } else if (result.kind === 'shuffled') {
            // Undo's position means nothing in the new order.
            this.removed.set(null);
            void this.load(result.name);
        }
    }

    back(): void {
        this.history.back(['/playlists']);
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
