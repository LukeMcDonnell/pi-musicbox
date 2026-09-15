/**
 * Restart and shutdown.
 *
 * THIS PROCESS CANNOT DO EITHER, and that is deliberate rather than an
 * obstacle. The unit runs with `NoNewPrivileges=yes` and a capability set of
 * exactly `CAP_NET_BIND_SERVICE`, so `sudo` inside it is dead on arrival; and
 * the backend has no `child_process` anywhere by design — the rule that makes
 * "a bug in the server cannot make the audio wrong" true, and which the test
 * suite asserts. See .claude/docs/bluetooth.md.
 *
 * So the server asks, and root acts: it creates an empty file and
 * `musicbox-power.path` starts `/usr/local/bin/musicbox-power`, which removes it
 * and calls systemctl. The same `.path` + oneshot shape install/setup-server.sh
 * already uses to restart the server after a deploy.
 *
 * THE REQUEST IS THE FILE NAME. `restart` or `shutdown`, nothing else, so there
 * is no verb to parse and nothing an HTTP client could smuggle through. The
 * Bluetooth control FIFO does carry a word and therefore has to police a closed
 * set at both ends; this needs neither.
 *
 * The directory is on /run, which is tmpfs: a request that survived a power cut
 * would shut the box down again at every boot.
 */

import { access, writeFile, constants as fsConstants } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_POWER_DIR = '/run/musicbox-power';

export const POWER_ACTIONS = ['restart', 'shutdown'] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];

export function isPowerAction(value: string): value is PowerAction {
    return (POWER_ACTIONS as readonly string[]).includes(value);
}

/** Thrown when the box has no power helper installed. */
export class PowerUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PowerUnavailableError';
    }
}

export interface Power {
    /** Whether the request directory exists — false on a dev machine. */
    available(): Promise<boolean>;
    /** Ask root to act. Resolves once the request is written, not once it happens. */
    request(action: PowerAction): Promise<void>;
}

export function createPower(dir: string = DEFAULT_POWER_DIR): Power {
    return {
        async available(): Promise<boolean> {
            try {
                await access(dir, fsConstants.W_OK);
                return true;
            } catch {
                return false;
            }
        },
        async request(action: PowerAction): Promise<void> {
            try {
                // Empty: everything the helper needs to know is the name. 'wx'
                // would fail on a second press while the first is still pending,
                // and a user pressing twice means the same thing twice.
                await writeFile(join(dir, action), '');
            } catch (err) {
                const reason = (err as NodeJS.ErrnoException).code ?? 'unknown error';
                throw new PowerUnavailableError(
                    `cannot request ${action}: ${reason} — is setup-server.sh installed?`,
                );
            }
        },
    };
}
