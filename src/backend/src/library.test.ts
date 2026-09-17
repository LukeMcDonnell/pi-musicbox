/**
 * Library browse.
 *
 * The interesting cases here are all ones the real library actually contains and
 * that an obvious-looking implementation gets wrong: a multi-disc album whose
 * tracks both start at 1, an artist whose directory is not their name, an album
 * with no date, and Synology's junk directories. Each of these was measured on
 * the device before it was written down — see the header of library.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    albumsFromSongs,
    artistDirOf,
    artistImageOf,
    createLibrary,
    sortAlbumTracks,
} from './library.ts';
import { songFromTags, trackFromTags } from './mpd/bridge.ts';
import type { LibrarySong, MpdBridge } from './mpd/bridge.ts';
import type { Reply } from './mpd/protocol.ts';
import type { Track } from '../../shared/api.ts';

/** A library Track, built the way the bridge builds one, so `image` is real. */
function song(file: string, tags: Record<string, string> = {}): Track {
    const map = new Map<string, string>([['file', file], ...Object.entries(tags)]);
    const track = trackFromTags(map);
    assert.ok(track, `trackFromTags refused ${file}`);
    return track;
}

/**
 * The same, as the browse path carries it: through the real `songFromTags`, so
 * the multi-value tags behave as MPD sends them. A value may be an array —
 * `Genre` is one on 91% of this library's songs.
 */
function lsong(file: string, tags: Record<string, string | string[]> = {}): LibrarySong {
    const map = new Map<string, string[]>([['file', [file]]]);
    for (const [key, value] of Object.entries(tags)) {
        map.set(key, Array.isArray(value) ? value : [value]);
    }
    const built = songFromTags(map);
    assert.ok(built, `songFromTags refused ${file}`);
    return built;
}

function reply(pairs: Array<[string, string]>): Reply {
    return { pairs };
}

test('the artist directory is the first path segment, not two dirnames', () => {
    assert.equal(artistDirOf('Radiohead/In Rainbows (2007)/01.flac'), 'Radiohead');

    // The case that kills `dirname(dirname(file))`: 149 albums here keep their
    // tracks in a disc subdirectory, and two dirnames would answer with the
    // ALBUM directory. Measured on the device.
    assert.equal(
        artistDirOf('Black Sabbath/13 (2013)/CD 01/01 - End of the Beginning.flac'),
        'Black Sabbath',
    );

    // A file loose at the library root belongs to no artist directory.
    assert.equal(artistDirOf('stray.flac'), '');
});

test('albums are grouped by the Album tag, not by directory', () => {
    // One album, two disc directories. Grouping by directory would show it twice.
    const albums = albumsFromSongs('Blur', [
        lsong('Blur/13 (1999)/CD 01/01.flac', { Album: '13', Date: '1999' }),
        lsong('Blur/13 (1999)/CD 01/02.flac', { Album: '13', Date: '1999' }),
        lsong('Blur/13 (1999)/CD 02/01.flac', { Album: '13', Date: '1999' }),
    ]);
    assert.equal(albums.length, 1);
    assert.equal(albums[0].album, '13');
    assert.equal(albums[0].trackCount, 3);
    assert.equal(albums[0].albumArtist, 'Blur');
    // Art comes from the first track's own directory — the disc directory. All
    // 149 multi-disc albums here carry a cover there, so this is correct rather
    // than merely harmless.
    assert.equal(albums[0].image, '/api/art?album=Blur%2F13%20(1999)%2FCD%2001');
});

