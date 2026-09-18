import { formatRating } from './rating';

describe('formatRating', () => {
    it('shows one decimal, and drops a trailing zero', () => {
        // The shapes the real files use: `8.5`, `10.0`, `8.0`.
        expect(formatRating(8.5)).toBe('8.5');
        expect(formatRating(10)).toBe('10');
        expect(formatRating(8)).toBe('8');
    });

    it('rounds a second decimal away, as toFixed does', () => {
        // Never happens: every rating in the library is written to one decimal.
        // Pinned anyway so the rounding is a decision rather than a surprise —
        // and note 7.55 gives '7.5', because 7.55 is not exactly 7.55 in binary.
        expect(formatRating(7.55)).toBe('7.5');
        expect(formatRating(7.56)).toBe('7.6');
    });

    it('is null for an absent rating rather than a zero', () => {
        // 61 artists and 449 albums here have none, and "0" beside them would
        // read as a verdict instead of as silence.
        expect(formatRating(null)).toBeNull();
        expect(formatRating(undefined)).toBeNull();
        expect(formatRating(Number.NaN)).toBeNull();
    });

    it('shows a genuine zero as a zero', () => {
        expect(formatRating(0)).toBe('0');
    });
});
