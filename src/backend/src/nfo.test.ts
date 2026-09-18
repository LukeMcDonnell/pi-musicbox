/**
 * The `.nfo` parser.
 *
 * The real files are dull — flat, one level, no CDATA — so the interesting half
 * of this file is the malformed input the library does not contain but another
 * tagger could produce. A parser that swallows the rest of a file after an
 * unterminated tag would put an artist's whole biography into their rating.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NFO_MAX_BYTES, parseNfo } from './nfo.ts';

/** Verbatim from /srv/music/Music/Arctic Monkeys/artist.nfo. */
const ARTIST_NFO = `<artist>
  <name>Arctic Monkeys</name>
  <rating>8.5</rating>
  <musicbrainzartistid>ada7a83c-e3e1-40f1-93f9-3e73dbc9298a</musicbrainzartistid>
  <biography>Arctic Monkeys are an English rock band formed in Sheffield in 2002.</biography>
  <outline>Arctic Monkeys are an English rock band formed in Sheffield in 2002.</outline>
</artist>`;

/** Verbatim from /srv/music/Music/Arctic Monkeys/AM (2013)/album.nfo. */
const ALBUM_NFO = `<album>
  <title>AM</title>
  <rating>7.6</rating>
  <musicbrainzalbumid>bf584cf2-dc33-433e-b8b2-b85578822726</musicbrainzalbumid>
  <artistdesc>Arctic Monkeys are an English rock band formed in Sheffield in 2002.</artistdesc>
  <releasedate>01/01/2013</releasedate>
  <label>Domino</label>
</album>`;

test('an artist.nfo yields its rating and biography', () => {
    const nfo = parseNfo(ARTIST_NFO);
    assert.equal(nfo.rating, 8.5);
    assert.match(nfo.biography ?? '', /^Arctic Monkeys are an English rock band/);
    assert.equal(nfo.artistDesc, undefined);
});

test('an album.nfo yields its rating and artistdesc, and nothing MPD already has', () => {
    const nfo = parseNfo(ALBUM_NFO);
    assert.equal(nfo.rating, 7.6);
    assert.match(nfo.artistDesc ?? '', /^Arctic Monkeys are an English rock band/);
    // No title, label, releasedate or MusicBrainz id: AlbumSummary carries all
    // four from the tags already, and a second source could disagree.
    assert.deepEqual(Object.keys(parseNfo(ALBUM_NFO)).sort(), ['artistDesc', 'rating']);
});

test('outline stands in for a missing biography', () => {
    const nfo = parseNfo('<artist><outline>Formed in Sheffield.</outline></artist>');
    assert.equal(nfo.biography, 'Formed in Sheffield.');
});

test('biography wins over outline when the two disagree', () => {
    const nfo = parseNfo('<artist><outline>Short.</outline><biography>Long.</biography></artist>');
    assert.equal(nfo.biography, 'Long.');
});

test('the five predefined entities are decoded, and &amp; only once', () => {
    const nfo = parseNfo(
        '<artist><biography>Angus &amp; Julia, &lt;b&gt;&quot;hi&quot;&apos; &amp;amp; so on</biography></artist>',
    );
    // `&amp;amp;` is the text "&amp;", NOT an ampersand decoded twice.
    assert.equal(nfo.biography, 'Angus & Julia, <b>"hi"\' &amp; so on');
});

test('numeric character references are decoded, and a nonsense one is dropped', () => {
    assert.equal(parseNfo('<a><biography>caf&#233;</biography></a>').biography, 'café');
    assert.equal(parseNfo('<a><biography>caf&#xE9;</biography></a>').biography, 'café');
    assert.equal(parseNfo('<a><biography>x&#9999999999;y</biography></a>').biography, 'xy');
});

test('a rating outside 0-10, or not a number, is treated as absent', () => {
    for (const raw of ['11', '-1', 'n/a', '', '  ']) {
        assert.equal(parseNfo(`<a><rating>${raw}</rating></a>`).rating, undefined, raw);
    }
    // The ends of the range are real values, not errors.
    assert.equal(parseNfo('<a><rating>0.0</rating></a>').rating, 0);
    assert.equal(parseNfo('<a><rating>10.0</rating></a>').rating, 10);
});

test('an unterminated tag matches nothing rather than swallowing the file', () => {
    const nfo = parseNfo('<artist><biography>Formed in Sheffield.<rating>8.5</rating></artist>');
    assert.equal(nfo.biography, undefined);
    // And the tag AFTER the broken one is still found.
    assert.equal(nfo.rating, 8.5);
});

test('a nested tag does not leak into the value', () => {
    // `[^<]*` stops at the `<b>`, so this is a miss, not "Formed in <b>Sheffield</b>".
    assert.equal(parseNfo('<a><biography>Formed in <b>Sheffield</b>.</biography></a>').biography, undefined);
});

test('CDATA is not mistaken for content', () => {
    // This library has none. What matters is that it parses to an absence rather
    // than to the literal string `<![CDATA[...]]>` appearing on a screen.
    const nfo = parseNfo('<a><biography><![CDATA[Formed in Sheffield.]]></biography></a>');
    assert.equal(nfo.biography, undefined);
});

test('a self-closing element is an absence — the commonest shape in this library', () => {
    // 455 of 508 <biography> and 2,723 of 3,262 <artistdesc> are written this
    // way. If these ever parsed to '' instead of undefined, the artistdesc
    // fallback would stop at the first empty one and every biography would
    // vanish.
    assert.deepEqual(parseNfo('<artist><biography /><rating>8.7</rating></artist>'), { rating: 8.7 });
    assert.deepEqual(parseNfo('<album><artistdesc/><rating>8.5</rating></album>'), { rating: 8.5 });
    // And an empty one does not shadow a later real one: outline still stands in.
    assert.equal(
        parseNfo('<artist><biography /><outline>From Sheffield.</outline></artist>').biography,
        'From Sheffield.',
    );
});

test('an empty or whitespace-only element is an absence, not an empty string', () => {
    assert.deepEqual(parseNfo('<a><biography></biography><rating>  </rating></a>'), {});
});

test('an absurdly large file is refused without running a regex over it', () => {
    const huge = `<a><rating>8.5</rating>${'x'.repeat(NFO_MAX_BYTES)}</a>`;
    assert.deepEqual(parseNfo(huge), {});
});

test('junk that is not XML at all parses to nothing rather than throwing', () => {
    for (const junk of ['', 'not xml', '<<<>>>', '\0\0\0', '<artist>']) {
        assert.deepEqual(parseNfo(junk), {}, JSON.stringify(junk));
    }
});
