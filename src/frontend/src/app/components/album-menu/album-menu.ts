import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    effect,
    inject,
    linkedSignal,
    model,
    output,
    signal,
    viewChild,
} from '@angular/core';
import { LucideChevronLeft, LucideListEnd, LucideListPlus, LucideListStart, LucidePlay } from '@lucide/angular';
import type { AlbumSummary } from '@musicbox/shared';
import { PlaylistsStore } from '../../services/playlists-store';
import { PlaylistPicker } from '../playlist-picker/playlist-picker';

type Face = 'actions' | 'pick' | 'name';

/**
 * One album's actions, as a modal — TrackMenu's counterpart. Play, Queue and
 * Play next go back out as events; adding to a playlist is done here.
 */
@Component({
    selector: 'app-album-menu',
    imports: [LucideChevronLeft, LucideListEnd, LucideListPlus, LucideListStart, LucidePlay, PlaylistPicker],
    templateUrl: './album-menu.html',
    host: { class: 'contents', '(document:keydown.escape)': 'close()' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlbumMenu {
    private readonly store = inject(PlaylistsStore);

    /** The album the menu is for; null is closed. */
    readonly album = model<AlbumSummary | null>(null);

    readonly play = output<AlbumSummary>();
    readonly queue = output<AlbumSummary>();
    readonly playNext = output<AlbumSummary>();
    /** The playlist's name, once the server has the album in it. */
    readonly added = output<string>();

    readonly itemClass =
        'flex min-h-14 w-full flex-none cursor-pointer touch-manipulation items-center gap-3 rounded-lg ' +
        'border border-muted px-4 text-left text-[1.05rem] font-semibold select-none active:bg-raised ' +
        'disabled:opacity-40';

    readonly face = linkedSignal<AlbumSummary | null, Face>({ source: this.album, computation: () => 'actions' });
    readonly busy = signal(false);
    readonly error = signal<string | null>(null);

    private readonly cancel = viewChild<ElementRef<HTMLButtonElement>>('cancel');

    constructor() {
        // Cancel, so a stray Enter replaces no queue. The picker focuses its own name field.
        effect(() => {
            if (this.album() !== null && this.face() !== 'name') this.cancel()?.nativeElement.focus();
        });
    }

    choose(action: 'play' | 'queue' | 'playNext'): void {
        const album = this.album();
        if (album === null) return;
        this.album.set(null);
        this[action].emit(album);
    }

    show(face: Face): void {
        this.error.set(null);
        this.face.set(face);
    }

    close(): void {
        if (this.album() === null || this.busy()) return;
        this.error.set(null);
        this.album.set(null);
    }

    /** Into an existing playlist, or — given `create` — a new one made first. */
    async addTo(name: string, create = false): Promise<void> {
        const album = this.album();
        name = name.trim();
        if (album === null || name === '' || this.busy()) return;
        this.busy.set(true);
        this.error.set(null);
        try {
            if (create) await this.store.create(name);
            await this.store.addAlbum(name, {
                albumArtist: album.albumArtist,
                album: album.album,
                release: album.release,
            });
            this.album.set(null);
            this.added.emit(name);
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.busy.set(false);
        }
    }
}
