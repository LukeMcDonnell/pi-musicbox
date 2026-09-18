/**
 * Kodi `.nfo` sidecars: the NAS files one per artist and one per album.
 *
 * WHY A REGEX AND NOT AN XML PARSER
 *   A parser is a dependency, and the runtime is 12 packages behind a single-file
 *   esbuild bundle. The files do not need one: a census of all 3,770 of them on
 *   this library found flat one-level elements, no CDATA, no multi-line values,
 *   `&amp;` the only entity present, and 5,152 bytes the largest file.
 *
 * MOST OF THESE ELEMENTS ARE EMPTY, AND EMPTY MEANS ABSENT
 *   455 of the 508 `<biography>` elements on this library are self-closing
 *   `<biography />`, and 2,723 of 3,262 `<artistdesc>` are. Only 51 and 492
 *   respectively carry text. `<tag>([^<]*)</tag>` does not match a self-closing
 *   element at all, which is the behaviour wanted — but it is load-bearing
 *   rather than incidental, so it is pinned by a test.
 *
 * WHAT IS WORTH READING, AND WHAT IS NOT
 *   Almost everything in `album.nfo` is a tag MPD already gives us — title,
 *   releasedate, label (3,192 of 3,262, against 97.5% from the tags) and the
 *   MusicBrainz ids. Reading it a second time here would be two sources that can
 *   disagree. What MPD's tag database does NOT have is the rating and the
 *   biography, so those are the only fields taken. See .claude/docs/decisions.md.
 */

/** Refuse anything absurd rather than run a regex over it. The real max is 5KB. */
export const NFO_MAX_BYTES = 65_536;

export interface Nfo {
    /** 0–10, one decimal on this library. Absent when missing or unparseable. */
    rating?: number;
    /** `<biography>` or `<outline>` from an artist.nfo. */
    biography?: string;
    /** `<artistdesc>` from an album.nfo — the artist's bio, filed on the album. */
    artistDesc?: string;
}

/**
 * The five predefined XML entities, plus numeric references.
 *
 * `&amp;` is the only one that actually occurs here (148 times), but the other
 * four cost one line each and a file written by a different tagger will have them.
 * `&amp;` is resolved LAST so `&amp;lt;` comes out as the text `&lt;` rather
 * than being decoded twice into `<`.
 */
function decodeEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number(dec)))
        .replace(/&amp;/g, '&');
}

/** An out-of-range reference is left as nothing rather than throwing. */
function codePoint(value: number): string {
    if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return '';
    try {
        return String.fromCodePoint(value);
    } catch {
        return '';
    }
}

/**
 * The text of the first `<tag>`, or undefined.
 *
 * `[^<]*` rather than a lazy `.*?` on purpose: it cannot run past a nested tag
 * into some later element's content, and an unterminated `<biography>` simply
 * fails to match instead of swallowing the rest of the file.
 */
function tagText(text: string, tag: string): string | undefined {
    const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(text);
    if (match === null) return undefined;
    const value = decodeEntities(match[1]!).trim();
    return value === '' ? undefined : value;
}

/** A rating MPD would never give us. Out of range is treated as absent. */
function ratingOf(text: string): number | undefined {
    const raw = tagText(text, 'rating');
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 10) return undefined;
    return value;
}

/**
 * Read what is worth having out of an `artist.nfo` or an `album.nfo`.
 *
 * Never throws and never returns null: a file that parses to nothing is an
 * ordinary absence, exactly as a directory with no `folder.jpg` is.
 */
export function parseNfo(text: string): Nfo {
    if (text.length > NFO_MAX_BYTES) return {};
    const nfo: Nfo = {};
    const rating = ratingOf(text);
    if (rating !== undefined) nfo.rating = rating;
    // `<outline>` is a duplicate of `<biography>` wherever both appear on this
    // library, so it is a fallback rather than a separate field.
    const biography = tagText(text, 'biography') ?? tagText(text, 'outline');
    if (biography !== undefined) nfo.biography = biography;
    const artistDesc = tagText(text, 'artistdesc');
    if (artistDesc !== undefined) nfo.artistDesc = artistDesc;
    return nfo;
}
