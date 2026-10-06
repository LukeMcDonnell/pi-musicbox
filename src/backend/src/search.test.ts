import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, createSearch, groupedRows, match, orderGroups, scoreMatch, SEARCH_LIMITS } from './search.ts';
import type { SearchIndex } from './search.ts';
import { songFromTags } from './mpd/bridge.ts';
import type { LibrarySong } from './mpd/bridge.ts';
import type { Reply } from './mpd/protocol.ts';
import type { ArtistSummary, SearchGroup } from '../../shared/api.ts';

function lsong(file: string, tags: Record<string, string> = {}): LibrarySong {
    const map = new Map<string, string[]>([['file', [file]]]);
    for (const [key, value] of Object.entries(tags)) map.set(key, [value]);
    const built = songFromTags(map);
    assert.ok(built);
    return built;
}

function artist(name: string, trackCount = 10): ArtistSummary {
    return { name, directory: name, albumCount: 1, trackCount, duration: null, image: null };
}

/** Albums and tracks as MPD's two grouped `list` replies send them. */
function listBridge(albums: Array<[string, string, string]>, tracks: Array<[string, string, string]>) {
    return {
        list: async (tag: string): Promise<Reply> => {
            const pairs: Array<[string, string]> = [];
            if (tag === 'album') {
                for (const [mbid, albumArtist, album] of albums) {
                    pairs.push(['MUSICBRAINZ_ALBUMID', mbid], ['AlbumArtist', albumArtist], ['Album', album]);
                }
            } else {
                for (const [albumArtist, album, title] of tracks) {
                    pairs.push(['AlbumArtist', albumArtist], ['Album', album], ['Title', title]);
                }
            }
            return { pairs };
        },
    };
}

async function indexOf(
    albums: Array<[string, string, string]>,
    tracks: Array<[string, string, string]> = [],
): Promise<SearchIndex> {
    return buildIndex(listBridge(albums, tracks));
}

test('scoreMatch ranks exact, leading words, prefix, word start, anywhere', () => {
    assert.equal(scoreMatch('back in black', 'Back in Black'), 5);
    assert.equal(scoreMatch('back', 'Back in Black'), 4);
    assert.equal(scoreMatch('bac', 'Back in Black'), 3);
    assert.equal(scoreMatch('black', 'Back in Black'), 2);
    assert.equal(scoreMatch('lack', 'Back in Black'), 1);
    assert.equal(scoreMatch('zzz', 'Back in Black'), 0);
});

test('scoreMatch folds case and accents, and falls back to ignoring punctuation', () => {
    // The two MPD's own `search` misses, measured on the device.
    assert.equal(scoreMatch('bjork', 'Björk'), 5);
    assert.equal(scoreMatch("whats the story", '(What’s the Story) Morning Glory?'), 3);
    assert.equal(scoreMatch('acdc', 'AC/DC'), 5);
    // Squeezes to nothing, so it must not match everything.
    assert.equal(scoreMatch('!!!', 'Radiohead'), 0);
    assert.equal(scoreMatch('  ', 'Radiohead'), 0);
});

test('groupedRows carries each group value forward to the leaves under it', () => {
    const rows = groupedRows(
        { pairs: [['AlbumArtist', 'A'], ['Album', 'X'], ['Title', '1'], ['Title', '2'], ['Album', 'Y'], ['Title', '3']] },
        'Title',
        ['AlbumArtist', 'Album'],
    );
    assert.deepEqual(rows, [
        { AlbumArtist: 'A', Album: 'X', Title: '1' },
        { AlbumArtist: 'A', Album: 'X', Title: '2' },
        { AlbumArtist: 'A', Album: 'Y', Title: '3' },
    ]);
});

