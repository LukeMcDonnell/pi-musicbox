/**
 * Album art resolution.
 *
 * The assertion that matters most is the PRIORITY one. A census of the real
 * library found `discart.jpg` + `discart.png` outnumbering `cover.jpg` 44 to 1,
 * and a discart is a round disc image on a transparent background — a naive
 * "first image in the directory" would serve those and the UI would look broken.
 * So the priority list is tested against a directory deliberately full of decoys.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    ART_FILENAMES,
    albumDirOf,
    artUriFor,
    createArtResolver,
    etagFor,
    type ArtDeps,
} from './art.ts';

/** A fake filesystem, so cache behaviour is asserted by counting, not timing. */
function fakeFs(present: string[]): ArtDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        statFile: async (path: string) => {
            calls.push(path);
            return present.some((p) => path.endsWith(p))
                ? { size: 12345, mtimeMs: 1_700_000_000_000 }
                : null;
        },
    };
}

test('albumDirOf takes the directory a song lives in', () => {
    assert.equal(albumDirOf('Radiohead/In Rainbows (2007)/01 - 15 Step.flac'), 'Radiohead/In Rainbows (2007)');
    assert.equal(albumDirOf('a/b/c/d.flac'), 'a/b/c');
});

test('albumDirOf handles a song at the library root', () => {
    // posix.dirname returns '.', which must not leak into a URL.
    assert.equal(albumDirOf('loose-track.flac'), '');
});

test('albumDirOf uses POSIX rules regardless of host platform', () => {
    // MPD always speaks POSIX paths. A backslash is a legal filename character,
    // not a separator, so it must NOT be treated as one.
    assert.equal(albumDirOf('AC\\DC/Back in Black/01.flac'), 'AC\\DC/Back in Black');
});

test('artUriFor encodes the characters this library actually contains', () => {
    // Real examples: '!!!' as an artist, '&' and '#' in titles, spaces and
    // parentheses everywhere. All of these must survive into a legal URL.
    const uri = artUriFor('!!!/Louden Up Now (2004)/08 - Me & Giuliani #1.flac');
    assert.ok(!uri.includes(' '), `raw space in URI: ${uri}`);
    assert.ok(!uri.includes('#'), `raw # would truncate the URL: ${uri}`);
    assert.equal(uri.startsWith('/api/art?album='), true);

    // And it must round-trip back to the directory the resolver will look in.
    const encoded = uri.slice('/api/art?album='.length);
    assert.equal(decodeURIComponent(encoded), '!!!/Louden Up Now (2004)');
});

test('artUriFor round-trips a directory containing a plus sign', () => {
    // '+' is legal in a path but means space in some query parsers;
    // encodeURIComponent leaves it alone, so assert the round trip explicitly.
    const uri = artUriFor('Artist/Album +1/01.flac');
    const encoded = uri.slice('/api/art?album='.length);
    assert.equal(decodeURIComponent(encoded), 'Artist/Album +1');
});

test('THE TRAP: folder.jpg wins over discart, fanart, logo and banner', async () => {
    const deps = fakeFs(['discart.jpg', 'discart.png', 'fanart.jpg', 'logo.png', 'banner.jpg', 'folder.jpg']);
    const resolver = createArtResolver('/music', deps);
    const art = await resolver.resolve('Artist/Album');
    assert.ok(art, 'expected art to resolve');
    assert.ok(art.path.endsWith('folder.jpg'), `picked ${art.path}`);
});

test('a directory with ONLY decoys resolves to nothing', async () => {
    // Better a placeholder than a round disc image stretched into a cover slot.
    const deps = fakeFs(['discart.png', 'clearlogo.png', 'fanart.jpg']);
    const resolver = createArtResolver('/music', deps);
    assert.equal(await resolver.resolve('Artist/Album'), null);
});

test('cover.jpg beats folder.jpg when both exist', async () => {
    const deps = fakeFs(['cover.jpg', 'folder.jpg']);
    const resolver = createArtResolver('/music', deps);
    const art = await resolver.resolve('Artist/Album');
    assert.ok(art?.path.endsWith('cover.jpg'), `picked ${art?.path}`);
});

test('no candidate filename is one of the decoys', () => {
    // Guards the list itself against a well-meaning future addition.
    for (const decoy of ['discart', 'fanart', 'banner', 'logo', 'clearlogo', 'thumb']) {
        assert.equal(
            ART_FILENAMES.some((n) => n.includes(decoy)),
            false,
            `${decoy} must never be a cover candidate`,
        );
    }
});

test('Synology junk directories are refused', async () => {
    const deps = fakeFs(['folder.jpg']); // art "exists", but the dir is junk
    const resolver = createArtResolver('/music', deps);
    assert.equal(await resolver.resolve('Artist/Album/@eaDir'), null);
    assert.equal(await resolver.resolve('@eaDir/Artist/Album'), null);
    assert.equal(await resolver.resolve('#recycle/Artist'), null);
    assert.equal(deps.calls.length, 0, 'junk must be rejected before any filesystem call');
});

