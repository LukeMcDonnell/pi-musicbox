import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PANEL_SLEEP_MINUTES } from '@musicbox/shared';
import { ApiClient } from '../../../../services/api-client';
import { MusicboxApi } from '../../../../services/musicbox-api';
import { IS_PANEL } from '../../../../services/panel-client';
import { BackupRestore } from '../backup-restore/backup-restore';
import { SettingSelect, type SettingOption } from '../setting-select/setting-select';

/**
 * The System tab: settings that belong to the BOX rather than to this screen.
 *
 * The Interface tab says "Saved on this device" for exactly the opposite reason.
 * There is one panel, its behaviour should not depend on which phone last looked
 * at it, and you want to change it from the sofa — so these live in the box's
 * database and arrive here over the same SSE stream as everything else.
 */
@Component({
    selector: 'app-system-settings',
    imports: [SettingSelect, BackupRestore],
    template: `
        <h2 class="text-lg font-semibold">System</h2>

        <div class="flex flex-col pt-1">
            <app-setting-select
                label="Turn the panel off after idle"
                [value]="panelSleepAfterMinutes()"
                [options]="sleepOptions"
                (selected)="setPanelSleep($event)" />
        </div>

        @if (error(); as message) {
            <p class="pt-2 text-[0.9rem] text-warn" role="alert">{{ message }}</p>
        }

        <p class="pt-3 text-[0.85rem] text-muted">
            The panel's own screen only, and only while nothing is playing. Touch it,
            or start the music, and it comes back.
        </p>

        @if (!isPanel) {
            <app-backup-restore />
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SystemSettings {
    private readonly api = inject(MusicboxApi);
    private readonly client = inject(ApiClient);
    protected readonly isPanel = inject(IS_PANEL);

    protected readonly sleepOptions: readonly SettingOption[] = PANEL_SLEEP_MINUTES.map(
        (minutes) => ({
            value: minutes,
            label:
                minutes === 0 ? 'Never' : minutes === 1 ? '1 minute' : `${minutes} minutes`,
        }),
    );

    protected readonly error = signal<string | null>(null);

    /**
     * What the box says, or what was just asked for.
     *
     * The pending value wins until the server's own answer arrives, so the
     * dropdown does not snap back to the old value for the length of a round
     * trip. Cleared once the two agree.
     */
    private readonly pending = signal<number | null>(null);

    protected readonly panelSleepAfterMinutes = computed(
        () => this.pending() ?? this.api.settings()?.panelSleepAfterMinutes ?? 0,
    );

    protected async setPanelSleep(minutes: number): Promise<void> {
        this.pending.set(minutes);
        this.error.set(null);
        try {
            await this.client.patchJson('/api/settings', { panelSleepAfterMinutes: minutes });
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            // Either the change landed and the SSE event says so, or it did not
            // and the box's answer is the truth. Both are the server's to state.
            this.pending.set(null);
        }
    }
}
