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
import { LucidePencil, LucideTrash2 } from '@lucide/angular';
import { PlaylistsStore } from '../../services/playlists-store';

/** Which face the dialog shows; null is closed. `actions` offers Rename and Delete. */
export type PlaylistDialogView =
    | { kind: 'create' }
    | { kind: 'actions'; name: string }
    | { kind: 'rename'; name: string }
    | { kind: 'delete'; name: string };

/** What was done, once the server agreed. `name` is the playlist's name afterwards. */
export interface PlaylistDialogResult {
    kind: 'created' | 'renamed' | 'deleted';
    name: string;
    previous?: string;
}

/** Create, rename and delete for playlists, as one modal. The server's refusals show inline. */
@Component({
    selector: 'app-playlist-dialog',
    imports: [LucidePencil, LucideTrash2],
    templateUrl: './playlist-dialog.html',
    host: { class: 'contents', '(document:keydown.escape)': 'close()' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaylistDialog {
    private readonly store = inject(PlaylistsStore);

    readonly view = model<PlaylistDialogView | null>(null);
    readonly done = output<PlaylistDialogResult>();

    readonly busy = signal(false);
    readonly error = signal<string | null>(null);
    /** The name field, seeded with the current name when renaming. */
    readonly draft = linkedSignal(() => {
        const view = this.view();
        return view?.kind === 'rename' ? view.name : '';
    });

    private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
    private readonly cancel = viewChild<ElementRef<HTMLButtonElement>>('cancel');

    constructor() {
        // The name field when there is one; otherwise Cancel, so a stray Enter deletes nothing.
        effect(() => {
            const view = this.view();
            if (view === null) return;
            const target = view.kind === 'create' || view.kind === 'rename' ? this.field() : this.cancel();
            target?.nativeElement.focus();
        });
    }

    show(view: PlaylistDialogView): void {
        this.error.set(null);
        this.view.set(view);
    }

    close(): void {
        if (this.view() === null || this.busy()) return;
        this.error.set(null);
        this.view.set(null);
    }

    async submit(): Promise<void> {
        const view = this.view();
        if (view === null || view.kind === 'actions' || this.busy()) return;
        const name = this.draft().trim();
        if (view.kind !== 'delete' && name === '') return;
        if (view.kind === 'rename' && name === view.name) {
            this.close();
            return;
        }
        this.busy.set(true);
        this.error.set(null);
        try {
            if (view.kind === 'create') {
                await this.store.create(name);
                this.done.emit({ kind: 'created', name });
            } else if (view.kind === 'rename') {
                await this.store.rename(view.name, name);
                this.done.emit({ kind: 'renamed', name, previous: view.name });
            } else {
                await this.store.remove(view.name);
                this.done.emit({ kind: 'deleted', name: view.name });
            }
            this.view.set(null);
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.busy.set(false);
        }
    }
}
