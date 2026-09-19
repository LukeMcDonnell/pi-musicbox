/**
 * How a release is named, and how MPD is asked for one.
 *
 * Its own module so `bridge.ts` can mint a release without importing
 * `library.ts`, which imports `bridge.ts` back. See .claude/docs/decisions.md
 * for why the album tag is not the identity.
 */

/**
 * The album's own directory: the FIRST TWO path segments.
 *
 * NOT `albumDirOf`, which is the directory the SONG is in. For the 149 albums
 * that keep their tracks in a `CD 01` subdirectory those two differ, and every
 * `album.nfo` on this library sits at the album level — measured: all 3,262 of
 * them are exactly two segments deep, none beside the discs. So `albumDirOf` is
 * one level too deep for 149 albums and would find nothing for them.
 *
 * Art is the other way round and stays on `albumDirOf`: the cover IS in the disc
 * directory for all 149 (also measured), which is why the two helpers exist
 * rather than one. Empty when the file is not at least two deep.
 */
export function albumNoteDirOf(file: string): string {
    const first = file.indexOf('/');
    if (first === -1) return '';
    const second = file.indexOf('/', first + 1);
    return second === -1 ? '' : file.slice(0, second);
}

/**
 * Which release these tags name, or null when it cannot be told.
 *
 * `MUSICBRAINZ_ALBUMID` where there is one — measured total on this library bar
 * a single album, never spread across two directories, and stable over a
 * multi-disc layout. The directory is the fallback for that one album.
 *
 * Called from `trackFromTags` and nowhere else, so a queue row, an album card
 * and a play row all spell the same release the same way.
 */
export function releaseIdOf(mbAlbumId: string | undefined, file: string | undefined): string | null {
    if (mbAlbumId !== undefined && mbAlbumId !== '') return `mb:${mbAlbumId}`;
    const dir = file === undefined ? '' : albumNoteDirOf(file);
    return dir === '' ? null : `dir:${dir}`;
}

/**
 * A release back into the one MPD filter pair that selects it.
 *
 * The ONLY place the prefix is decoded. Both forms are legacy filter syntax, so
 * `find` and `findadd` stay one command that never enumerates tracks.
 */
export function releaseFilter(release: string): [string, string] {
    return release.startsWith('dir:')
        ? ['base', release.slice(4)]
        : ['MUSICBRAINZ_ALBUMID', release.slice(3)];
}
