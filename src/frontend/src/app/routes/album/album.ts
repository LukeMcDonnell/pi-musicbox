import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideChevronLeft, LucideDisc3, LucideListPlus, LucidePlay } from '@lucide/angular';
import type { AlbumRef, AlbumResponse, Track } from '@musicbox/shared';
import { AppHistory } from '../../services/app-history';
import { LibraryStore } from '../../services/library-store';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { Preferences } from '../../services/preferences';
import { Rating } from '../../components/rating/rating';
import { clock } from '../../components/now-playing/now-playing';
import { FavouriteButton } from '../../components/favourite-button/favourite-button';
import { CoverArt } from '../../components/cover-art/cover-art';

/*
  One album: its cover as a hero, two buttons, and the tracks.

  PLAY REPLACES, QUEUE APPENDS, and they are two buttons rather than one with a
  modifier because they are two different intentions — one of them throws away
  what you were listening to. The backend keeps them as two routes for the same
  reason.

  Neither does an optimistic update. The result arrives on the next snapshot,
  which is the rule everywhere in this UI: guessing shows the wrong state
  confidently whenever a command is genuinely refused.

  GROUPED BY DISC, and numbered by the `Track` tag rather than by position. 313
  of this library's albums span more than one disc and each disc starts at 1, so
  numbering rows by their place in the list ran Music Bank from 1 to 48. The
  backend still decides the ORDER — directory, then disc, then track number.

  Each disc heading carries its own Play and Queue, which narrow the same two
  POSTs with a `disc` on the AlbumRef. Play still replaces the queue.

  Rows are not tappable. These tracks have no MPD song id — they are library
  songs, not queue entries — so there is nothing for `POST /api/queue/play/:id`
  to address. Play the album.
*/
@Component({
    selector: 'app-album',
    imports: [
        CoverArt,
        FavouriteButton,
        Rating,
        RouterLink,
        LucideChevronLeft,
        LucideDisc3,
        LucideListPlus,
        LucidePlay,
    ],
    templateUrl: './album.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Album {
    private readonly library = inject(LibraryStore);
    private readonly sheet = inject(NowPlayingSheet);
    private readonly prefs = inject(Preferences);
    private readonly router = inject(Router);
    private readonly history = inject(AppHistory);

    /** Bound from `?artist=`, `?album=` and `?release=` by withComponentInputBinding(). */
    readonly artist = input<string>('');
    readonly album = input<string>('');
    readonly release = input<string>('');

    readonly data = signal<AlbumResponse | null>(null);
    readonly error = signal<string | null>(null);

    readonly loading = computed(() => this.data() === null && this.error() === null);
    readonly tracks = computed(() => this.data()?.tracks ?? []);

    /** True while a Play or Queue request is in flight, so it cannot be double-sent. */
    readonly busy = signal(false);

    private readonly artFailed = signal<string | null>(null);

    readonly cover = computed(() => {
        const image = this.data()?.album.image ?? null;
        if (!image) return null;
        const uri = this.library.resolve(image);
        // Compare the RESOLVED url, because that is what onArtError() is handed.
        return uri === this.artFailed() ? null : uri;
    });

    readonly year = computed(() => {
        const date = this.data()?.album.date ?? null;
        const match = date === null ? null : /^(\d{4})/.exec(date);
        return match ? match[1] : null;
    });

    /**
     * "9 tracks · 42:17" — the second line under the title.
     *
     * Both numbers come from the server, which applies the same all-or-nothing
     * rule to the runtime: null unless every track has a duration. Computing it
     * here as well would be two implementations of one rule.
     */
    readonly summary = computed(() => {
        const album = this.data()?.album;
        if (album === undefined || album.trackCount === 0) return null;
        const count = album.trackCount === 1 ? '1 track' : `${album.trackCount} tracks`;
        return album.duration === null ? count : `${count} · ${runtime(album.duration)}`;
    });

    /** "Alternative Rock, Art Rock, …" — null when the album is untagged. */
    /**
     * The album's mark out of ten, from its `album.nfo`. Null for 449 of the
     * 3,062 albums here, which show nothing rather than a zero.
     */
    readonly rating = computed(() => this.data()?.album.rating ?? null);

    readonly genreLine = computed(() => {
        const genres = this.data()?.album.genres ?? [];
        return genres.length === 0 ? null : genres.join(', ');
    });

    /**
     * The tracks, split into discs.
     *
     * One unheaded group for the 2,562 albums that are a single disc, so the
     * common case looks untouched. `disc` is null on a group that gets no
     * heading — including a trailing group of tracks with no `Disc` tag, which
     * is rare enough here (~6 songs in 38,978) not to invent a disc for.
     */
    readonly discs = computed<DiscGroup[]>(() => {
        const tracks = this.tracks();
        if (tracks.length === 0) return [];
        if ((this.data()?.album.discCount ?? 1) <= 1) return [{ disc: null, tracks }];
        // Keyed rather than run-length: the backend orders discs contiguously,
        // and one heading per disc must hold even if that ever slips.
        const groups = new Map<string | null, DiscGroup>();
        for (const track of tracks) {
            const disc = track.disc ?? null;
            const group = groups.get(disc);
            if (group === undefined) groups.set(disc, { disc, tracks: [track] });
            else group.tracks.push(track);
        }
        // Untagged last: it is not disc zero. ~6 songs in 38,978.
        return [...groups.values()].sort((a, b) => (a.disc === null ? 1 : b.disc === null ? -1 : 0));
    });

    /** Sequence guard against two overlapping loads — see Artist for the case. */
    private request = 0;

    constructor() {
        effect(() => {
            const artist = this.artist();
            const album = this.album();
            const release = this.release();
            this.data.set(null);
            this.error.set(null);
            if (artist !== '' && album !== '' && release !== '') {
                void this.load(artist, album, release);
            }
        });
    }

    private async load(artist: string, album: string, release: string): Promise<void> {
        const request = ++this.request;
        try {
            const data = await this.library.fetchAlbum(artist, album, release);
            if (request === this.request) this.data.set(data);
        } catch (err) {
            if (request === this.request) this.error.set((err as Error).message);
        }
    }

    onArtError(uri: string): void {
        this.artFailed.set(uri);
    }

    titleOf(track: Track): string {
        return track.title || track.file || 'Unknown track';
    }

    /**
     * The track's own number, falling back to its place in the disc.
     *
     * The leading integer, because the tag arrives as `4/12` on some files —
     * the backend parses it the same way to sort on it.
     */
    numberOf(track: Track, index: number): number {
        const parsed = parseInt(track.track ?? '', 10);
        return Number.isFinite(parsed) ? parsed : index + 1;
    }

    durationOf(track: Track): string {
        return clock(track.duration ?? null);
    }

    /**
     * Clear the queue, load this album, play it — and show what is playing.
     *
     * `disc` narrows it to one disc of a set, which the disc headings offer. The
     * verb is unchanged either way: it still replaces what you were listening to.
     */
    async play(disc: string | null = null): Promise<void> {
        await this.send(() => this.library.playAlbum(this.ref(disc)));
        // Only on success: raising now-playing over a request that was refused
        // would show a stale screen as though the button had worked. Whether it
        // is raised at all is the user's, on the Interface tab.
        if (this.error() === null && this.prefs.openNowPlayingOnPlay()) this.sheet.show();
    }

    /** Append to the queue, and show where it landed if that is wanted. */
    async queue(disc: string | null = null): Promise<void> {
        await this.send(() => this.library.queueAlbum(this.ref(disc)));
        if (this.error() === null && this.prefs.openQueueOnAdd()) this.sheet.showQueue();
    }

    /** The key is OMITTED for a whole album — `disc: null` would fail validation. */
    private ref(disc: string | null = null): AlbumRef {
        return {
            albumArtist: this.artist(),
            album: this.album(),
            release: this.release(),
            ...(disc === null ? {} : { disc }),
        };
    }

    private async send(action: () => Promise<void>): Promise<void> {
        if (this.busy()) return;
        this.busy.set(true);
        this.error.set(null);
        try {
            await action();
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.busy.set(false);
        }
    }

    back(): void {
        // Real history back, with the artist as the fallback for a screen that
        // was loaded straight into. See AppHistory.
        this.history.back(['/library/artist'], { queryParams: { name: this.artist() } });
    }
}

/** One disc's worth of tracks. `disc` is null when the group gets no heading. */
export interface DiscGroup {
    disc: string | null;
    tracks: Track[];
}

/**
 * A whole album's length, as h:mm:ss or m:ss.
 *
 * Not `clock()`, which is the per-track m:ss and would render an 82 minute album
 * as "82:14". Albums routinely run past an hour here.
 */
function runtime(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const ss = String(secs).padStart(2, '0');
    return hours > 0 ? `${hours}:${String(mins).padStart(2, '0')}:${ss}` : `${mins}:${ss}`;
}
