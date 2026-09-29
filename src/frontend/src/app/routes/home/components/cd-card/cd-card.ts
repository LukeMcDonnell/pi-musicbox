import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideDisc3, LucideEject, LucidePlay } from '@lucide/angular';
import { MusicboxApi } from '../../../../services/musicbox-api';
import { CoverArt } from '../../../../components/cover-art/cover-art';

/** An audio CD is in the drive: play it, or eject it. Absent without one. */
@Component({
    selector: 'app-cd-card',
    imports: [CoverArt, LucideDisc3, LucideEject, LucidePlay],
    templateUrl: './cd-card.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CdCard {
    private readonly api = inject(MusicboxApi);

    readonly cd = this.api.cd;
    readonly playing = computed(() => this.api.snapshot()?.source === 'cd');
    readonly error = signal<string | null>(null);
    readonly coverFailed = signal<string | null>(null);

    readonly cover = computed(() => {
        const image = this.cd()?.image;
        if (!image) return null;
        const uri = this.api.resolve(image);
        return uri === this.coverFailed() ? null : uri;
    });

    /** "Pearl Jam · 1991", from the lookup; null for a disc nobody has named. */
    readonly byline = computed(() => {
        const cd = this.cd();
        const year = cd?.date?.slice(0, 4);
        return [cd?.artist, year].filter(Boolean).join(' · ') || null;
    });

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
