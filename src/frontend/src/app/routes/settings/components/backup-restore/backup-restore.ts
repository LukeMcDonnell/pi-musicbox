import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { BACKUP_CONTENT_TYPE, type RestoreResponse } from '@musicbox/shared';
import { ApiClient } from '../../../../services/api-client';
import { MusicboxApi } from '../../../../services/musicbox-api';

type Phase = 'idle' | 'downloading' | 'confirming' | 'uploading' | 'restoring' | 'restored';

/**
 * Download the box's state as one archive, or upload one to replace it.
 *
 * Phones only: on the panel a download lands on the Pi and a file picker browses it.
 */
@Component({
    selector: 'app-backup-restore',
    template: `
        <h3 class="pt-6 text-base font-semibold">Backup</h3>
        <p class="pt-1 text-[0.85rem] text-muted">
            The queue, the library index and the box's settings, in one file.
        </p>

        <div class="flex flex-wrap gap-2 pt-3">
            <button type="button"
                    class="min-h-11 cursor-pointer touch-manipulation rounded-full bg-accent px-5
                           text-[0.95rem] font-semibold text-on-accent select-none
                           active:bg-raised disabled:opacity-40"
                    [disabled]="busy()" (click)="download()">
                {{ phase() === 'downloading' ? 'Preparing…' : 'Download backup' }}
            </button>
            <button type="button"
                    class="min-h-11 cursor-pointer touch-manipulation rounded-full border
                           border-muted px-5 text-[0.95rem] font-semibold text-muted
                           select-none active:bg-raised disabled:opacity-40"
                    [disabled]="busy() || blocked() !== null" (click)="picker.click()">
                Restore…
            </button>
            <input #picker type="file" class="hidden" accept=".gz,.tgz,application/gzip"
                   (change)="choose(picker)" />
        </div>

        @if (blocked(); as reason) {
            <p class="pt-2 text-[0.85rem] text-muted">{{ reason }}</p>
        }

        @if (phase() === 'confirming') {
            <p class="pt-3 text-[0.9rem]">
                Restore <span class="font-semibold">{{ file()?.name }}</span>? It replaces the
                queue, the library index and the settings. Music stops for a few seconds.
            </p>
            <div class="flex flex-wrap gap-2 pt-2">
                <button type="button"
                        class="min-h-11 cursor-pointer touch-manipulation rounded-full bg-warn px-5
                               text-[0.95rem] font-semibold text-on-accent select-none
                               active:bg-raised disabled:opacity-40"
                        [disabled]="blocked() !== null" (click)="restore()">
                    Confirm restore
                </button>
                <button type="button"
                        class="min-h-11 cursor-pointer touch-manipulation rounded-full px-4
                               text-[0.95rem] font-semibold text-muted select-none active:bg-raised"
                        (click)="cancel()">
                    Cancel
                </button>
            </div>
        }

        <div aria-live="polite">
            @switch (phase()) {
                @case ('uploading') { <p class="pt-2 text-[0.9rem]">Uploading…</p> }
                @case ('restoring') { <p class="pt-2 text-[0.9rem]">Restoring… the box will reconnect by itself.</p> }
                @case ('restored') { <p class="pt-2 text-[0.9rem]">Restored.</p> }
            }
        </div>

        @if (error(); as message) {
            <p class="pt-2 text-[0.9rem] text-warn" role="alert">{{ message }}</p>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BackupRestore {
    private readonly api = inject(MusicboxApi);
    private readonly client = inject(ApiClient);

    protected readonly phase = signal<Phase>('idle');
    protected readonly file = signal<File | null>(null);
    protected readonly error = signal<string | null>(null);

    protected readonly busy = computed(() =>
        ['downloading', 'uploading', 'restoring'].includes(this.phase()),
    );

    /** The server refuses these too; saying so up front saves an upload. */
    protected readonly blocked = computed(() => {
        if (this.api.library()?.scanning) return 'Restore is unavailable while the library is being scanned.';
        if (this.api.snapshot()?.source === 'bluetooth') return 'Restore is unavailable while a phone is playing.';
        return null;
    });

    /** Set once the stream drops mid-restore, so its return means the box is back. */
    private sawDrop = false;

    constructor() {
        effect(() => {
            const stream = this.api.stream();
            if (this.phase() !== 'restoring') return;
            if (stream !== 'live') this.sawDrop = true;
            else if (this.sawDrop) this.phase.set('restored');
        });
    }

    protected async download(): Promise<void> {
        this.phase.set('downloading');
        this.error.set(null);
        try {
            const { blob, filename } = await this.client.getBlob('/api/backup');
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename ?? 'musicbox-backup.tar.gz';
            link.click();
            // Revoked late: Safari starts the download after click() returns.
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.phase.set('idle');
        }
    }

    protected choose(input: HTMLInputElement): void {
        const chosen = input.files?.[0] ?? null;
        // Cleared so choosing the same file again still fires a change.
        input.value = '';
        if (!chosen) return;
        this.file.set(chosen);
        this.error.set(null);
        this.phase.set('confirming');
    }

    protected cancel(): void {
        this.file.set(null);
        this.phase.set('idle');
    }

    protected async restore(): Promise<void> {
        const chosen = this.file();
        if (!chosen) return;
        this.phase.set('uploading');
        this.error.set(null);
        try {
            await this.client.postBlob<RestoreResponse>('/api/restore', chosen, BACKUP_CONTENT_TYPE);
            this.sawDrop = false;
            this.phase.set('restoring');
        } catch (err) {
            this.error.set((err as Error).message);
            this.phase.set('idle');
        } finally {
            this.file.set(null);
        }
    }
}
