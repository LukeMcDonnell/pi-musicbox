/** Filter matching shared by the Library and Favourites screens. */

/** `Sigur Rós` -> `sigur ros` */
export function fold(text: string): string {
    return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** `ac/dc` -> `acdc` */
export function squeeze(text: string): string {
    return text.replace(/[^\p{L}\p{N}]/gu, '');
}