test('the release year prefers OriginalDate over the pressing date', () => {
    // 940 of this library's 2,758 albums are remasters whose `Date` is decades
    // after the record. Sorting on `Date` puts AC/DC's whole catalogue in 2020
    // and dates `Back in Black` to 2003.
    const albums = albumsFromSongs('AC/DC', [
        lsong('AC-DC/Back in Black (1980)/01.flac', {
            Album: 'Back in Black',
            Date: '2003-01-01',
            OriginalDate: '1980-07-25',
        }),
        lsong('AC-DC/Black Ice (2008)/01.flac', { Album: 'Black Ice', Date: '2008-10-20' }),
    ]);
    assert.deepEqual(
        albums.map((a) => a.album),
        ['Back in Black', 'Black Ice'],
    );
    assert.equal(albums[0].date, '1980-07-25');
    // Falls back to Date when there is no OriginalDate — 32 albums here.
    assert.equal(albums[1].date, '2008-10-20');
});

test('albums sort oldest first, with undated albums LAST', () => {
    const albums = albumsFromSongs('Radiohead', [
        lsong('a/In Rainbows/01.flac', { Album: 'In Rainbows', Date: '2007-10-10' }),
        lsong('a/Unknown/01.flac', { Album: 'Unknown' }),
        lsong('a/Kid A/01.flac', { Album: 'Kid A', Date: '2000' }),
        lsong('a/The Bends/01.flac', { Album: 'The Bends', Date: '1995' }),
    ]);
    assert.deepEqual(
        albums.map((a) => a.album),
        ['The Bends', 'Kid A', 'In Rainbows', 'Unknown'],
    );
    // Undated is null, not a fabricated year, and it did not sort as year zero —
    // 18 of this library's 2,757 albums have no Date and would otherwise bury
    // every real album on their artist's page.
    assert.equal(albums[3].date, null);
    // A full ISO date is carried through unparsed: `date` is free text on the
    // wire and clients take the leading four digits.
    assert.equal(albums[2].date, '2007-10-10');
});

test('albums released in the same year order by full date, not by title', () => {
    const albums = albumsFromSongs('AC/DC', [
        lsong('a/dd/01.flac', { Album: 'Dirty Deeds', OriginalDate: '1976-09-20' }),
        lsong('a/hv/01.flac', { Album: 'High Voltage', OriginalDate: '1976-05-14' }),
    ]);
    // Alphabetically Dirty Deeds comes first; by release it does not.
    assert.deepEqual(
        albums.map((a) => a.album),
        ['High Voltage', 'Dirty Deeds'],
    );
});

test('a track with no Album tag is filed under nothing rather than under ""', () => {
    const albums = albumsFromSongs('X', [
        lsong('X/a/01.flac', { Album: 'Real' }),
        lsong('X/loose.flac'),
    ]);
    assert.equal(albums.length, 1);
    assert.equal(albums[0].album, 'Real');
    assert.equal(albums[0].trackCount, 1);
});

test('an album keeps EVERY genre, not the last one MPD sent', () => {
    // The real "Burn the Witch" record. A Map keyed by tag name reports
    // "Orchestral" — the last line — for a song tagged Art Rock through
    // Krautrock, and 91% of this library's songs carry more than one Genre.
    const genres = [
        'Art Rock', 'Art Pop', 'Ambient Pop', 'Electronic', 'Alternative Rock',
        'Chamber Pop', 'Indie Rock', 'Rock', 'Post-Rock', 'Indietronica',
        'Krautrock', 'Orchestral',
    ];
    const albums = albumsFromSongs('Radiohead', [
        lsong('Radiohead/A Moon Shaped Pool (2016)/01.flac', {
            Album: 'A Moon Shaped Pool',
            Genre: genres,
        }),
    ]);
    assert.deepEqual(albums[0].genres, genres);
});

test('an untagged album gets an empty genre list, never null', () => {
    const albums = albumsFromSongs('X', [lsong('X/a/01.flac', { Album: 'Real' })]);
    assert.deepEqual(albums[0].genres, []);
});

test('the album takes its genres from the first track that has any', () => {
    // The same rule `date` uses. Not an intersection across tracks, which comes
    // out empty on a compilation whose tracks genuinely disagree.
    const albums = albumsFromSongs('X', [
        lsong('X/a/01.flac', { Album: 'A' }),
        lsong('X/a/02.flac', { Album: 'A', Genre: ['Jazz', 'Bebop'] }),
        lsong('X/a/03.flac', { Album: 'A', Genre: ['Ska'] }),
    ]);
    assert.deepEqual(albums[0].genres, ['Jazz', 'Bebop']);
});

