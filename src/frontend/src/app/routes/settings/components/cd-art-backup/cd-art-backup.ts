import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { BACKUP_CONTENT_TYPE, type CdArtRestoreResponse } from '@musicbox/shared';
import { ApiClient } from '../../../../services/api-client';

type Phase = 'idle' | 'downloading' | 'uploading';

/**
 * Download the looked-up CD covers, or upload them back. Restore only adds, so
 * it needs no confirmation and no restart.
 */
@Component({
    selector: 'app-cd-art-backup',
    template: `
        <h3 class="pt-6 text-base font-semibold">CD covers</h3>
        <p class="pt-1 text-[0.85rem] text-muted">
            Covers found for your CDs, kept apart from the backup above. Restoring adds
            them back and keeps any the box already has.
        </p>

        <div class="flex flex-wrap gap-2 pt-3">
            <button type="button"
                    class="min-h-11 cursor-pointer touch-manipulation rounded-full bg-accent px-5
                           text-[0.95rem] font-semibold text-on-accent select-none
                           active:bg-raised disabled:opacity-40"
                    [disabled]="phase() !== 'idle'" (click)="download()">
                {{ phase() === 'downloading' ? 'Preparing…' : 'Download covers' }}
            </button>
            <button type="button"
                    class="min-h-11 cursor-pointer touch-manipulation rounded-full border
                           border-muted px-5 text-[0.95rem] font-semibold text-muted
                           select-none active:bg-raised disabled:opacity-40"
                    [disabled]="phase() !== 'idle'" (click)="picker.click()">
                {{ phase() === 'uploading' ? 'Uploading…' : 'Restore covers…' }}
            </button>
            <input #picker type="file" class="hidden" accept=".gz,.tgz,application/gzip"
                   (change)="restore(picker)" />
        </div>

        <div aria-live="polite">
            @if (restored(); as count) {
                <p class="pt-2 text-[0.9rem]">Restored {{ count }} {{ count === 1 ? 'cover' : 'covers' }}.</p>
            } @else if (restored() === 0) {
                <p class="pt-2 text-[0.9rem]">That backup has no covers in it.</p>
            }
        </div>

        @if (error(); as message) {
            <p class="pt-2 text-[0.9rem] text-warn" role="alert">{{ message }}</p>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CdArtBackup {
    private readonly client = inject(ApiClient);

    protected readonly phase = signal<Phase>('idle');
    protected readonly restored = signal<number | null>(null);
    protected readonly error = signal<string | null>(null);

    protected async download(): Promise<void> {
        this.phase.set('downloading');
        this.error.set(null);
        this.restored.set(null);
        try {
            const { blob, filename } = await this.client.getBlob('/api/cd/art/backup');
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename ?? 'musicbox-cd-covers.tar.gz';
            link.click();
            // Revoked late: Safari starts the download after click() returns.
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.phase.set('idle');
        }
    }

    protected async restore(input: HTMLInputElement): Promise<void> {
        const chosen = input.files?.[0] ?? null;
        // Cleared so choosing the same file again still fires a change.
        input.value = '';
        if (!chosen) return;
        this.phase.set('uploading');
        this.error.set(null);
        this.restored.set(null);
        try {
            const { restored } = await this.client.postBlob<CdArtRestoreResponse>(
                '/api/cd/art/restore',
                chosen,
                BACKUP_CONTENT_TYPE,
            );
            this.restored.set(restored);
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.phase.set('idle');
        }
    }
}
