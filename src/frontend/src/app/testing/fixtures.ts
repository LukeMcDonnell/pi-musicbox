/**
 * Fixtures for the specs.
 *
 * `boxSettings()` exists so adding a setting is not a change to every spec that
 * happens to need a SettingsResponse: each names the field it cares about and
 * the rest come from here.
 */

import type { FavouriteAlbum, LibraryState, SettingsResponse } from '@musicbox/shared';

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

export function favouriteAlbum(overrides: Partial<FavouriteAlbum> = {}): FavouriteAlbum {
    return {
        album: 'Kid A',
        albumArtist: 'Radiohead',
        release: 'mb:kid-a',
        date: '2000-10-02',
        trackCount: 10,
        genres: ['Alternative Rock'],
        discCount: 1,
        duration: 2497,
        image: '/api/art?album=Radiohead%2FKid%20A',
        addedAt: 1000,
        ...overrides,
    };
}