test('a directory merely CONTAINING the junk name as a substring is fine', async () => {
    // Segment-wise matching, not substring: a real album could be called this.
    const deps = fakeFs(['folder.jpg']);
    const resolver = createArtResolver('/music', deps);
    assert.ok(await resolver.resolve('Artist/@eaDirectory Sessions'));
});

test('traversal out of the music root is refused', async () => {
    const deps = fakeFs(['passwd']);
    const resolver = createArtResolver('/music', deps);
    for (const attempt of ['../../../etc', '../../etc/passwd', '/etc']) {
        const art = await resolver.resolve(attempt);
        if (art !== null) {
            assert.ok(
                art.path.startsWith('/music/'),
                `escaped the music root: ${art.path} (from ${attempt})`,
            );
        }
    }
});

test('a resolved album is cached — no second filesystem walk', async () => {
    const deps = fakeFs(['folder.jpg']);
    const resolver = createArtResolver('/music', deps);
    await resolver.resolve('Artist/Album');
    const afterFirst = resolver.stats();
    await resolver.resolve('Artist/Album');
    await resolver.resolve('Artist/Album');
    assert.equal(resolver.stats(), afterFirst, 'repeat lookups must not re-stat');
});

test('NEGATIVE results are cached too', async () => {
    /*
     * The important half. About 7.5% of the library has no cover, and every
     * candidate filename is checked before giving up — so without negative
     * caching each request for such an album walks the whole list over NFS again.
     */
    const deps = fakeFs([]); // nothing exists anywhere
    const resolver = createArtResolver('/music', deps);
    assert.equal(await resolver.resolve('Artist/Coverless'), null);
    const afterFirst = resolver.stats();
    assert.ok(afterFirst > 1, 'the first miss should try several candidates');
    assert.equal(await resolver.resolve('Artist/Coverless'), null);
    assert.equal(resolver.stats(), afterFirst, 'a cached miss must not re-stat');
});

test('etagFor changes when either mtime or size changes', () => {
    const base = { path: '/music/a/folder.jpg', size: 100, mtimeMs: 1000 };
    assert.equal(etagFor(base), etagFor({ ...base }));
    assert.notEqual(etagFor(base), etagFor({ ...base, size: 101 }));
    assert.notEqual(etagFor(base), etagFor({ ...base, mtimeMs: 1001 }));
    // Weak, because it is derived from metadata rather than the bytes.
    assert.ok(etagFor(base).startsWith('W/"'), etagFor(base));
});

test('resolution works against a real directory, not just the fake', async () => {
    // One end-to-end pass over the actual filesystem, so the fake cannot be
    // hiding a path-joining mistake.
    const root = await mkdtemp(join(tmpdir(), 'musicbox-art-'));
    try {
        const album = join(root, 'Artist', 'Album (2001)');
        await mkdir(album, { recursive: true });
        await writeFile(join(album, 'discart.jpg'), 'decoy');
        await writeFile(join(album, 'folder.jpg'), 'the real cover');

        const resolver = createArtResolver(root);
        const art = await resolver.resolve('Artist/Album (2001)');
        assert.ok(art, 'expected art from a real directory');
        assert.ok(art.path.endsWith('folder.jpg'), `picked ${art.path}`);
        assert.equal(art.size, 'the real cover'.length);

        assert.equal(await resolver.resolve('Artist/No Such Album'), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('traversal cannot reach a real file outside the music root', async () => {
    /*
     * The security-relevant one, and the only traversal test with real teeth:
     * the fake filesystem above can only ever prove the path we ASKED for, so
     * this plants an actual cover outside the root and tries to escape to it.
     */
    const base = await mkdtemp(join(tmpdir(), 'musicbox-art-'));
    try {
        const root = join(base, 'library');
        await mkdir(join(root, 'Artist', 'Album'), { recursive: true });
        // A perfectly valid cover, deliberately OUTSIDE the library root.
        await mkdir(join(base, 'secrets'), { recursive: true });
        await writeFile(join(base, 'secrets', 'folder.jpg'), 'must never be served');

        const resolver = createArtResolver(root);
        for (const attempt of [
            '../secrets',
            '../../secrets',
            'Artist/../../secrets',
            './../secrets',
        ]) {
            const art = await resolver.resolve(attempt);
            if (art !== null) {
                assert.ok(
                    art.path.startsWith(root + '/'),
                    `escaped the root via '${attempt}': ${art.path}`,
                );
                assert.ok(
                    !art.path.includes('secrets'),
                    `reached the planted file via '${attempt}': ${art.path}`,
                );
            }
        }
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('a directory is not mistaken for an image', async () => {
    // statFile must reject non-regular files: someone could have a directory
    // literally named cover.jpg.
    const root = await mkdtemp(join(tmpdir(), 'musicbox-art-'));
    try {
        await mkdir(join(root, 'Artist', 'Album', 'cover.jpg'), { recursive: true });
        await writeFile(join(root, 'Artist', 'Album', 'folder.jpg'), 'real');
        const resolver = createArtResolver(root);
        const art = await resolver.resolve('Artist/Album');
        assert.ok(art?.path.endsWith('folder.jpg'), `picked ${art?.path}`);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
