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
import { LucideChevronLeft } from '@lucide/angular';
import { PlaylistsStore } from '../../services/playlists-store';
import { PlaylistPicker } from '../playlist-picker/playlist-picker';

/** Adding a list of songs to a playlist, as a modal: AlbumMenu's picker, for tracks that are not one album. */
@Component({
    selector: 'app-playlist-add',
    imports: [LucideChevronLeft, PlaylistPicker],
    templateUrl: './playlist-add.html',
    host: { class: 'contents', '(document:keydown.escape)': 'close()' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaylistAdd {
    private readonly store = inject(PlaylistsStore);

    /** The songs to add; null is closed. */
    readonly files = model<string[] | null>(null);
    /** What they are, under the heading — e.g. "Tool · Popular tracks". */
    readonly subtitle = input('');
    /** The playlist's name, once the server has the songs in it. */
    readonly added = output<string>();

    readonly naming = linkedSignal<string[] | null, boolean>({ source: this.files, computation: () => false });
    readonly busy = signal(false);
    readonly error = signal<string | null>(null);

    private readonly cancel = viewChild<ElementRef<HTMLButtonElement>>('cancel');

    constructor() {
        effect(() => {
            if (this.files() !== null && !this.naming()) this.cancel()?.nativeElement.focus();
        });
    }

    close(): void {
        if (this.files() === null || this.busy()) return;
        this.error.set(null);
        this.files.set(null);
    }

    /** Into an existing playlist, or — given `create` — a new one made first. */
    async addTo(name: string, create = false): Promise<void> {
        const files = this.files();
        name = name.trim();
        if (files === null || name === '' || this.busy()) return;
        this.busy.set(true);
        this.error.set(null);
        try {
            if (create) await this.store.create(name);
            await this.store.addTracks(name, files);
            this.files.set(null);
            this.added.emit(name);
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.busy.set(false);
        }
    }
}
