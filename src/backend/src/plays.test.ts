import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { createPlays, type TrackPlay } from './plays.ts';

function track(albumArtist: string, album: string, n: string, over: Partial<TrackPlay> = {}): TrackPlay {
    return {
        file: `${albumArtist}/${album}/${n}.flac`,
        title: `Track ${n}`,
        artist: albumArtist,
        album,
        albumArtist,
        image: `/api/art?album=${encodeURIComponent(`${albumArtist}/${album}`)}`,
        ...over,
    };
}

function fresh() {
    const db = openDb({ path: ':memory:' });
    let clock = 1000;
    const plays = createPlays(db, () => clock++);
    return { db, plays };
}

test('a box that has played nothing has no albums', () => {
    const { db, plays } = fresh();
    assert.deepEqual(plays.recentAlbums(10), []);
    db.close();
});

test('one play makes one album, with when and how many', () => {
    const { db, plays } = fresh();
    plays.record(track('Tool', 'Ænima', '01'));
    assert.deepEqual(plays.recentAlbums(10), [
        {
            album: 'Ænima',
            albumArtist: 'Tool',
            image: '/api/art?album=Tool%2F%C3%86nima',
            playedAt: 1000,
            plays: 1,
        },
    ]);
    db.close();
});

test('the same track again bumps the count and moves the time, not a second row', () => {
    const { db, plays } = fresh();
    plays.record(track('Tool', 'Ænima', '01'));
    plays.record(track('Tool', 'Ænima', '01'));
    const albums = plays.recentAlbums(10);
    assert.equal(albums.length, 1);
    assert.equal(albums[0]!.plays, 2);
    assert.equal(albums[0]!.playedAt, 1001);
    db.close();
});

test("an album's plays are its tracks' plays added up", () => {
    const { db, plays } = fresh();
    plays.record(track('Tool', 'Ænima', '01'));
    plays.record(track('Tool', 'Ænima', '02'));
    plays.record(track('Tool', 'Ænima', '02'));
    assert.deepEqual(
        plays.recentAlbums(10).map((a) => [a.album, a.plays]),
        [['Ænima', 3]],
    );
    db.close();
});

test('albums come back most recently played first', () => {
    const { db, plays } = fresh();
    plays.record(track('Tool', 'Ænima', '01'));
    plays.record(track('Pixies', 'Doolittle', '01'));
    plays.record(track('Slint', 'Spiderland', '01'));
    assert.deepEqual(
        plays.recentAlbums(10).map((a) => a.album),
        ['Spiderland', 'Doolittle', 'Ænima'],
    );
    db.close();
});

test('playing an old album again brings it back to the front', () => {
    const { db, plays } = fresh();
    plays.record(track('Tool', 'Ænima', '01'));
    plays.record(track('Pixies', 'Doolittle', '01'));
    plays.record(track('Tool', 'Ænima', '02'));
    assert.deepEqual(
        plays.recentAlbums(10).map((a) => a.album),
        ['Ænima', 'Doolittle'],
    );
    db.close();
});

test('the limit is honoured', () => {
    const { db, plays } = fresh();
    for (let i = 0; i < 5; i++) plays.record(track('Artist', `Album ${i}`, '01'));
    assert.equal(plays.recentAlbums(3).length, 3);
    db.close();
});

test('the art is the most recently played track\'s, which for a multi-disc album is its disc', () => {
    const { db, plays } = fresh();
    plays.record(track('Black Sabbath', '13', '01', { image: '/api/art?album=Black%20Sabbath%2F13%2FCD%2001' }));
    plays.record(track('Black Sabbath', '13', '02', { image: '/api/art?album=Black%20Sabbath%2F13%2FCD%2002' }));
    assert.equal(plays.recentAlbums(10)[0]!.image, '/api/art?album=Black%20Sabbath%2F13%2FCD%2002');
    db.close();
});

test('a track with no album is recorded but cannot be an album', () => {
    const { db, plays } = fresh();
    plays.record({ file: 'loose/track.flac', title: 'Untagged', image: null });
    assert.deepEqual(plays.recentAlbums(10), []);
    // It is in the table all the same: a most-played-tracks list would want it.
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM track_play')!.n, 1);
    db.close();
});

test('a track with no album artist is left out too — it could not be opened', () => {
    const { db, plays } = fresh();
    plays.record({ file: 'loose/track.flac', album: 'Compilation', image: null });
    assert.deepEqual(plays.recentAlbums(10), []);
    db.close();
});

