/**
 * How long ago something happened, in the words a clock-on-the-wall uses.
 *
 * Here rather than beside one screen because two of them say it: the Library tab
 * dates the last scan, and Recent Plays dates a play.
 */

/** '6:59 am'. Twelve-hour, to match the hour a scan is scheduled for. */
export function clockLabel(hour: number, minute: number): string {
    const suffix = hour < 12 ? 'am' : 'pm';
    const h = hour % 12 === 0 ? 12 : hour % 12;
    return `${h}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** 'yesterday', 'today at 4:02'. Nobody needs a date for something 20 minutes old. */
export function ago(at: number, now: number): string {
    const seconds = Math.round((now - at) / 1000);
    if (seconds < 90) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minutes ago`;
    const when = new Date(at);
    const time = clockLabel(when.getHours(), when.getMinutes());
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    if (at >= startOfToday.getTime()) return `today at ${time}`;
    if (at >= startOfToday.getTime() - 86_400_000) return `yesterday at ${time}`;
    const days = Math.floor((startOfToday.getTime() - at) / 86_400_000) + 1;
    if (days < 7) return `${days} days ago`;
    return when.toLocaleDateString();
}
