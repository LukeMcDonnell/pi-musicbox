import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ApiClient } from './api-client';
import { IdleTimer } from './idle-timer';
import { IS_PANEL } from './panel-client';
import { MusicboxApi } from './musicbox-api';

/*
  Turns the panel's backlight off when the box has been left alone, and back on
  when anybody touches it or the music starts.

  THE PANEL'S OWN BROWSER OWNS THIS, and that is the design rather than an
  accident. It is the only thing that sees a touch ON THE PANEL — a phone tapping
  about is not someone standing at the box — and it already holds the snapshot,
  so "is anything playing" costs nothing to ask. The backend is a dumb actuator
  behind POST /api/panel/backlight; it could not run this timer without the
  browser telling it about every touch.

  Nothing happens anywhere else: IS_PANEL is false on a phone and on ng serve, so
  this service constructs and then does nothing at all.

  THE RULE, EXACTLY: no touches for the configured delay AND nothing playing.
  `state === 'play'` is the source-independent answer (src/shared/api.ts), so a
  phone playing over Bluetooth keeps the screen awake with no special case. The
  idle clock counts touches only — so when a long album ends with nobody in the
  room, the delay has already elapsed and the screen goes dark at once.

  WAKING IS UNCONDITIONAL. Any touch, and any transition into playing, turns the
  backlight on. That direction never asks permission: a screen that will not come
  back is the failure worth avoiding, and the server restores it too whenever this
  page's stream drops (see routes.ts).
*/
@Injectable({ providedIn: 'root' })
export class PanelSleep {
    private readonly isPanel = inject(IS_PANEL);
    private readonly api = inject(MusicboxApi);
    private readonly client = inject(ApiClient);
    private readonly idle = inject(IdleTimer);

    private readonly _asleep = signal(false);

    /**
     * Whether the backlight is off, as far as this page knows.
     *
     * The app shows an overlay while it is true, so the touch that wakes the
     * screen does not also press whatever was underneath it.
     */
    readonly asleep = this._asleep.asReadonly();

    /** Minutes, from the box's settings. 0 is never. */
    private readonly minutes = computed(() => this.api.settings()?.panelSleepAfterMinutes ?? 0);

    private readonly playing = computed(() => this.api.snapshot()?.state === 'play');

    /** One request at a time, so a flurry of touches cannot stack them up. */
    private sending = false;
    /** What the backlight should be once the one in flight has landed. */
    private desired: boolean | null = null;

    constructor() {
        if (!this.isPanel) return;

        const watcher = this.idle.watch(this.minutes(), () => this.sleep());
        effect(() => watcher.setMinutes(this.minutes()));

        // Music starting is the other way the screen comes back. Only the
        // transition matters — while it plays there is nothing to do, and the
        // timer is not armed against playback in the first place.
        effect(() => {
            if (this.playing() && this._asleep()) this.wake();
        });
    }

    /**
     * Called by the app on any interaction while asleep.
     *
     * IdleTimer's own listeners re-arm the timer, but they cannot wake the
     * screen: waking is a request, and it must happen on the first touch rather
     * than at the end of the next idle period.
     */
    wake(): void {
        if (!this.isPanel || !this._asleep()) return;
        this._asleep.set(false);
        this.idle.poke();
        void this.send(true);
    }

    private sleep(): void {
        // Re-checked here and not only when the timer was armed: the delay may
        // have passed while a record was playing.
        if (this.playing() || this.minutes() <= 0 || this._asleep()) return;
        this._asleep.set(true);
        void this.send(false);
    }

    /**
     * Ask the box for a backlight state, coalescing rather than dropping.
     *
     * A plain in-flight guard would be a bug with teeth: touch the panel while
     * the sleep request is still going and the wake would be discarded, leaving
     * a dark screen that no further touch fixes — every one of them would find
     * the page already awake and send nothing. So the latest wanted state is
     * remembered and sent when the current request finishes.
     */
    private async send(on: boolean): Promise<void> {
        this.desired = on;
        if (this.sending) return;
        this.sending = true;
        try {
            while (this.desired !== null) {
                const next = this.desired;
                this.desired = null;
                try {
                    await this.client.post('/api/panel/backlight', { on: next });
                } catch {
                    // The box may have no backlight, or may have refused because
                    // it thinks no panel is connected. Either way the screen is
                    // lit, so believing otherwise would leave an invisible
                    // blocker over a working UI.
                    if (!next) this._asleep.set(false);
                }
            }
        } finally {
            this.sending = false;
        }
    }
}
