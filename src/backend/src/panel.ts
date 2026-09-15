/**
 * The panel's backlight.
 *
 * WHY THE BACKLIGHT AND NOT DPMS — the one thing to read before changing this.
 *
 *   .claude/docs/clock-deadlock.md names the stack that hard-locked this board:
 *   vc4_atomic_commit_tail -> clk_set_min_rate -> clk_prepare_lock. Anything
 *   that disables the output — a compositor blank, wlr-output-power-management,
 *   a DRM mode-off — issues exactly that atomic commit. `vcgencmd display_power`
 *   is the same VideoCore firmware mailbox from a shell, which is the other half
 *   of the same fault. The governor fix is explicitly NOT proven to cover a
 *   vc4/v3d-only deadlock, so a feature that toggles display power on a timer
 *   would be aiming at the unresolved gap.
 *
 *   Writing `brightness` does none of that. On this panel the backlight is an
 *   i2c device (`rpi_touchscreen_attiny`, measured on the box), so the write
 *   goes to the ATtiny on the display board. Scanout keeps running, the mode is
 *   untouched, nothing enters the clock path. It saves the LED and not the GPU,
 *   which is the trade this box wants.
 *
 * NO ROOT, NO ARBITER. `brightness` is 0664 root:video and the service's user is
 * in `video`; /sys is rw in its namespace even with ProtectKernelTunables=yes.
 * Measured before this was written, so unlike Bluetooth there is no privileged
 * helper here to keep in step — see .claude/docs/bluetooth.md for when that IS
 * needed.
 *
 * `bl_power` is 0644 root:root and therefore not an option.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BACKLIGHT_ROOT = '/sys/class/backlight';

export interface PanelDeps {
    /** Where the backlight devices live. Tests point this at a temp directory. */
    root: string;
    readFile: (path: string) => string;
    writeFile: (path: string, data: string) => void;
    listDir: (path: string) => string[];
}

export const defaultPanelDeps: PanelDeps = {
    root: BACKLIGHT_ROOT,
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, data) => writeFileSync(path, data),
    listDir: (path) => readdirSync(path),
};

export interface Panel {
    /** False wherever there is no backlight — every dev machine. */
    readonly supported: boolean;
    /** True when lit. Always true when unsupported: nothing is being hidden. */
    isOn(): boolean;
    /** Returns false when unsupported or the write failed. */
    set(on: boolean): boolean;
}

export interface PanelOptions {
    /** An explicit device path, from MUSICBOX_BACKLIGHT. */
    device?: string;
    deps?: Partial<PanelDeps>;
    onError?: (err: Error) => void;
}

/**
 * Find the backlight, if there is one.
 *
 * The device is discovered rather than hardcoded: this box calls it `10-0045`
 * (its i2c address), which is a fact about the bus and not something to bake
 * into the server. The first entry is taken — there is one panel, and a box with
 * two has bigger questions than which to dim.
 */
function findDevice(deps: PanelDeps, explicit?: string): string | null {
    if (explicit) return explicit;
    try {
        const entries = deps.listDir(deps.root).sort();
        return entries.length > 0 ? join(deps.root, entries[0]!) : null;
    } catch {
        return null; // no /sys/class/backlight at all
    }
}

export function createPanel(options: PanelOptions = {}): Panel {
    const deps: PanelDeps = { ...defaultPanelDeps, ...options.deps };
    const device = findDevice(deps, options.device);

    let max = 0;
    if (device !== null) {
        try {
            max = Number.parseInt(deps.readFile(join(device, 'max_brightness')).trim(), 10);
        } catch {
            max = 0;
        }
    }

    // A device with no readable max_brightness is not one we can restore from,
    // and half-working here means a screen nobody can light again.
    const supported = device !== null && Number.isFinite(max) && max > 0;

    const read = (): number | null => {
        if (!supported) return null;
        try {
            const raw = deps.readFile(join(device!, 'brightness')).trim();
            const value = Number.parseInt(raw, 10);
            return Number.isFinite(value) ? value : null;
        } catch (err) {
            options.onError?.(err as Error);
            return null;
        }
    };

    return {
        supported,
        isOn(): boolean {
            if (!supported) return true;
            const value = read();
            // Unreadable: say it is on. The alternative is a UI that reports a
            // dark screen while you are looking at a lit one.
            return value === null ? true : value > 0;
        },
        set(on: boolean): boolean {
            if (!supported) return false;
            try {
                deps.writeFile(join(device!, 'brightness'), String(on ? max : 0));
                return true;
            } catch (err) {
                options.onError?.(err as Error);
                return false;
            }
        },
    };
}
