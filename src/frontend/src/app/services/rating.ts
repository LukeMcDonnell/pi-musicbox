/**
 * Ratings, as they come off the NAS's `.nfo` files.
 *
 * The files carry a mark out of ten to one decimal; every screen shows it as a
 * WHOLE PERCENTAGE — `8.5` reads as `85%`. One conversion, here, because four
 * screens show one and "8.5" against "85%" against "9" is exactly the sort of
 * drift that only shows up side by side on the shelf.
 *
 * The heart that goes beside it lives in components/rating, which is what
 * screens should actually reach for. This is the string half, split out so it
 * can be tested without a fixture.
 */

/**
 * "85%", "100%", or null when there is nothing to show.
 *
 * NULL RATHER THAN A DASH OR A ZERO. 61 of this library's 506 artists and 449 of
 * its 3,062 albums have no rating, and a "0%" beside them reads as a damning
 * verdict rather than as silence. The caller omits the element entirely.
 */
export function formatRating(rating: number | null | undefined): string | null {
    if (rating === null || rating === undefined) return null;
    if (!Number.isFinite(rating)) return null;
    // Whole percent: the files are already one decimal, so this rounds at most a
    // half away, and "85%" beats "85.0%" on a row that is fighting for width.
    return `${Math.round(rating * 10)}%`;
}