test('discCount counts distinct Disc tags, and is 1 for an untagged album', () => {
    // Alice in Chains / Music Bank, one of 313 albums here that span more than
    // one disc — against the 149 that use a disc subdirectory. The Disc tag sees
    // twice what the directory layout does.
    const albums = albumsFromSongs('Alice in Chains', [
        lsong('Alice in Chains/Music Bank/01.flac', { Album: 'Music Bank', Disc: '1' }),
        lsong('Alice in Chains/Music Bank/02.flac', { Album: 'Music Bank', Disc: '2' }),
        lsong('Alice in Chains/Music Bank/03.flac', { Album: 'Music Bank', Disc: '2' }),
        lsong('Alice in Chains/Music Bank/04.flac', { Album: 'Music Bank', Disc: '3' }),
    ]);
    assert.equal(albums[0].discCount, 3);

    const untagged = albumsFromSongs('X', [lsong('X/a/01.flac', { Album: 'A' })]);
    // Never 0: an album with no Disc tag at all is still one disc.
    assert.equal(untagged[0].discCount, 1);
});

test('an album runtime is null unless EVERY track has a duration', () => {
    const whole = albumsFromSongs('X', [
        lsong('X/a/01.flac', { Album: 'A', Time: '100' }),
        lsong('X/a/02.flac', { Album: 'A', Time: '200' }),
    ]);
    assert.equal(whole[0].duration, 300);

    // A sum that quietly skips the untagged track is a wrong number presented
    // as a right one, so it is withheld instead.
    const partial = albumsFromSongs('X', [
        lsong('X/a/01.flac', { Album: 'A', Time: '100' }),
        lsong('X/a/02.flac', { Album: 'A' }),
    ]);
    assert.equal(partial[0].duration, null);
});

test('the label and MusicBrainz ids come from the first track that carries them', () => {
    const albums = albumsFromSongs('Radiohead', [
        lsong('Radiohead/OK Computer/01.flac', { Album: 'OK Computer' }),
        lsong('Radiohead/OK Computer/02.flac', {
            Album: 'OK Computer',
            Label: 'Parlophone',
            MUSICBRAINZ_ALBUMID: 'album-id',
            MUSICBRAINZ_RELEASEGROUPID: 'group-id',
        }),
    ]);
    assert.equal(albums[0].label, 'Parlophone');
    assert.equal(albums[0].mbAlbumId, 'album-id');
    // The release group survives a different pressing; the album id does not.
    assert.equal(albums[0].mbReleaseGroupId, 'group-id');
});

test('an album with none of those leaves the optional fields absent', () => {
    const [album] = albumsFromSongs('X', [lsong('X/a/01.flac', { Album: 'A' })]);
    assert.ok(!('label' in album));
    assert.ok(!('mbAlbumId' in album));
    assert.ok(!('mbReleaseGroupId' in album));
});

test('tracks sort by directory before track number, so discs do not interleave', () => {
    const sorted = sortAlbumTracks([
        song('B/13/CD 02/02.flac', { Track: '2', Title: 'd2t2' }),
        song('B/13/CD 01/10.flac', { Track: '10', Title: 'd1t10' }),
        song('B/13/CD 02/01.flac', { Track: '1', Title: 'd2t1' }),
        song('B/13/CD 01/02.flac', { Track: '2', Title: 'd1t2' }),
    ]);
    assert.deepEqual(
        sorted.map((t) => t.title),
        ['d1t2', 'd1t10', 'd2t1', 'd2t2'],
    );
});

