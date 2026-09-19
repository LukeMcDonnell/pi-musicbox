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

import {
    RECENT_PLAYS_LIMIT,
    type MostPlayedArtist,
    type RecentPlayAlbum,
} from '../../shared/api.ts';
import { artUriForDir } from './art.ts';
import type { Db } from './db.ts';
import { artistDirOf } from './library.ts';

export type PlaysListener = (albums: RecentPlayAlbum[]) => void;

/** One track, as the watcher saw it. Everything but the file may be untagged. */
export interface TrackPlay {
    file: string;
    title?: string;
    artist?: string;
    album?: string;
    albumArtist?: string;
    /** Which release, as AlbumIdentity spells it. Absent for a track with no id tag. */
    release?: string;
    image: string | null;
}

export interface Plays {
    /** Albums, most recently played first. */
    recentAlbums(limit: number): RecentPlayAlbum[];
    /** Artists, most played first, all time. */
    mostPlayedArtists(limit: number): MostPlayedArtist[];
    /** Record one play: a new row, or a bump of the count and the timestamp. */
    record(play: TrackPlay): void;
    onChange(listener: PlaysListener): () => void;
}

interface AlbumRow {
    album_artist: string;
    album: string;
    release: string;
    image: string | null;
    played_at: number;
    plays: number;
}

interface ArtistRow {
    album_artist: string;
    file: string;
    plays: number;
    played_at: number;
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

          Albums missing any of the three are left out, as the library screens do:
          one that cannot be opened is not one to offer. That includes every row
          written before the release column existed — see the v7 migration.

          GROUPED BY RELEASE, not by the tag pair, so Weezer's four self-titled
          records are four shelf cards and not one.
        */
        return db
            .all<AlbumRow>(
                'SELECT album_artist, album, release, image, MAX(last_played) AS played_at, ' +
                    'SUM(play_count) AS plays FROM track_play ' +
                    'WHERE album IS NOT NULL AND album_artist IS NOT NULL AND release IS NOT NULL ' +
                    'GROUP BY release ORDER BY played_at DESC, album_artist, album LIMIT ?',
                Math.max(0, Math.trunc(limit)),
            )
            .map((row) => ({
                album: row.album,
                albumArtist: row.album_artist,
                release: row.release,
                image: row.image,
                playedAt: row.played_at,
                plays: row.plays,
            }));
    };

    const mostPlayedArtists = (limit: number): MostPlayedArtist[] => {
        /*
          `file` is the bare column beside MAX() here, on the same SQLite
          guarantee `recentAlbums` uses for `image` — it is the most recently
          played track's, and all that is wanted from it is the artist directory.
          MAX(last_played) does NOT order this list: the ranking is the SUM, and
          ties go alphabetically so a `limit` cuts the same place twice.

          GROUP BY album_artist rides the leading column of track_play_album, so
          there is no index to add. Untagged artists are left out, as the album
          list leaves out untagged albums: one that cannot be opened is not one
          to offer.
        */
        return db
            .all<ArtistRow>(
                'SELECT album_artist, file, SUM(play_count) AS plays, ' +
                    'MAX(last_played) AS played_at FROM track_play ' +
                    'WHERE album_artist IS NOT NULL ' +
                    'GROUP BY album_artist ORDER BY plays DESC, album_artist LIMIT ?',
                Math.max(0, Math.trunc(limit)),
            )
            .map((row) => {
                // Null rather than a guessed URI for a file at the library root,
                // as artistImageOf does — see library.ts.
                const dir = artistDirOf(row.file);
                return {
                    name: row.album_artist,
                    image: dir === '' ? null : artUriForDir(dir),
                    plays: row.plays,
                };
            });
    };

    return {
        recentAlbums,
        mostPlayedArtists,
        record(play) {
            // The tags are rewritten on conflict, so a retag corrects the row the
            // next time that song plays.
            db.run(
                'INSERT INTO track_play ' +
                    '(file, title, artist, album, album_artist, release, image, play_count, last_played) ' +
                    'VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?) ' +
                    'ON CONFLICT(file) DO UPDATE SET ' +
                    'play_count = play_count + 1, last_played = excluded.last_played, ' +
                    'title = excluded.title, artist = excluded.artist, album = excluded.album, ' +
                    'album_artist = excluded.album_artist, release = excluded.release, ' +
                    'image = excluded.image',
                play.file,
                play.title ?? null,
                play.artist ?? null,
                play.album ?? null,
                play.albumArtist ?? null,
                play.release ?? null,
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
