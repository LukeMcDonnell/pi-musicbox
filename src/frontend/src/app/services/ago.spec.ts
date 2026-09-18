import { ago, clockLabel } from './ago';

describe('ago', () => {
    it('says how long ago without a date for anything recent', () => {
        const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
        expect(ago(now - 30_000, now)).toBe('just now');
        expect(ago(now - 20 * 60_000, now)).toBe('20 minutes ago');
        // Twelve-hour, like the hour picker: "today at 4:02" alone is ambiguous.
        expect(ago(new Date(2026, 0, 15, 4, 2, 0).getTime(), now)).toBe('today at 4:02 am');
        expect(ago(new Date(2026, 0, 14, 16, 2, 0).getTime(), now)).toBe('yesterday at 4:02 pm');
        expect(ago(new Date(2026, 0, 12, 4, 0, 0).getTime(), now)).toBe('3 days ago');
    });

    it('falls back to a date once a week has passed', () => {
        const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
        expect(ago(new Date(2025, 11, 1, 4, 0, 0).getTime(), now)).toContain('2025');
    });
});

describe('clockLabel', () => {
    it('reads as a wall clock, midnight and noon included', () => {
        expect(clockLabel(0, 0)).toBe('12:00 am');
        expect(clockLabel(12, 0)).toBe('12:00 pm');
        expect(clockLabel(6, 59)).toBe('6:59 am');
        expect(clockLabel(23, 5)).toBe('11:05 pm');
    });
});