test('the index keeps one album per release id and drops what cannot be opened', async () => {
    const index = await indexOf([
        ['w1', 'Weezer', 'Weezer'],
        ['w2', 'Weezer', 'Weezer'],
        ['', 'Nobody', 'Untagged'],
        ['x', '', 'No artist'],
    ]);
    assert.deepEqual(
        index.albums.map((a) => [a.mbAlbumId, a.album]),
        [['w1', 'Weezer'], ['w2', 'Weezer'], [null, 'Untagged']],
    );
});

test('within a group, best first, then the shorter name, then the bigger artist', async () => {
    const found = match(
        'the',
        [artist('Mother'), artist('Them'), artist('The Theatre'), artist('The Cure', 5), artist('The Cult', 50), artist('Nobody')],
        await indexOf([]),
    );
    assert.deepEqual(found.artists.map((r) => r.item.name), ['The Cult', 'The Cure', 'The Theatre', 'Them', 'Mother']);
});

test('each group is capped and holds only matches', async () => {
    const index = await indexOf(
        [],
        Array.from({ length: 30 }, (_, i): [string, string, string] => ['X', 'Y', `Band song ${i}`]),
    );
    const found = match('band', Array.from({ length: 20 }, (_, i) => artist(`Band ${i}`)), index);
    assert.equal(found.artists.length, SEARCH_LIMITS.artist);
    assert.equal(found.tracks.length, SEARCH_LIMITS.track);
    assert.deepEqual(match('zzz', [artist('Band')], index).tracks, []);
});

test('groups are ordered by their best match, artist then album then track on a tie', () => {
    const g = (kind: SearchGroup['kind'], best: number) => ({
        group: { kind, items: [{}] } as unknown as SearchGroup,
        best,
    });
    assert.deepEqual(orderGroups([g('artist', 2), g('album', 4), g('track', 3)]).map((x) => x.kind), ['album', 'track', 'artist']);
    assert.deepEqual(orderGroups([g('artist', 3), g('album', 3), g('track', 3)]).map((x) => x.kind), ['artist', 'album', 'track']);
    const empty = { group: { kind: 'track', items: [] } as SearchGroup, best: 4 };
    assert.deepEqual(orderGroups([g('artist', 1), empty]).map((x) => x.kind), ['artist']);
});

test('createSearch resolves only the shown hits, by release id where there is one', async () => {
    const asked: string[] = [];
    let lists = 0;
    const search = createSearch(
        { artists: async () => [artist('Black Sabbath')] },
        {
            list: async (tag: string) => {
                lists += 1;
                return listBridge(
                    [['bib', 'AC/DC', 'Back in Black'], ['', 'Tribute', 'Back in Black Again']],
                    [['AC/DC', 'Back in Black', 'Back in Black'], ['AC/DC', 'Back in Black', 'Hells Bells']],
                ).list(tag);
            },
            findFirstSong: async (...pairs: Array<[string, string]>) => {
                asked.push(pairs.map((p) => p.join('=')).join(' '));
                const want = new Map(pairs);
                const album = want.get('album') ?? 'Back in Black';
                return lsong(`AC-DC/${album}/01.flac`, {
                    AlbumArtist: want.get('albumartist') ?? 'AC/DC',
                    Album: album,
                    Title: want.get('title') ?? 'Shoot to Thrill',
                    MUSICBRAINZ_ALBUMID: want.get('MUSICBRAINZ_ALBUMID') ?? 'other',
                });
            },
        },
    );
    const res = await search.search('  back in black ');
    assert.equal(res.query, 'back in black');
    assert.deepEqual(asked, [
        'MUSICBRAINZ_ALBUMID=bib',
        'albumartist=Tribute album=Back in Black Again',
        'albumartist=AC/DC album=Back in Black title=Back in Black',
    ]);
    // Album and track are both exact, and album wins the tie. No artist matches.
    assert.deepEqual(res.groups.map((g) => g.kind), ['album', 'track']);
    assert.equal(res.groups[0].items.length, 2);

    await search.search('hells');
    assert.equal(lists, 2, 'the index is built once');
    search.invalidate();
    await search.search('hells');
    assert.equal(lists, 4, 'and again after a scan');
});
