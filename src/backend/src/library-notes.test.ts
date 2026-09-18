/**
 * Harvesting the `.nfo` sidecars.
 *
 * The assertion that matters most is the PRUNE one. This table is the only copy
 * of data that lives on a share which is unmounted most of the time, so a
 * harvest that gave up half way through and then deleted everything it had not
 * reached would destroy good rows because the NAS blinked. ENOENT means "no such
 * file" and everything else means "the share is unwell", and that line is what
 * the prune is gated on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from './db.ts';
import {
    createLibraryNotes,
    realNotesDeps,
    type NotesBridge,
    type NotesDeps,
} from './library-notes.ts';
import { NFO_MAX_BYTES, parseNfo } from './nfo.ts';
import type { Reply } from './mpd/protocol.ts';

/** MPD's directory tree, as `lsinfo` would answer it: full relative paths. */
function fakeBridge(tree: Record<string, string[]>): NotesBridge & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        async lsinfo(path: string): Promise<Reply> {
            calls.push(path);
            const dirs = tree[path] ?? [];
            return { pairs: dirs.map((d) => ['directory', d] as [string, string]) };
        },
    };
}

/** A share, as a path -> contents map. A path not in it is ENOENT. */
function fakeShare(
    files: Record<string, string>,
    fail: (path: string) => Error | null = () => null,
): NotesDeps & { reads: string[] } {
    const reads: string[] = [];
    return {
        reads,
        rootReadable: async () => true,
        readNfo: async (path: string) => {
            reads.push(path);
            const err = fail(path);
            if (err !== null) throw err;
            // The fake share is keyed by the tail of the path, so tests do not
            // have to repeat the music root in every key.
            const key = Object.keys(files).find((k) => path.endsWith(k));
            return key === undefined ? null : files[key]!;
        },
    };
}

function eio(): NodeJS.ErrnoException {
    const err = new Error('EIO: i/o error') as NodeJS.ErrnoException;
    err.code = 'EIO';
    return err;
}

const ARTIST = '<artist><rating>8.5</rating><biography>From Sheffield.</biography></artist>';
const ALBUM = '<album><rating>7.6</rating><label>Domino</label></album>';

/** The shape the real library has: artist dir, album dirs beneath it. */
const TREE = {
    '': ['Arctic Monkeys', 'Radiohead', '@eaDir'],
    'Arctic Monkeys': ['Arctic Monkeys/AM (2013)', 'Arctic Monkeys/Humbug (2009)'],
    Radiohead: ['Radiohead/OK Computer (1997)'],
};

function freshDb(): Db {
    return openDb({ path: ':memory:' });
}

test('a harvest stores one row per artist and album directory', async (t) => {
    const db = freshDb();
    t.after(() => db.close());
    const notes = createLibraryNotes({
        db,
        bridge: fakeBridge(TREE),
        musicRoot: '/srv/music/Music',
        deps: fakeShare({
            'Arctic Monkeys/artist.nfo': ARTIST,
            'Arctic Monkeys/AM (2013)/album.nfo': ALBUM,
            'Arctic Monkeys/Humbug (2009)/album.nfo': '<album><rating>6.9</rating></album>',
            'Radiohead/OK Computer (1997)/album.nfo': '<album><rating>10.0</rating></album>',
        }),
    });

    const result = await notes.harvest();
    assert.equal(result.artists, 1);
    assert.equal(result.albums, 3);
    assert.equal(result.failures, 0);

    assert.deepEqual(notes.forArtist('Arctic Monkeys'), {
        rating: 8.5,
        biography: 'From Sheffield.',
    });
    assert.deepEqual(notes.forAlbum('Arctic Monkeys/AM (2013)'), { rating: 7.6, biography: null });
    assert.deepEqual(notes.forAlbum('Radiohead/OK Computer (1997)'), { rating: 10, biography: null });
    // Radiohead has no artist.nfo and none of their albums carry an artistdesc,
    // so there is nothing to file against them.
    assert.equal(notes.forArtist('Radiohead'), null);
});

test('junk directories are never read', async (t) => {
    const db = freshDb();
    t.after(() => db.close());
    const deps = fakeShare({});
    const notes = createLibraryNotes({
        db,
        bridge: fakeBridge({ '': ['Arctic Monkeys', '@eaDir', '#recycle'] }),
        musicRoot: '/srv/music/Music',
        deps,
    });
    await notes.harvest();
    assert.ok(!deps.reads.some((p) => p.includes('@eaDir') || p.includes('#recycle')));
});

