import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { IDLE_OPTIONS, Preferences } from '../../../../services/preferences';
import { SettingSelect } from '../setting-select/setting-select';
import { SettingSwitch } from '../setting-switch/setting-switch';

/** The Interface tab: what the screen does on its own after a button is pressed. */
@Component({
    selector: 'app-interface-settings',
    imports: [SettingSelect, SettingSwitch],
    template: `
        <h2 class="text-lg font-semibold">Interface</h2>
        <div class="flex flex-col pt-1">
            <app-setting-switch
                label="Open “Now Playing” when playing album"
                [checked]="prefs.openNowPlayingOnPlay()"
                (toggled)="prefs.set('openNowPlayingOnPlay', $event)" />
            <app-setting-switch
                label="Open “Playlist” when queueing album"
                [checked]="prefs.openQueueOnAdd()"
                (toggled)="prefs.set('openQueueOnAdd', $event)" />
            <app-setting-select
                label="Open “Now Playing” after idle"
                [value]="prefs.openNowPlayingAfterIdle()"
                [options]="idleOptions"
                (selected)="prefs.set('openNowPlayingAfterIdle', $event)" />
        </div>
        <p class="pt-3 text-[0.85rem] text-muted">
            Saved on this device, so the panel and a phone can differ.
        </p>
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InterfaceSettings {
    protected readonly prefs = inject(Preferences);
    protected readonly idleOptions = IDLE_OPTIONS;
}
