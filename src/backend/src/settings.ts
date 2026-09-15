/**
 * The box's settings.
 *
 * THE BOX'S, NOT THE DEVICE'S — and that line is the whole reason this exists
 * beside the frontend's own Preferences service. A preference like "open Now
 * Playing when I press Play" describes the screen in front of you, and the panel
 * and a phone are entitled to different answers, so it lives in that browser's
 * localStorage. A setting like "blank the panel after ten minutes" describes a
 * piece of hardware attached to the box; there is exactly one panel, and you
 * want to change it from the sofa. That one belongs here.
 *
 * Values are TEXT in the table and typed here, because the meaning of a setting
 * is this file's business and SQLite's opinion of `5` is not useful.
 *
 * EVERY READ GOES THROUGH A GUARD, for the same reason the frontend's do: the
 * row may have been written by an older build, by a newer one, or by someone
 * with sqlite3 and an idea. An unreadable setting falls back to its default
 * rather than taking the box down.
 */

import type { Db } from './db.ts';
import { PANEL_SLEEP_MINUTES } from '../../shared/api.ts';

export interface SettingsValues {
    /**
     * Minutes of no interaction before the panel's backlight goes off, or 0 for
     * never. Only ever applied while nothing is playing — see panel-sleep on the
     * frontend, which owns the timer because it is the thing that sees touches.
     */
    panelSleepAfterMinutes: number;
}

export const SETTINGS_DEFAULTS: Readonly<SettingsValues> = {
    // Never. A screen that goes dark on its own while nobody asked it to is a
    // box that looks broken, so this is opted into.
    panelSleepAfterMinutes: 0,
};

/** One per key, and the only way a stored row becomes a setting. */
const GUARDS: { [K in keyof SettingsValues]: (value: string) => SettingsValues[K] | undefined } = {
    panelSleepAfterMinutes: (value) => {
        // The WHOLE string must be digits. parseInt would read '7.5' as 7 and
        // '' as NaN-but-for-the-grace-of-Number, and 7 is on the list — so a
        // malformed row would quietly become a working setting.
        if (!/^\d+$/.test(value)) return undefined;
        const minutes = Number(value);
        // Only what the UI offers. A delay of 12, or of 4000, is not a value
        // this can hold however it came to be in the table.
        return PANEL_SLEEP_MINUTES.includes(minutes) ? minutes : undefined;
    },
};

export type SettingsListener = (values: SettingsValues) => void;

export interface Settings {
    /** Every setting, defaults filled in. */
    all(): SettingsValues;
    /** Write one. Returns the full set, as the SSE event and the response want it. */
    set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]): SettingsValues;
    /** Called after any successful write. */
    onChange(listener: SettingsListener): () => void;
}

export const SETTING_KEYS = Object.keys(SETTINGS_DEFAULTS) as (keyof SettingsValues)[];

export function isSettingKey(key: string): key is keyof SettingsValues {
    return (SETTING_KEYS as string[]).includes(key);
}

/**
 * Validate an untrusted value for a key, returning undefined if it is not one.
 *
 * Exported because the route needs exactly this before it writes, and a second
 * copy of the rules in routes.ts is how the two drift apart.
 */
export function parseSetting<K extends keyof SettingsValues>(
    key: K,
    value: unknown,
): SettingsValues[K] | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'object') return undefined;
    return GUARDS[key](String(value));
}

export function createSettings(db: Db): Settings {
    const listeners = new Set<SettingsListener>();

    const all = (): SettingsValues => {
        const values: SettingsValues = { ...SETTINGS_DEFAULTS };
        const rows = db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
        for (const row of rows) {
            if (!isSettingKey(row.key)) continue; // a key this build retired
            const parsed = parseSetting(row.key, row.value);
            if (parsed !== undefined) values[row.key] = parsed;
        }
        return values;
    };

    return {
        all,
        set(key, value) {
            db.run(
                'INSERT INTO settings (key, value) VALUES (?, ?) ' +
                    'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                key,
                String(value),
            );
            const values = all();
            for (const listener of listeners) listener(values);
            return values;
        },
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
