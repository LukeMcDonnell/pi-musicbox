/**
 * Favourite albums. Per box, so they live in the database and reach clients on
 * the stream. Why not MPD stickers: see .claude/docs/decisions.md.
 */

import type { AlbumSummary, FavouriteAlbum } from '../../shared/api.ts';
import type { Db } from './db.ts';

export type FavouritesListener = (albums: FavouriteAlbum[]) => void;

export interface Favourites {
    /** Every favourite, most recently added first. */
    all(): FavouriteAlbum[];
    /** Idempotent: a second add keeps the original `addedAt`. */
    add(summary: AlbumSummary): FavouriteAlbum[];
    /** Idempotent, and needs no MPD — the album may have left the library. */
    remove(release: string): FavouriteAlbum[];
    /** Replace the stored summary of an existing favourite; a no-op otherwise. */
    refresh(summary: AlbumSummary): void;
    onChange(listener: FavouritesListener): () => void;
}

interface Row {
    album_artist: string;
    album: string;
    release: string;
    added_at: number;
    summary: string;
}

/** A stored row back into a favourite, or undefined when it cannot be trusted. */
export function parseFavourite(row: Row): FavouriteAlbum | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(row.summary);
    } catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const s = parsed as Partial<AlbumSummary>;
    // The key columns are the identity; a summary claiming another album is corrupt.
    if (s.albumArtist !== row.album_artist || s.album !== row.album) return undefined;
    if (typeof s.trackCount !== 'number' || !Array.isArray(s.genres)) return undefined;
    return {
        ...(s as AlbumSummary),
        // FROM THE ROW, NOT THE COPY. `summary` is a denormalised AlbumSummary
        // that predates this column on every favourite made before releases
        // existed; requiring it to carry one made 411 of 412 favourites vanish
        // from the screen while sitting intact in the table.
        release: row.release,
        date: typeof s.date === 'string' ? s.date : null,
        duration: typeof s.duration === 'number' ? s.duration : null,
        discCount: typeof s.discCount === 'number' ? s.discCount : 1,
        image: typeof s.image === 'string' ? s.image : null,
        addedAt: row.added_at,
    };
}

export function createFavourites(db: Db, now: () => number = Date.now): Favourites {
    const listeners = new Set<FavouritesListener>();

    const all = (): FavouriteAlbum[] => {
        const rows = db.all<Row>(
            'SELECT album_artist, album, release, added_at, summary FROM favourite_album ' +
                'ORDER BY added_at DESC, album_artist, album',
        );
        const albums: FavouriteAlbum[] = [];
        for (const row of rows) {
            const favourite = parseFavourite(row);
            if (favourite !== undefined) albums.push(favourite);
        }
        return albums;
    };

    const changed = (): FavouriteAlbum[] => {
        const albums = all();
        for (const listener of listeners) listener(albums);
        return albums;
    };

    return {
        all,
        add(summary) {
            const exists = db.get(
                'SELECT 1 AS one FROM favourite_album WHERE release = ?',
                summary.release,
            );
            if (exists !== undefined) return all();
            db.run(
                'INSERT INTO favourite_album (album_artist, album, release, added_at, summary) ' +
                    'VALUES (?, ?, ?, ?, ?)',
                summary.albumArtist,
                summary.album,
                summary.release,
                now(),
                JSON.stringify(summary),
            );
            return changed();
        },
        remove(release) {
            const exists = db.get('SELECT 1 AS one FROM favourite_album WHERE release = ?', release);
            if (exists === undefined) return all();
            db.run('DELETE FROM favourite_album WHERE release = ?', release);
            return changed();
        },
        refresh(summary) {
            const row = db.get<{ summary: string }>(
                'SELECT summary FROM favourite_album WHERE release = ?',
                summary.release,
            );
            const json = JSON.stringify(summary);
            if (row === undefined || row.summary === json) return;
            db.run(
                'UPDATE favourite_album SET album_artist = ?, album = ?, summary = ? WHERE release = ?',
                summary.albumArtist,
                summary.album,
                json,
                summary.release,
            );
            changed();
        },
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
