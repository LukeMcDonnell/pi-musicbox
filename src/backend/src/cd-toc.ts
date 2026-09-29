/**
 * What the disc's table of contents says, with no network: which tracks are
 * audio, how long each is, and its MusicBrainz disc ID.
 */

import { createHash } from 'node:crypto';

/** As the helper reads it: frame offsets (1/75s, 150-frame pregap included). */
export interface Toc {
    first: number;
    leadout: number;
    offsets: number[];
    /** Per track: true for a data track. */
    data: boolean[];
}

export interface AudioTrack {
    /** The disc's own track number — what `cdda:///N` names. */
    number: number;
    /** Seconds. */
    duration: number;
}

const FRAMES_PER_SECOND = 75;

/** Between the last audio session and a trailing data session, as libdiscid has it. */
const SESSION_GAP_FRAMES = 11_400;

/** Where the audio ends: the lead-out, or before a trailing data track (Enhanced CD). */
function audioSpan(toc: Toc): { last: number; leadout: number } {
    let lastIndex = toc.offsets.length - 1;
    let leadout = toc.leadout;
    while (lastIndex > 0 && toc.data[lastIndex]) {
        leadout = toc.offsets[lastIndex] - SESSION_GAP_FRAMES;
        lastIndex--;
    }
    return { last: toc.first + lastIndex, leadout };
}

export function audioTracks(toc: Toc): AudioTrack[] {
    const { last, leadout } = audioSpan(toc);
    const tracks: AudioTrack[] = [];
    for (let n = toc.first; n <= last; n++) {
        const i = n - toc.first;
        if (toc.data[i]) continue;
        const end = n === last ? leadout : toc.offsets[i + 1];
        tracks.push({ number: n, duration: Math.round((end - toc.offsets[i]) / FRAMES_PER_SECOND) });
    }
    return tracks;
}

/** The MusicBrainz disc ID, by libdiscid's algorithm. */
export function discIdOf(toc: Toc): string {
    const { last, leadout } = audioSpan(toc);
    const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, '0');
    let text = hex(toc.first, 2) + hex(last, 2) + hex(leadout, 8);
    for (let i = 0; i < 99; i++) {
        const n = toc.first + i;
        text += hex(n <= last ? toc.offsets[i] : 0, 8);
    }
    return createHash('sha1')
        .update(text, 'ascii')
        .digest('base64')
        .replace(/\+/g, '.')
        .replace(/\//g, '_')
        .replace(/=/g, '-');
}
