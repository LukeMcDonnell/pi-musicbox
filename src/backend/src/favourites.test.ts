import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlbumSummary, FavouriteAlbum } from '../../shared/api.ts';
import { openDb } from './db.ts';
import { createFavourites } from './favourites.ts';

function summary(albumArtist: string, album: string, over: Partial<AlbumSummary> = {}): AlbumSummary {
    return {
        album,
        albumArtist,
        release: `mb:${albumArtist}/${album}`,
        date: '1997-05-21',
        trackCount: 12,
        genres: ['Alternative Rock'],
        discCount: 1,
        duration: 3200,
        image: `/api/art?album=${encodeURIComponent(`${albumArtist}/${album}`)}`,
        ...over,
    };
}

function fresh() {
    const db = openDb({ path: ':memory:' });
    let clock = 1000;
    const favourites = createFavourites(db, () => clock++);
    return { db, favourites };
}

test('an empty box has no favourites', () => {
    const { db, favourites } = fresh();
    assert.deepEqual(favourites.all(), []);
    db.close();
});

test('an added album comes back with its summary and when it was added', () => {
    const { db, favourites } = fresh();
    const albums = favourites.add(summary('Radiohead', 'OK Computer'));
    assert.deepEqual(albums, [{ ...summary('Radiohead', 'OK Computer'), addedAt: 1000 }]);
    assert.deepEqual(favourites.all(), albums);
    db.close();
});

test('adding twice keeps the original addedAt and does not notify', () => {
    const { db, favourites } = fresh();
    favourites.add(summary('Radiohead', 'OK Computer'));
    const heard: FavouriteAlbum[][] = [];
    favourites.onChange((albums) => heard.push(albums));
    favourites.add(summary('Radiohead', 'OK Computer'));
    assert.equal(favourites.all()[0]?.addedAt, 1000);
    assert.equal(heard.length, 0);
    db.close();
});

test('the same title under two artists is two favourites', () => {
    const { db, favourites } = fresh();
    favourites.add(summary('Eagles', 'Greatest Hits'));
    favourites.add(summary('Queen', 'Greatest Hits'));
    favourites.remove(`mb:Eagles/Greatest Hits`);
    assert.deepEqual(
        favourites.all().map((a) => a.albumArtist),
        ['Queen'],
    );
    db.close();
});

test('newest first', () => {
    const { db, favourites } = fresh();
    favourites.add(summary('A', 'One'));
    favourites.add(summary('B', 'Two'));
    assert.deepEqual(favourites.all().map((a) => a.album), ['Two', 'One']);
    db.close();
});

test('removing notifies with the full list, and removing nothing is harmless', () => {
    const { db, favourites } = fresh();
    favourites.add(summary('A', 'One'));
    favourites.add(summary('B', 'Two'));
    const heard: FavouriteAlbum[][] = [];
    favourites.onChange((albums) => heard.push(albums));
    favourites.remove(`mb:A/One`);
    favourites.remove(`mb:A/One`);
    assert.equal(heard.length, 1);
    assert.deepEqual(heard[0]?.map((a) => a.album), ['Two']);
    db.close();
});

test('refresh rewrites a changed summary, and only notifies when it changed', () => {
    const { db, favourites } = fresh();
    favourites.add(summary('A', 'One'));
    const heard: FavouriteAlbum[][] = [];
    favourites.onChange((albums) => heard.push(albums));
    favourites.refresh(summary('A', 'One'));
    assert.equal(heard.length, 0);
    favourites.refresh(summary('A', 'One', { date: '1980' }));
    assert.equal(heard.length, 1);
    assert.equal(favourites.all()[0]?.date, '1980');
    assert.equal(favourites.all()[0]?.addedAt, 1000);
    db.close();
});

test('refresh never adds an album that is not a favourite', () => {
    const { db, favourites } = fresh();
    favourites.refresh(summary('A', 'One'));
    assert.deepEqual(favourites.all(), []);
    db.close();
});

test('a favourite stored before releases existed is still readable', () => {
    // THE REGRESSION. v6 recovered the release into its own column but left the
    // stored AlbumSummary as written, with no `release` in it. Treating the copy
    // as identity made 411 of 412 favourites vanish from the screen while
    // sitting intact in the table. The COLUMN is the identity.
    const { db, favourites } = fresh();
    const old = summary('Radiohead', 'Kid A');
    delete (old as { release?: string }).release;
    db.run(
        'INSERT INTO favourite_album (album_artist, album, release, added_at, summary) VALUES (?, ?, ?, ?, ?)',
        'Radiohead',
        'Kid A',
        'mb:kid-a',
        5,
        JSON.stringify(old),
    );
    const [album] = favourites.all();
    assert.equal(album?.album, 'Kid A');
    assert.equal(album?.release, 'mb:kid-a');
    db.close();
});

test('rows that cannot be trusted are skipped, not fatal', () => {
    const { db, favourites } = fresh();
    favourites.add(summary('A', 'Good'));
    const insert =
        'INSERT INTO favourite_album (album_artist, album, release, added_at, summary) VALUES (?, ?, ?, ?, ?)';
    db.run(insert, 'A', 'Not json', 'r1', 5, '{nope');
    db.run(insert, 'A', 'Array', 'r2', 5, '[]');
    db.run(insert, 'A', 'Mismatch', 'r3', 5, JSON.stringify(summary('B', 'Mismatch')));
    db.run(insert, 'A', 'No tracks', 'r4', 5, JSON.stringify({ ...summary('A', 'No tracks'), trackCount: 'x' }));
    assert.deepEqual(favourites.all().map((a) => a.album), ['Good']);
    db.close();
});
