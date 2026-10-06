import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    computed,
    effect,
    inject,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import { LucideListMusic, LucidePlus } from '@lucide/angular';
import { PlaylistsStore } from '../../services/playlists-store';

/**
 * Choosing a playlist inside a modal: "New playlist…" and then each one, or —
 * once New was chosen — a name field. The host owns the modal, the header and
 * which of the two shows.
 */
@Component({
    selector: 'app-playlist-picker',
    imports: [LucideListMusic, LucidePlus],
    templateUrl: './playlist-picker.html',
    host: { class: 'contents' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaylistPicker {
    private readonly store = inject(PlaylistsStore);

    readonly naming = input(false);
    readonly busy = input(false);
    /** The name form's button, e.g. "Create and add". */
    readonly createLabel = input('Create');

    readonly picked = output<string>();
    readonly newPlaylist = output<void>();
    /** A trimmed, non-empty name for a playlist to make. */
    readonly create = output<string>();

    readonly playlists = computed(() => this.store.playlists() ?? []);
    readonly draft = signal('');

    private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

    constructor() {
        effect(() => {
            if (!this.naming()) return;
            this.draft.set('');
            this.field()?.nativeElement.focus();
        });
    }

    submit(): void {
        const name = this.draft().trim();
        if (name !== '' && !this.busy()) this.create.emit(name);
    }
}
