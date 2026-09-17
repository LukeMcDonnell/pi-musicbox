/**
 * Fixtures for the specs.
 *
 * `boxSettings()` exists so adding a setting is not a change to every spec that
 * happens to need a SettingsResponse: each names the field it cares about and
 * the rest come from here.
 */

import type { LibraryState, SettingsResponse } from '@musicbox/shared';

export function boxSettings(overrides: Partial<SettingsResponse> = {}): SettingsResponse {
    return {
        panelSleepAfterMinutes: 0,
        libraryScanHour: -1,
        libraryScanOnBoot: false,
        ...overrides,
    };
}

export function libraryState(overrides: Partial<LibraryState> = {}): LibraryState {
    return {
        scanning: false,
        scanStartedAt: null,
        scanTrigger: null,
        lastScan: null,
        stats: null,
        musicRoot: '/srv/music/Music',
        musicRootReadable: true,
        nextScanAt: null,
        ...overrides,
    };
}
