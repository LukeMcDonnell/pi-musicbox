/**
 * Configuration.
 *
 * Precedence: environment > /etc/musicbox/server.conf > defaults.
 *
 * The conf file is the same shell-style KEY="value" format setup-kiosk.sh uses
 * for kiosk.conf, so the two look alike on the device and both can be sourced
 * by a shell if needed. Environment wins so the dev loop can point a locally
 * running backend at the Pi's MPD without editing anything:
 *
 *     MUSICBOX_MPD_HOST=192.168.1.91 node backend/server.js
 */

import { readFileSync } from 'node:fs';

export interface Config {
    port: number;
    host: string;
    mpdHost: string;
    mpdPort: number;
    mpdConnectTimeoutMs: number;
    webRoot: string;
    /**
     * Root of the music library on disk, used ONLY to find cover art.
     *
     * MUST match `music_directory` in install/setup-mpd.sh — if the two drift,
     * every art request 404s and nothing else misbehaves, which is a miserable
     * thing to debug. tests/test-server-config.sh asserts they agree.
     */
    musicRoot: string;
    /**
     * The file install/setup-bluetooth.sh's arbiter publishes the connected
     * device to. Absent is the normal state on a dev machine and on a box where
     * setup-bluetooth.sh has not been run; see src/backend/src/bluetooth.ts.
     */
    bluetoothState: string;
    /**
     * The FIFO the arbiter reads playback commands from. Writing to it is the
     * only way this service reaches Bluetooth; see src/backend/src/bluetooth.ts
     * for why it is a FIFO and not a subprocess.
     */
    bluetoothControl: string;
    /**
     * The SQLite file holding the box's own state — settings now, favourites
     * and recent plays later.
     *
     * NOT under the deploy directory: tools/dev-push.sh rsyncs backend/ with
     * --delete, so a database there would be erased by the next deploy.
     * /var/lib is persistent where /tmp and /var/log are tmpfs (setup.sh), and
     * install/setup-server.sh creates this one owned by the app user.
     */
    dbPath: string;
    /**
     * Where a restart or shutdown request is dropped for the root path unit to
     * pick up. On tmpfs deliberately — see src/backend/src/power.ts.
     */
    powerDir: string;
    /** MPD's state_file, tag_cache and playlists. Must match install/setup-mpd.sh. */
    mpdStateDir: string;
    /** Where a validated restore is staged for the root helper. On tmpfs, like powerDir. */
    restoreDir: string;
    logLevel: string;
}

export const DEFAULT_CONF_PATH = '/etc/musicbox/server.conf';

export const DEFAULTS: Config = {
    port: 80,
    host: '0.0.0.0',
    mpdHost: '127.0.0.1',
    mpdPort: 6600,
    mpdConnectTimeoutMs: 5000,
    webRoot: '/home/musicbox/musicbox/frontend',
    musicRoot: '/srv/music/Music',
    bluetoothState: '/run/musicbox/bluetooth.json',
    bluetoothControl: '/run/musicbox/control',
    dbPath: '/var/lib/musicbox/data/musicbox.db',
    powerDir: '/run/musicbox-power',
    mpdStateDir: '/var/lib/mpd',
    restoreDir: '/run/musicbox-restore',
    logLevel: 'info',
};

/**
 * Parse shell-style KEY=value / KEY="value" lines, ignoring comments and
 * anything that is not a simple assignment. Deliberately not a shell: no
 * expansion, no substitution, no execution.
 */
export function parseConf(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
            (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
        ) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

function intOr(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(
    confPath: string = DEFAULT_CONF_PATH,
    env: NodeJS.ProcessEnv = process.env,
): Config {
    let fileValues: Record<string, string> = {};
    try {
        fileValues = parseConf(readFileSync(confPath, 'utf8'));
    } catch {
        // Absent or unreadable conf is fine — defaults plus env still work, which
        // is what lets the backend run on a dev machine with no /etc/musicbox.
    }

    const pick = (key: string): string | undefined => env[key] ?? fileValues[key];

    return {
        port: intOr(pick('MUSICBOX_PORT'), DEFAULTS.port),
        host: pick('MUSICBOX_HOST') ?? DEFAULTS.host,
        mpdHost: pick('MUSICBOX_MPD_HOST') ?? DEFAULTS.mpdHost,
        mpdPort: intOr(pick('MUSICBOX_MPD_PORT'), DEFAULTS.mpdPort),
        mpdConnectTimeoutMs: intOr(
            pick('MUSICBOX_MPD_TIMEOUT_MS'),
            DEFAULTS.mpdConnectTimeoutMs,
        ),
        webRoot: pick('MUSICBOX_WEB_ROOT') ?? DEFAULTS.webRoot,
        musicRoot: pick('MUSICBOX_MUSIC_ROOT') ?? DEFAULTS.musicRoot,
        bluetoothState: pick('MUSICBOX_BLUETOOTH_STATE') ?? DEFAULTS.bluetoothState,
        bluetoothControl: pick('MUSICBOX_BLUETOOTH_CONTROL') ?? DEFAULTS.bluetoothControl,
        dbPath: pick('MUSICBOX_DB') ?? DEFAULTS.dbPath,
        powerDir: pick('MUSICBOX_POWER_DIR') ?? DEFAULTS.powerDir,
        mpdStateDir: pick('MUSICBOX_MPD_STATE_DIR') ?? DEFAULTS.mpdStateDir,
        restoreDir: pick('MUSICBOX_RESTORE_DIR') ?? DEFAULTS.restoreDir,
        logLevel: pick('MUSICBOX_LOG_LEVEL') ?? DEFAULTS.logLevel,
    };
}