test('a multi-disc album in ONE directory does not interleave its discs', () => {
    // 313 albums here span more than one disc and only 149 put the discs in
    // separate directories. For the other 164 — Alice in Chains' Music Bank —
    // every track shares a directory, so directory-then-track sorts purely on
    // the track number and gives disc 1 track 1, disc 2 track 1, disc 3 track 1.
    // Caught in a screenshot of the real panel, not by a test.
    const sorted = sortAlbumTracks([
        song('A/Music Bank/05.flac', { Disc: '2', Track: '1', Title: 'd2t1' }),
        song('A/Music Bank/01.flac', { Disc: '1', Track: '1', Title: 'd1t1' }),
        song('A/Music Bank/09.flac', { Disc: '3', Track: '1', Title: 'd3t1' }),
        song('A/Music Bank/06.flac', { Disc: '2', Track: '2', Title: 'd2t2' }),
        song('A/Music Bank/02.flac', { Disc: '1', Track: '2', Title: 'd1t2' }),
    ]);
    assert.deepEqual(
        sorted.map((t) => t.title),
        ['d1t1', 'd1t2', 'd2t1', 'd2t2', 'd3t1'],
    );
});

test('the disc tag does not reorder an album whose discs are separate directories', () => {
    // The 149 where the directory already separates them. Disc is the MIDDLE
    // key, so it must not overrule a directory the filenames agree with.
    const sorted = sortAlbumTracks([
        song('B/13/CD 02/01.flac', { Disc: '2', Track: '1', Title: 'd2t1' }),
        song('B/13/CD 01/02.flac', { Disc: '1', Track: '2', Title: 'd1t2' }),
        song('B/13/CD 01/01.flac', { Disc: '1', Track: '1', Title: 'd1t1' }),
    ]);
    assert.deepEqual(
        sorted.map((t) => t.title),
        ['d1t1', 'd1t2', 'd2t1'],
    );
});

test('a track with no Disc tag sorts after the tagged ones, not as disc zero', () => {
    const sorted = sortAlbumTracks([
        song('A/x/02.flac', { Track: '1', Title: 'untagged' }),
        song('A/x/01.flac', { Disc: '1', Track: '9', Title: 'disc one' }),
    ]);
    assert.deepEqual(
        sorted.map((t) => t.title),
        ['disc one', 'untagged'],
    );
});

test('track numbers compare as integers, including the n/total form', () => {
    const sorted = sortAlbumTracks([
        song('a/b/x.flac', { Track: '10/12', Title: 'ten' }),
        song('a/b/y.flac', { Track: '2/12', Title: 'two' }),
    ]);
    // As strings '10' sorts before '2', which is the bug this guards.
    assert.deepEqual(
        sorted.map((t) => t.title),
        ['two', 'ten'],
    );
});

test('an untagged track sorts last, not as track zero', () => {
    const sorted = sortAlbumTracks([
        song('a/b/x.flac', { Title: 'untagged' }),
        song('a/b/y.flac', { Track: '1', Title: 'first' }),
    ]);
    assert.deepEqual(
        sorted.map((t) => t.title),
        ['first', 'untagged'],
    );
});

/**
 * A bridge with only the methods the library uses, standing in for a socket.
 * Counting the calls is the point of several tests below.
 */
