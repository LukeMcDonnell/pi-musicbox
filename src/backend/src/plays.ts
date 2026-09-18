/**
 * What the box has played. Per box, so it lives in the database and reaches
 * clients on the stream, as favourites do.
 *
 * ONE ROW PER SONG, NOT PER PLAY — a count and the last time. The screens show
 * albums, which is the GROUP BY below; the table is the scrobble log that also
 * answers most-played track or artist later without a second migration.
 *
 * What decides that a track played at all is play-watch.ts. This module only
 * stores what it is told.
 */

import { RECENT_PLAYS_LIMIT, type RecentPlayAlbum } from '../../shared/api.ts';
import type { Db } from './db.ts';

export type PlaysListener = (albums: RecentPlayAlbum[]) => void;

/** One track, as the watcher saw it. Everything but the file may be untagged. */
export interface TrackPlay {
    file: string;
    title?: string;
    artist?: string;
    album?: string;
    albumArtist?: string;
    image: string | null;
}

export interface Plays {
    /** Albums, most recently played first. */
    recentAlbums(limit: number): RecentPlayAlbum[];
    /** Record one play: a new row, or a bump of the count and the timestamp. */
    record(play: TrackPlay): void;
    onChange(listener: PlaysListener): () => void;
}

interface AlbumRow {
    album_artist: string;
    album: string;
    image: string | null;
    played_at: number;
    plays: number;
}

export function createPlays(db: Db, now: () => number = Date.now): Plays {
    const listeners = new Set<PlaysListener>();

    const recentAlbums = (limit: number): RecentPlayAlbum[] => {
        /*
          `image` is a bare column beside MAX(), which SQLite answers from the row
          that supplied the maximum — so the art is the most recently played
          track's, which for a multi-disc album is the right disc. That is a
          documented SQLite guarantee, not an accident; do not "fix" it into a
          subquery.

          Albums missing either tag are left out, as the library screens do: one
          that cannot be opened is not one to offer.
        */
        return db
            .all<AlbumRow>(
                'SELECT album_artist, album, image, MAX(last_played) AS played_at, ' +
                    'SUM(play_count) AS plays FROM track_play ' +
                    'WHERE album IS NOT NULL AND album_artist IS NOT NULL ' +
                    'GROUP BY album_artist, album ORDER BY played_at DESC, album_artist, album LIMIT ?',
                Math.max(0, Math.trunc(limit)),
            )
            .map((row) => ({
                album: row.album,
                albumArtist: row.album_artist,
                image: row.image,
                playedAt: row.played_at,
                plays: row.plays,
            }));
    };

    return {
        recentAlbums,
        record(play) {
            // The tags are rewritten on conflict, so a retag corrects the row the
            // next time that song plays.
            db.run(
                'INSERT INTO track_play ' +
                    '(file, title, artist, album, album_artist, image, play_count, last_played) ' +
                    'VALUES (?, ?, ?, ?, ?, ?, 1, ?) ' +
                    'ON CONFLICT(file) DO UPDATE SET ' +
                    'play_count = play_count + 1, last_played = excluded.last_played, ' +
                    'title = excluded.title, artist = excluded.artist, album = excluded.album, ' +
                    'album_artist = excluded.album_artist, image = excluded.image',
                play.file,
                play.title ?? null,
                play.artist ?? null,
                play.album ?? null,
                play.albumArtist ?? null,
                play.image,
                now(),
            );
            // Listeners are the stream, which hands its clients the whole list.
            const albums = recentAlbums(RECENT_PLAYS_LIMIT);
            for (const listener of listeners) listener(albums);
        },
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
