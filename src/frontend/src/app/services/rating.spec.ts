import { formatRating } from './rating';

describe('formatRating', () => {
    it('shows the mark out of ten as a whole percentage', () => {
        // The shapes the real files use: `8.5`, `10.0`, `8.0`.
        expect(formatRating(8.5)).toBe('85%');
        expect(formatRating(10)).toBe('100%');
        expect(formatRating(8)).toBe('80%');
        expect(formatRating(9.3)).toBe('93%');
    });

    it('rounds a half percent away rather than showing a decimal', () => {
        // Never happens: every rating in the library is written to one decimal,
        // so the conversion is exact. Pinned so the rounding is a decision.
        expect(formatRating(7.55)).toBe('76%');
        expect(formatRating(7.54)).toBe('75%');
    });

    it('is null for an absent rating rather than a zero', () => {
        // 61 artists and 449 albums here have none, and "0%" beside them would
        // read as a verdict instead of as silence.
        expect(formatRating(null)).toBeNull();
        expect(formatRating(undefined)).toBeNull();
        expect(formatRating(Number.NaN)).toBeNull();
    });

    it('shows a genuine zero as a zero', () => {
        expect(formatRating(0)).toBe('0%');
    });
});
