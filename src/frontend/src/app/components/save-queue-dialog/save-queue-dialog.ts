import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    computed,
    effect,
    inject,
    model,
    output,
    signal,
    viewChild,
} from '@angular/core';
import { LucideChevronLeft, LucideListEnd, LucideReplace } from '@lucide/angular';
import { isCdTrack } from '@musicbox/shared';
import { MusicboxApi } from '../../services/musicbox-api';
import { PlaylistsStore } from '../../services/playlists-store';
import { PlaylistPicker } from '../playlist-picker/playlist-picker';

/** `mode` carries the existing playlist picked, to add to or replace. */
type Face = { kind: 'pick' } | { kind: 'name' } | { kind: 'mode'; name: string };

/** Saves the queue as a new playlist, onto an existing one, or in place of one. */
@Component({
    selector: 'app-save-queue-dialog',
    imports: [LucideChevronLeft, LucideListEnd, LucideReplace, PlaylistPicker],
    templateUrl: './save-queue-dialog.html',
    host: { class: 'contents', '(document:keydown.escape)': 'close()' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SaveQueueDialog {
    private readonly store = inject(PlaylistsStore);
    private readonly api = inject(MusicboxApi);

    readonly open = model(false);
    /** The playlist's name, once the server has saved to it. */
    readonly saved = output<string>();

    readonly face = signal<Face>({ kind: 'pick' });
    /** The existing playlist being added to or replaced, on the `mode` face. */
    readonly target = computed(() => {
        const face = this.face();
        return face.kind === 'mode' ? face.name : null;
    });
    readonly busy = signal(false);
    readonly error = signal<string | null>(null);

    /** The server leaves disc tracks out; this says so before it happens. */
    readonly cdCount = computed(() => this.api.queue().filter(isCdTrack).length);
    readonly saveable = computed(() => this.api.queue().length - this.cdCount());

    private readonly cancel = viewChild<ElementRef<HTMLButtonElement>>('cancel');

    constructor() {
        effect(() => {
            if (this.open() && this.face().kind !== 'name') this.cancel()?.nativeElement.focus();
        });
    }

    trackCountOf(name: string): number {
        return this.store.playlists()?.find((p) => p.name === name)?.trackCount ?? 0;
    }

    show(face: Face): void {
        this.error.set(null);
        this.face.set(face);
    }

    back(): void {
        this.show({ kind: 'pick' });
    }

    close(): void {
        if (!this.open() || this.busy()) return;
        this.error.set(null);
        this.face.set({ kind: 'pick' });
        this.open.set(false);
    }

    async save(name: string, mode: 'create' | 'append' | 'replace'): Promise<void> {
        if (this.busy()) return;
        this.busy.set(true);
        this.error.set(null);
        try {
            if (mode === 'create') await this.store.saveQueue(name);
            else if (mode === 'append') await this.store.appendQueue(name);
            else await this.store.replaceWithQueue(name);
            this.face.set({ kind: 'pick' });
            this.open.set(false);
            this.saved.emit(name);
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.busy.set(false);
        }
    }
}