function fakeBridge(over: Partial<Record<string, unknown>> = {}) {
    const calls: string[] = [];
    const bridge = {
        calls,
        async list(tag: string, group?: string): Promise<Reply> {
            calls.push(`list ${tag} ${group ?? ''}`.trim());
            return reply([
                ['AlbumArtist', 'AC/DC'],
                ['Album', 'Back in Black'],
                ['Album', 'Highway to Hell'],
                ['AlbumArtist', 'Radiohead'],
                ['Album', 'Kid A'],
            ]);
        },
        async lsinfo(path: string): Promise<Reply> {
            calls.push(`lsinfo ${path}`);
            return reply([
                ['directory', 'AC-DC'],
                ['Last-Modified', '2024-01-01T00:00:00Z'],
                ['directory', '@eaDir'],
                ['directory', 'Radiohead'],
            ]);
        },
        async count(group: string): Promise<Reply> {
            calls.push(`count ${group}`);
            return reply([
                ['AlbumArtist', 'AC/DC'],
                ['songs', '24'],
                ['playtime', '7200'],
                ['AlbumArtist', 'Radiohead'],
                ['songs', '11'],
                ['playtime', '3300'],
            ]);
        },
        async findFirstSong(...pairs: Array<[string, string]>): Promise<LibrarySong | null> {
            calls.push(`findFirstSong ${pairs.map((p) => p.join('=')).join(' ')}`);
            const dir = pairs[0][1];
            const names: Record<string, string> = { 'AC-DC': 'AC/DC', Radiohead: 'Radiohead' };
            const name = names[dir];
            return name === undefined
                ? null
                : lsong(`${dir}/Album/01.flac`, {
                      AlbumArtist: name,
                      MUSICBRAINZ_ALBUMARTISTID: `mbid-${dir}`,
                  });
        },
        async findSongs(): Promise<LibrarySong[]> {
            calls.push('findSongs');
            return [];
        },
        ...over,
    };
    return bridge as unknown as MpdBridge & { calls: string[] };
}

test('the artist picture comes from a track path, costing no extra MPD command', () => {
    assert.equal(
        artistImageOf([lsong('AC-DC/Back in Black (1980)/01.flac')]),
        '/api/art?album=AC-DC',
    );
    // The disc-subdirectory case again: the FIRST segment, not two dirnames.
    assert.equal(
        artistImageOf([lsong('Black Sabbath/13 (2013)/CD 01/01.flac')]),
        '/api/art?album=Black%20Sabbath',
    );
    // No tracks, or a file at the library root: null, never a guessed directory.
    assert.equal(artistImageOf([]), null);
    assert.equal(artistImageOf([lsong('stray.flac')]), null);
});

test('albumsOf answers with the picture beside the albums', async () => {
    const bridge = fakeBridge({
        async findSongs(): Promise<LibrarySong[]> {
            return [lsong('AC-DC/Back in Black (1980)/01.flac', { Album: 'Back in Black' })];
        },
    });
    const { image, albums } = await createLibrary(bridge).albumsOf('AC/DC');
    // The artist screen must not depend on the artists list being cached —
    // it is reachable by URL after every kiosk reload.
    assert.equal(image, '/api/art?album=AC-DC');
    assert.equal(albums.length, 1);
});

test('the index joins tag names to directories rather than transforming one into the other', async () => {
    const bridge = fakeBridge();
    const artists = await createLibrary(bridge).artists();

    const acdc = artists.find((a) => a.name === 'AC/DC');
    assert.ok(acdc);
    // The whole reason the index exists: 48 of 487 real artists are filed under
    // a directory that is not their name, and `AC/DC` cannot be one because a
    // slash is a path separator. Transforming the name would 404 the image.
    assert.equal(acdc.directory, 'AC-DC');
    assert.equal(acdc.image, '/api/art?album=AC-DC');
    assert.equal(acdc.albumCount, 2);
});

test('the index carries songs and playtime from ONE count command', async () => {
    const bridge = fakeBridge();
    const artists = await createLibrary(bridge).artists();

    const acdc = artists.find((a) => a.name === 'AC/DC');
    assert.ok(acdc);
    assert.equal(acdc.trackCount, 24);
    assert.equal(acdc.duration, 7200);
    // `count group albumartist` answers for all 488 artists in 35ms. A `find`
    // per artist would be 11.4ms each — the reason this is one call, not 488.
    assert.equal(bridge.calls.filter((c) => c.startsWith('count')).length, 1);
});

test('the MusicBrainz artist id rides along on a song already being fetched', async () => {
    const artists = await createLibrary(fakeBridge()).artists();
    // findFirstSong is the call the index already makes to learn the directory's
    // name, so the id costs no extra command.
    assert.equal(artists.find((a) => a.name === 'AC/DC')?.mbArtistId, 'mbid-AC-DC');
});

