import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    effect,
    inject,
    input,
    linkedSignal,
    model,
    output,
    signal,
    viewChild,
} from '@angular/core';
import {
    LucideChevronLeft,
    LucideDisc3,
    LucideListEnd,
    LucideListPlus,
    LucideListStart,
    LucidePlay,
    LucideTrash2,
    LucideUser,
} from '@lucide/angular';
import { Router } from '@angular/router';
import type { Track } from '@musicbox/shared';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { PlaylistsStore } from '../../services/playlists-store';
import { PlaylistPicker } from '../playlist-picker/playlist-picker';

type Face = 'actions' | 'pick' | 'name';

/** What a menu offers. The album screen's is the default; the playlist and the queue pass their own. */
export type TrackAction = 'play' | 'queue' | 'playNext' | 'playlist' | 'remove' | 'artist' | 'album';
export const ALBUM_TRACK_ACTIONS: readonly TrackAction[] = ['play', 'queue', 'playNext', 'playlist'];

/**
 * One track's actions, as a modal. Play, Queue, Play next and Remove go back out
 * as events — the screen owns those requests — while adding to a playlist and
 * going to the artist or album are done here.
 */
@Component({
    selector: 'app-track-menu',
    imports: [
        LucideChevronLeft,
        LucideDisc3,
        LucideListEnd,
        LucideListPlus,
        LucideListStart,
        LucidePlay,
        LucideTrash2,
        LucideUser,
        PlaylistPicker,
    ],
    templateUrl: './track-menu.html',
    host: { class: 'contents', '(document:keydown.escape)': 'close()' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackMenu {
    private readonly store = inject(PlaylistsStore);
    private readonly sheet = inject(NowPlayingSheet);
    private readonly router = inject(Router);

    /** The track the menu is for; null is closed. */
    readonly track = model<Track | null>(null);

    readonly play = output<Track>();
    readonly queue = output<Track>();
    readonly playNext = output<Track>();
    readonly remove = output<Track>();

    readonly actions = input<readonly TrackAction[]>(ALBUM_TRACK_ACTIONS);
    /** Says what Remove takes it out of. */
    readonly removeLabel = input('Remove');
    /** The playlist's name, once the server has the track in it. */
    readonly added = output<string>();

    readonly itemClass =
        'flex min-h-14 w-full flex-none cursor-pointer touch-manipulation items-center gap-3 rounded-lg ' +
        'border border-muted px-4 text-left text-[1.05rem] font-semibold select-none active:bg-raised ' +
        'disabled:opacity-40';

        readonly face = linkedSignal<Track | null, Face>({ source: this.track, computation: () => 'actions' });
    readonly busy = signal(false);
    readonly error = signal<string | null>(null);

    private readonly cancel = viewChild<ElementRef<HTMLButtonElement>>('cancel');

    constructor() {
        // Cancel, so a stray Enter replaces no queue. The picker focuses its own name field.
        effect(() => {
            if (this.track() !== null && this.face() !== 'name') this.cancel()?.nativeElement.focus();
        });
    }

    titleOf(track: Track): string {
        return track.title || track.file || 'Unknown track';
    }

    /** The artist's page, or null for a track with no library album artist — a CD's, say. */
    artistUrl(track: Track): string | null {
        if (!track.albumArtist) return null;
        return this.router.serializeUrl(
            this.router.createUrlTree(['/library/artist'], { queryParams: { name: track.albumArtist } }),
        );
    }

    /** The album's page, or null without all three of its keys. */
    albumUrl(track: Track): string | null {
        if (!track.albumArtist || !track.album || !track.release) return null;
        return this.router.serializeUrl(
            this.router.createUrlTree(['/library/album'], {
                queryParams: { artist: track.albumArtist, album: track.album, release: track.release },
            }),
        );
    }

    /** Leaving through the sheet when it is open, so Back does not reopen it. */
    async go(url: string | null): Promise<void> {
        if (url === null) return;
        this.track.set(null);
        await this.sheet.leaveTo(url);
    }

    choose(action: 'play' | 'queue' | 'playNext' | 'remove'): void {
        const track = this.track();
        if (track === null) return;
        this.track.set(null);
        this[action].emit(track);
    }

    show(face: Face): void {
        this.error.set(null);
        this.face.set(face);
    }

    close(): void {
        if (this.track() === null || this.busy()) return;
        this.error.set(null);
        this.track.set(null);
    }

    /** Into an existing playlist, or — given `create` — a new one made first. */
    async addTo(name: string, create = false): Promise<void> {
        const file = this.track()?.file;
        name = name.trim();
        if (!file || name === '' || this.busy()) return;
        this.busy.set(true);
        this.error.set(null);
        try {
            if (create) await this.store.create(name);
            await this.store.addTrack(name, file);
            this.track.set(null);
            this.added.emit(name);
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.busy.set(false);
        }
    }
}
