import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideDisc3, LucideEject, LucidePlay } from '@lucide/angular';
import { MusicboxApi } from '../../../../services/musicbox-api';

/** An audio CD is in the drive: play it, or eject it. Absent without one. */
@Component({
    selector: 'app-cd-card',
    imports: [LucideDisc3, LucideEject, LucidePlay],
    templateUrl: './cd-card.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CdCard {
    private readonly api = inject(MusicboxApi);

    readonly cd = this.api.cd;
    readonly playing = computed(() => this.api.snapshot()?.source === 'cd');
    readonly error = signal<string | null>(null);

    async play(): Promise<void> {
        await this.attempt(() => this.api.playCd());
    }

    async eject(): Promise<void> {
        await this.attempt(() => this.api.ejectCd());
    }

    private async attempt(action: () => Promise<void>): Promise<void> {
        this.error.set(null);
        try {
            await action();
        } catch (err) {
            this.error.set((err as Error).message);
        }
    }
}
