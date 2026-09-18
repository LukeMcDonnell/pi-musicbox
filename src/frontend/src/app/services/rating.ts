/**
 * Ratings, as they come off the NAS's `.nfo` files.
 *
 * Out of ten, and one decimal in practice. Here rather than in each component
 * because three screens show one and "8.5" against "8.50" against "9" is exactly
 * the sort of drift that only shows up side by side on the shelf.
 */

/**
 * "8.5", "10", or null when there is nothing to show.
 *
 * NULL RATHER THAN A DASH OR A ZERO. 61 of this library's 506 artists and 449 of
 * its 3,062 albums have no rating, and a "0" beside them reads as a damning
 * verdict rather than as silence. The caller omits the element entirely.
 */
export function formatRating(rating: number | null | undefined): string | null {
    if (rating === null || rating === undefined) return null;
    if (!Number.isFinite(rating)) return null;
    // One decimal, then drop a trailing `.0` — the file says `10.0` and `8.0`,
    // and "10" and "8" are what a person would write.
    return rating.toFixed(1).replace(/\.0$/, '');
}