test("an album's artistdesc stands in for a missing artist biography", async (t) => {
    const db = freshDb();
    t.after(() => db.close());
    // Most of the real library's 60 biographies arrive this way: only 51
    // artist.nfo files carry a non-empty <biography> of their own.
    const notes = createLibraryNotes({
        db,
        bridge: fakeBridge(TREE),
        musicRoot: '/srv/music/Music',
        deps: fakeShare({
            'Arctic Monkeys/AM (2013)/album.nfo':
                '<album><rating>7.6</rating><artistdesc>From Sheffield.</artistdesc></album>',
        }),
    });
    await notes.harvest();
    assert.deepEqual(notes.forArtist('Arctic Monkeys'), {
        rating: null,
        biography: 'From Sheffield.',
    });
});

test("an artist's own biography beats an album's artistdesc", async (t) => {
    const db = freshDb();
    t.after(() => db.close());
    const notes = createLibraryNotes({
        db,
        bridge: fakeBridge(TREE),
        musicRoot: '/srv/music/Music',
        deps: fakeShare({
            'Arctic Monkeys/artist.nfo': '<artist><biography>The real one.</biography></artist>',
            'Arctic Monkeys/AM (2013)/album.nfo': '<album><artistdesc>The fallback.</artistdesc></album>',
        }),
    });
    await notes.harvest();
    assert.equal(notes.forArtist('Arctic Monkeys')?.biography, 'The real one.');
});

test('a missing .nfo is an ordinary absence, not a failure', async (t) => {
    const db = freshDb();
    t.after(() => db.close());
    const notes = createLibraryNotes({
        db,
        bridge: fakeBridge(TREE),
        musicRoot: '/srv/music/Music',
        // Nothing on the share: every directory is a legitimate miss.
        deps: fakeShare({}),
    });
    const result = await notes.harvest();
    assert.equal(result.failures, 0);
    assert.equal(result.artists, 0);
    assert.equal(result.albums, 0);
});

test('the real reader turns ENOENT into an absence and keeps every other error', async (t) => {
    // Against a real directory, because this translation is what the prune is
    // gated on and a fake that performed it itself would be asserting nothing.
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-notes-'));
    t.after(() => rm(dir, { recursive: true, force: true }));

    await writeFile(join(dir, 'artist.nfo'), ARTIST);
    assert.equal(await realNotesDeps.readNfo(join(dir, 'artist.nfo')), ARTIST);
    assert.equal(await realNotesDeps.readNfo(join(dir, 'nope.nfo')), null);

    // A directory where a file should be is EISDIR, not ENOENT: unwell, so it
    // must throw rather than read as "this artist has no nfo".
    await mkdir(join(dir, 'album.nfo'));
    await assert.rejects(() => realNotesDeps.readNfo(join(dir, 'album.nfo')));

    assert.equal(await realNotesDeps.rootReadable(dir), true);
    assert.equal(await realNotesDeps.rootReadable(join(dir, 'gone')), false);
    // A file is not a root. An automount that failed can leave one behind.
    assert.equal(await realNotesDeps.rootReadable(join(dir, 'artist.nfo')), false);
});

test('an over-long file is truncated at the cap, and truncation only loses fields', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'musicbox-notes-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'artist.nfo');
    await writeFile(
        path,
        `<artist><rating>8.5</rating><biography>${'x'.repeat(NFO_MAX_BYTES * 2)}</biography></artist>`,
    );

    const text = await realNotesDeps.readNfo(path);
    assert.equal(text?.length, NFO_MAX_BYTES, 'the process never holds the whole file');

    // The rating, which fits, survives. The biography, whose closing tag was cut
    // off, does not appear AT ALL — `[^<]*</biography>` needs the closing tag, so
    // a truncated value can only go missing, never arrive half-written.
    assert.deepEqual(parseNfo(text ?? ''), { rating: 8.5 });
});