test('a retag corrects the row the next time that song plays', () => {
    const { db, plays } = fresh();
    // The same FILE — which is the identity — carrying a corrected album tag.
    const file = 'Tool/Aenima/01.flac';
    plays.record({ ...track('Tool', 'Aenima', '01'), file });
    plays.record({ ...track('Tool', 'Ænima', '01'), file });
    assert.deepEqual(
        plays.recentAlbums(10).map((a) => [a.album, a.plays]),
        [['Ænima', 2]],
    );
    db.close();
});

test('a file that MOVED is a new row — the path is the only identity there is', () => {
    const { db, plays } = fresh();
    plays.record(track('Tool', 'Aenima', '01'));
    plays.record(track('Tool', 'Ænima', '01'));
    assert.equal(plays.recentAlbums(10).length, 2);
    db.close();
});

test('listeners get the new list, and stop when they unsubscribe', () => {
    const { db, plays } = fresh();
    const seen: string[][] = [];
    const off = plays.onChange((albums) => seen.push(albums.map((a) => a.album)));
    plays.record(track('Tool', 'Ænima', '01'));
    plays.record(track('Pixies', 'Doolittle', '01'));
    off();
    plays.record(track('Slint', 'Spiderland', '01'));
    assert.deepEqual(seen, [['Ænima'], ['Doolittle', 'Ænima']]);
    db.close();
});

// ---------------------------------------------------------------------------
// Most played artists
// ---------------------------------------------------------------------------

test('a box that has played nothing has no artists', () => {
    const { db, plays } = fresh();
    assert.deepEqual(plays.mostPlayedArtists(10), []);
    db.close();
});

test("an artist's plays are added up across their albums", () => {
    const { db, plays } = fresh();
    plays.record(track('Tool', 'Ænima', '01'));
    plays.record(track('Tool', 'Ænima', '02'));
    plays.record(track('Tool', 'Lateralus', '01'));
    assert.deepEqual(
        plays.mostPlayedArtists(10).map((a) => [a.name, a.plays]),
        [['Tool', 3]],
    );
    db.close();
});

test('most played first, and a tie goes alphabetically rather than by recency', () => {
    const { db, plays } = fresh();
    // Zappa plays first and Boards second, so recency would put Boards on top.
    plays.record(track('Zappa', 'Hot Rats', '01'));
    plays.record(track('Boards of Canada', 'Geogaddi', '01'));
    plays.record(track('Pixies', 'Doolittle', '01'));
    plays.record(track('Pixies', 'Doolittle', '02'));
    assert.deepEqual(
        plays.mostPlayedArtists(10).map((a) => [a.name, a.plays]),
        [
            ['Pixies', 2],
            ['Boards of Canada', 1],
            ['Zappa', 1],
        ],
    );
    db.close();
});

test("the picture is the first path segment of a played file, not the artist's name", () => {
    const { db, plays } = fresh();
    // The name MPD reports and the directory it is filed under differ, which is
    // true of 48 of this library's 487 artists.
    plays.record({ ...track('AC/DC', 'Back in Black', '01'), file: 'AC-DC/Back in Black/01.flac' });
    assert.deepEqual(plays.mostPlayedArtists(10), [
        { name: 'AC/DC', image: '/api/art?album=AC-DC', plays: 1 },
    ]);
    db.close();
});

test('a file at the library root has no artist directory, so no picture', () => {
    const { db, plays } = fresh();
    plays.record({ ...track('Tool', 'Ænima', '01'), file: 'stray.flac' });
    assert.equal(plays.mostPlayedArtists(10)[0]!.image, null);
    db.close();
});

test('the picture comes from the most recently played file, so a retag corrects it', () => {
    const { db, plays } = fresh();
    plays.record({ ...track('Tool', 'Ænima', '01'), file: 'Tool (old)/Ænima/01.flac' });
    plays.record({ ...track('Tool', 'Ænima', '02'), file: 'Tool/Ænima/02.flac' });
    assert.equal(plays.mostPlayedArtists(10)[0]!.image, '/api/art?album=Tool');
    db.close();
});

test('an untagged album artist is left out — there would be nothing to open', () => {
    const { db, plays } = fresh();
    plays.record({ ...track('Tool', 'Ænima', '01'), albumArtist: undefined });
    plays.record(track('Pixies', 'Doolittle', '01'));
    assert.deepEqual(
        plays.mostPlayedArtists(10).map((a) => a.name),
        ['Pixies'],
    );
    db.close();
});

test('the limit cuts the list, keeping the most played', () => {
    const { db, plays } = fresh();
    plays.record(track('Pixies', 'Doolittle', '01'));
    plays.record(track('Pixies', 'Doolittle', '02'));
    plays.record(track('Tool', 'Ænima', '01'));
    assert.deepEqual(
        plays.mostPlayedArtists(1).map((a) => a.name),
        ['Pixies'],
    );
    db.close();
});