test('an artist MPD reports no playtime for gets null, not zero', async () => {
    const bridge = fakeBridge({
        async count(): Promise<Reply> {
            return reply([['AlbumArtist', 'AC/DC'], ['songs', '0'], ['playtime', '0']]);
        },
    });
    const artists = await createLibrary(bridge).artists();
    const acdc = artists.find((a) => a.name === 'AC/DC');
    assert.ok(acdc);
    // An unknown playtime is not "listened to for no seconds".
    assert.equal(acdc.duration, null);
    assert.equal(acdc.trackCount, 0);
    // Radiohead is in the `list` reply but not the `count` one: still listed.
    assert.equal(artists.find((a) => a.name === 'Radiohead')?.trackCount, 0);
});

test('the index counts repeated Album keys within one group', async () => {
    const artists = await createLibrary(fakeBridge()).artists();
    // groupBy() builds a Map per group, where a repeated `Album` overwrites the
    // previous one — so counting through it would report 1 for every artist.
    assert.equal(artists.find((a) => a.name === 'AC/DC')?.albumCount, 2);
    assert.equal(artists.find((a) => a.name === 'Radiohead')?.albumCount, 1);
});

test('the index keeps MPD order and never asks about junk directories', async () => {
    const bridge = fakeBridge();
    const artists = await createLibrary(bridge).artists();

    // MPD returns `list album group albumartist` sorted by AlbumArtist, and that
    // order is the screen's order. Nothing re-sorts it.
    assert.deepEqual(
        artists.map((a) => a.name),
        ['AC/DC', 'Radiohead'],
    );
    // Synology scatters these through the share. setup-mpd.sh keeps them out of
    // the scan; this keeps any that slip through out of the artist list.
    assert.ok(!bridge.calls.some((c) => c.includes('@eaDir')));
});

test('an artist with no directory gets a null image, not a guessed URI', async () => {
    const bridge = fakeBridge({
        async lsinfo(): Promise<Reply> {
            return reply([['directory', 'Radiohead']]);
        },
    });
    const artists = await createLibrary(bridge).artists();
    const acdc = artists.find((a) => a.name === 'AC/DC');
    assert.ok(acdc);
    assert.equal(acdc.image, null);
    assert.equal(acdc.directory, '');
    // Still listed: it has albums, it is just missing a picture — the same state
    // as the 16 real artists whose directory holds no image file.
    assert.equal(acdc.albumCount, 2);
});

test('the index is built once and served from memory', async () => {
    const bridge = fakeBridge();
    const library = createLibrary(bridge);
    await library.artists();
    await library.artists();
    await library.artists();
    assert.equal(library.builds(), 1);
});

test('concurrent first callers share one build', async () => {
    const bridge = fakeBridge();
    const library = createLibrary(bridge);
    // The panel and a phone opening the library together would otherwise each
    // run 488 MPD commands.
    await Promise.all([library.artists(), library.artists(), library.artists()]);
    assert.equal(library.builds(), 1);
});

test('invalidate forces the next call to rebuild', async () => {
    const bridge = fakeBridge();
    const library = createLibrary(bridge);
    await library.artists();
    library.invalidate();
    await library.artists();
    assert.equal(library.builds(), 2);
});

test('a failed build is not cached', async () => {
    let fail = true;
    const bridge = fakeBridge({
        async list(): Promise<Reply> {
            if (fail) throw new Error('MPD is not connected');
            return reply([['AlbumArtist', 'Radiohead'], ['Album', 'Kid A']]);
        },
    });
    const library = createLibrary(bridge);
    await assert.rejects(() => library.artists(), /not connected/);
    fail = false;
    // MPD restarting must not leave the library permanently empty — a rejected
    // build has to be retryable.
    const artists = await library.artists();
    assert.equal(artists.length, 1);
});