test('a harvest that hits an I/O error prunes nothing', async (t) => {
    const db = freshDb();
    t.after(() => db.close());
    const bridge = fakeBridge(TREE);

    // First, a clean harvest that fills the table.
    const good = createLibraryNotes({
        db,
        bridge,
        musicRoot: '/srv/music/Music',
        deps: fakeShare({
            'Arctic Monkeys/artist.nfo': ARTIST,
            'Arctic Monkeys/AM (2013)/album.nfo': ALBUM,
        }),
    });
    await good.harvest();
    const before = good.count();
    assert.ok(before > 0);

    // Then the NAS goes away mid-walk. Every row must survive.
    const sick = createLibraryNotes({
        db,
        bridge,
        musicRoot: '/srv/music/Music',
        deps: fakeShare({}, (path) => (path.includes('Radiohead') ? eio() : null)),
    });
    const result = await sick.harvest();
    assert.ok(result.failures > 0);
    assert.equal(result.pruned, 0);
    assert.equal(sick.count(), before);
    assert.deepEqual(sick.forArtist('Arctic Monkeys'), { rating: 8.5, biography: 'From Sheffield.' });
});

test('a clean harvest prunes directories MPD no longer knows', async (t) => {
    const db = freshDb();
    t.after(() => db.close());
    const share = {
        'Arctic Monkeys/artist.nfo': ARTIST,
        'Arctic Monkeys/AM (2013)/album.nfo': ALBUM,
        'Radiohead/OK Computer (1997)/album.nfo': ALBUM,
    };
    const full = createLibraryNotes({
        db,
        bridge: fakeBridge(TREE),
        musicRoot: '/srv/music/Music',
        deps: fakeShare(share),
    });
    await full.harvest();
    assert.ok(full.forAlbum('Radiohead/OK Computer (1997)') !== null);

    // Radiohead has been deleted from the library.
    const smaller = createLibraryNotes({
        db,
        bridge: fakeBridge({
            '': ['Arctic Monkeys'],
            'Arctic Monkeys': ['Arctic Monkeys/AM (2013)'],
        }),
        musicRoot: '/srv/music/Music',
        deps: fakeShare(share),
    });
    const result = await smaller.harvest();
    assert.equal(result.pruned, 1);
    assert.equal(smaller.forAlbum('Radiohead/OK Computer (1997)'), null);
    assert.ok(smaller.forArtist('Arctic Monkeys') !== null);
});

test('an unreachable music root harvests nothing and deletes nothing', async (t) => {
    const db = freshDb();
    t.after(() => db.close());
    const bridge = fakeBridge(TREE);
    const good = createLibraryNotes({
        db,
        bridge,
        musicRoot: '/srv/music/Music',
        deps: fakeShare({ 'Arctic Monkeys/artist.nfo': ARTIST }),
    });
    await good.harvest();
    const before = good.count();

    // This is the case the root guard exists for: an absent mount answers ENOENT
    // to every read, which without the guard reads as "no nfo anywhere" and
    // would prune the whole table.
    const deps = fakeShare({});
    deps.rootReadable = async () => false;
    const off = createLibraryNotes({ db, bridge, musicRoot: '/srv/music/Music', deps });
    const result = await off.harvest();
    assert.equal(result.artists, 0);
    assert.equal(result.pruned, 0);
    assert.equal(deps.reads.length, 0, 'the share must not be touched at all');
    assert.equal(off.count(), before);
});

test('a re-harvest updates rows in place rather than duplicating them', async (t) => {
    const db = freshDb();
    t.after(() => db.close());
    const bridge = fakeBridge(TREE);
    const first = createLibraryNotes({
        db,
        bridge,
        musicRoot: '/srv/music/Music',
        deps: fakeShare({ 'Arctic Monkeys/artist.nfo': '<artist><rating>8.5</rating></artist>' }),
    });
    await first.harvest();
    const second = createLibraryNotes({
        db,
        bridge,
        musicRoot: '/srv/music/Music',
        deps: fakeShare({ 'Arctic Monkeys/artist.nfo': '<artist><rating>9.1</rating></artist>' }),
    });
    await second.harvest();
    assert.equal(second.count(), 1);
    assert.equal(second.forArtist('Arctic Monkeys')?.rating, 9.1);
});

test('an artist and an album directory cannot be confused for one another', async (t) => {
    const db = freshDb();
    t.after(() => db.close());
    const notes = createLibraryNotes({
        db,
        bridge: fakeBridge(TREE),
        musicRoot: '/srv/music/Music',
        deps: fakeShare({
            'Arctic Monkeys/artist.nfo': ARTIST,
            'Arctic Monkeys/AM (2013)/album.nfo': ALBUM,
        }),
    });
    await notes.harvest();
    assert.equal(notes.forAlbum('Arctic Monkeys'), null);
    assert.equal(notes.forArtist('Arctic Monkeys/AM (2013)'), null);
});
