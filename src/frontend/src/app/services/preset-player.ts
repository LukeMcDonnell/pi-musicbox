import { Injectable, inject, signal } from '@angular/core';
import type { GeneratorPreset } from '@musicbox/shared';
import { GeneratorClient } from './generator-client';
import { NowPlayingSheet } from './now-playing-sheet';
import { Preferences } from './preferences';

/** Plays presets for Home and Playlists, so a slow first build shows on whichever is open. */
@Injectable({ providedIn: 'root' })
export class PresetPlayer {
    private readonly client = inject(GeneratorClient);
    private readonly prefs = inject(Preferences);
    private readonly sheet = inject(NowPlayingSheet);

    /** The id of the preset starting, if any. */
    readonly busy = signal<string | null>(null);
    readonly error = signal<string | null>(null);

    async play(preset: GeneratorPreset): Promise<void> {
        if (this.busy() !== null) return;
        this.busy.set(preset.id);
        this.error.set(null);
        try {
            await this.client.playPreset(preset, this.prefs.generatorLength());
            if (this.prefs.openNowPlayingOnPlay()) this.sheet.show();
        } catch (err) {
            this.error.set(`${preset.name}: ${(err as Error).message}`);
        } finally {
            this.busy.set(null);
        }
    }
}
