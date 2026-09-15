import { Injectable, computed, signal } from '@angular/core';
import { PANEL_SLEEP_MINUTES } from '@musicbox/shared';

/** What each setting on the Interface tab is called, and what it means. */
export interface PreferenceValues {
    /** Raise now-playing after Play on an album. */
    openNowPlayingOnPlay: boolean;
    /** Raise now-playing, scrolled to the queue, after Queue on an album. */
    openQueueOnAdd: boolean;
    /** Minutes of no interaction before now-playing raises itself. 0 is never. */
    openNowPlayingAfterIdle: number;
}

/**
 * What the idle setting may be, and what each value is called.
 *
 * ONE LIST, used by the dropdown and by the guard that reads storage back — an
 * option that is not offered here is not a value this can hold. Minutes rather
 * than seconds: the shortest useful answer is "a minute", and anything finer
 * would be a timer that fires while you are still deciding what to play.
 *
 * The delays come from the shared contract, where the panel-sleep setting also
 * takes them. The two settings sit one tab apart and read as a pair; two lists
 * that could drift is how they end up offering different answers to the same
 * question.
 */
export const IDLE_OPTIONS: readonly { value: number; label: string }[] =
    PANEL_SLEEP_MINUTES.map((minutes) => ({
        value: minutes,
        label: minutes === 0 ? 'Never' : minutes === 1 ? '1 minute' : `${minutes} minutes`,
    }));

export const DEFAULTS: Readonly<PreferenceValues> = {
    // On: Play replaces the queue and starts the music, so the screen that
    // describes what is happening is the one you want next.
    openNowPlayingOnPlay: true,
    // Off: Queue is the button you press three times in a row. Jumping away
    // from the album list after each one is the opposite of what it is for.
    openQueueOnAdd: false,
    // Never: a screen that changes on its own while nobody asked is the kind of
    // thing to opt into, not out of.
    openNowPlayingAfterIdle: 0,
};

export const PREFERENCES_KEY = 'musicbox.preferences';

/*
  The user's interface preferences.

  ON THE DEVICE, NOT ON THE BOX. localStorage, not a backend endpoint: these say
  what should happen on the screen in front of you, and the panel and a phone
  are entitled to different answers — the panel is what you walked up to, a
  phone is a remote. It also keeps them out of the API contract, which is about
  what the music is doing. The kiosk's chromium profile is persistent
  (/var/lib/musicbox/chromium, see install/setup-kiosk.sh), so this survives a
  reboot.

  EVERY ACCESS IS GUARDED. localStorage throws in a private window and can be
  cleared under us; stored JSON can be anything, including from an older build.
  An unreadable setting falls back to its default — a preferences screen is not
  worth breaking the app for.
*/
@Injectable({ providedIn: 'root' })
export class Preferences {
    private readonly values = signal<PreferenceValues>(load());

    readonly openNowPlayingOnPlay = computed(() => this.values().openNowPlayingOnPlay);
    readonly openQueueOnAdd = computed(() => this.values().openQueueOnAdd);
    readonly openNowPlayingAfterIdle = computed(() => this.values().openNowPlayingAfterIdle);

    set<K extends keyof PreferenceValues>(key: K, value: PreferenceValues[K]): void {
        this.values.update((values) => ({ ...values, [key]: value }));
        save(this.values());
    }
}

function load(): PreferenceValues {
    let raw: string | null = null;
    try {
        raw = localStorage.getItem(PREFERENCES_KEY);
    } catch {
        return { ...DEFAULTS };
    }
    if (raw === null) return { ...DEFAULTS };
    let stored: unknown;
    try {
        stored = JSON.parse(raw);
    } catch {
        return { ...DEFAULTS };
    }
    // Key by key, through the guards: a stored object from an older build may be
    // missing keys or carry values this build no longer offers, and a spread of
    // whatever parsed would let any of that straight in.
    const values = { ...DEFAULTS };
    if (typeof stored !== 'object' || stored === null) return values;
    const fields = stored as Record<string, unknown>;
    for (const key of Object.keys(DEFAULTS) as (keyof PreferenceValues)[]) {
        const value = fields[key];
        if ((GUARDS[key] as (value: unknown) => boolean)(value)) {
            (values as Record<string, unknown>)[key] = value;
        }
    }
    return values;
}

/** One per key, and the only way a stored value becomes a setting. */
const GUARDS: { [K in keyof PreferenceValues]: (value: unknown) => boolean } = {
    openNowPlayingOnPlay: (value) => typeof value === 'boolean',
    openQueueOnAdd: (value) => typeof value === 'boolean',
    openNowPlayingAfterIdle: (value) => IDLE_OPTIONS.some((option) => option.value === value),
};

function save(values: PreferenceValues): void {
    try {
        localStorage.setItem(PREFERENCES_KEY, JSON.stringify(values));
    } catch {
        // Full, or blocked. The setting still applies for this session.
    }
}
