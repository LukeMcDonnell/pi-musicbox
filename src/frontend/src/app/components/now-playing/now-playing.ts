import {
    Component,
    ElementRef,
    Injector,
    OnDestroy,
    afterNextRender,
    computed,
    effect,
    inject,
    output,
    signal,
    viewChild,
} from '@angular/core';
// Lucide ships one standalone component per icon, so only those imported reach the
// bundle. They render inline SVG stroked with currentColor — no icon font, no
// network request, which is what the kiosk needs when the NAS is off.
import {
    LucideMusic,
    LucidePause,
    LucidePlay,
    LucideSkipBack,
    LucideSkipForward,
    LucideBluetooth,
    LucideChevronDown,
    LucideX,
} from '@lucide/angular';
import { NavigationCancel, NavigationEnd, NavigationError, NavigationSkipped, Router } from '@angular/router';
import { filter, firstValueFrom, timer } from 'rxjs';
import type { PlaybackCommand } from '@musicbox/shared';
import { MusicboxApi } from '../../services/musicbox-api';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { Queue } from '../queue/queue';

/** Seconds as m:ss, or a dash when there is nothing to show. */
export function clock(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds)) return '–:––';
    const total = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(total / 60);
    return `${mins}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * What the DAC is being fed: "FLAC 24/96", "MP3 16/44.1".
 *
 * BOTH HALVES, because neither says it alone. `format` is the DECODED stream, so
 * every MP3 here reads 16/44.1 exactly as a CD rip does; `encoding` is the
 * container and says nothing about rate or depth. Either may be missing, and
 * whatever is present is shown.
 *
 * Null when both are, so the badge simply does not appear — MPD emits `dsd64:2`
 * for DSD and `*` for a component it cannot determine, and a Bluetooth track has
 * neither field. A guess is worse than no badge.
 */
export function audioFormat(format: string | undefined, encoding?: string): string | null {
    const parts = [encoding, sampleFormat(format)].filter((p) => p);
    return parts.length === 0 ? null : parts.join(' ');
}

/** MPD's raw `Format` — `<rate>:<bits>:<channels>` — as "24/96". */
function sampleFormat(format: string | undefined): string | null {
    if (!format) return null;
    const [rate, bits, channels] = format.split(':');
    if (!/^\d+$/.test(rate) || !/^\d+$/.test(bits)) return null;
    const khz = String(Number(rate) / 1000).replace(/\.0$/, '');
    // Channels only when it is not the stereo everything here is.
    const suffix = /^\d+$/.test(channels ?? '') && channels !== '2' ? ` · ${channels}ch` : '';
    return `${bits}/${khz}${suffix}`;
}

/*
  Sized for two targets: a 800x480 DSI panel viewed at arm's length with touch,
  and a phone in the hand. Controls are deliberately large — the panel has no
  pointer, and a 44px minimum is the smallest reliably tappable target.

  There is no volume control: this box feeds a preamp and power amp which own
  that job. See install/setup-mpd.sh.

  Styling is Tailwind utilities in the template; there is no stylesheet. The
  host classes below are the one thing a template cannot express.

  `bg-bg` shows through wherever there is no cover: no art, or a Bluetooth
  source, which never has any (src/shared/api.ts).

  NOTHING here may add transform, filter or will-change: any of the three makes
  the host the containing block for its position: fixed children, and the
  backdrop and the bottom progress bar would silently stop being screen-sized.
*/
/** Longest follow() waits for the router to process the sheet's Back. */
const SYNC_TIMEOUT_MS = 500;

@Component({
    selector: 'app-now-playing',
    imports: [
        LucideMusic,
        LucidePause,
        LucidePlay,
        LucideSkipBack,
        LucideSkipForward,
        LucideBluetooth,
        LucideChevronDown,
        LucideX,
        Queue,
    ],
    templateUrl: './now-playing.html',
    // No min-h-dvh: the content sets the height now — one viewport of
    // now-playing, then however much queue there is.
    host: { class: 'block bg-bg h-dvh w-dvw overflow-hidden' },
})
export class NowPlaying implements OnDestroy {
    private readonly api = inject(MusicboxApi);

    readonly snapshot = this.api.snapshot;
    readonly stream = this.api.stream;
    readonly mpdAvailable = this.api.mpdAvailable;
    readonly hasQueue = this.api.hasQueue;

    /**
     * The user wants this view dismissed. The parent owns whether it is shown —
     * see app.html — so this only asks.
     */
    readonly close = output<void>();

    private readonly queueEl = viewChild('queue', { read: ElementRef });

    /**
     * Bring the queue on screen.
     *
     * INSTANT, not smooth. A smooth scroll is a repaint per frame for the best
     * part of a second, and on the DSI panel every one of those is a vc4 atomic
     * commit — the path implicated in the clock deadlock. Touch scrolling costs
     * the same thing and is unavoidable; a button that does it need not.
     */
    scrollToQueue(): void {
        const el = this.queueEl()?.nativeElement as HTMLElement | undefined;
        el?.scrollIntoView({ block: 'start' });
    }

    private readonly sheet = inject(NowPlayingSheet);
    private readonly router = inject(Router);

    artistHref(ref: { albumArtist: string }): string {
        return this.router.serializeUrl(this.router.createUrlTree(['/library/artist'], { queryParams: { name: ref.albumArtist } }));
    }

    albumHref(ref: { albumArtist: string; album: string; release: string }): string {
        return this.router.serializeUrl(
            this.router.createUrlTree(['/library/album'], {
                queryParams: { artist: ref.albumArtist, album: ref.album, release: ref.release },
            }),
        );
    }

    /**
     * Close the sheet, then open the page. Not a routerLink: closing pops the
     * sheet's history entry, and navigating before that lands would put the page
     * on top of it, so Back from the page would reopen the sheet.
     */
    async follow(event: MouseEvent, url: string): Promise<void> {
        // A modified click opens a new tab as any link does.
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        // The router syncs to a popstate a task later; navigating before it has
        // would have that sync replace the new page with the one underneath.
        const synced = firstValueFrom(
            this.router.events.pipe(
                filter((e) => e instanceof NavigationSkipped || e instanceof NavigationEnd ||
                    e instanceof NavigationCancel || e instanceof NavigationError),
            ),
        );
        if (await this.sheet.hide()) await Promise.race([synced, firstValueFrom(timer(SYNC_TIMEOUT_MS))]);
        await this.router.navigateByUrl(url);
    }
    private readonly injector = inject(Injector);

    constructor() {
        // Opened on the queue rather than on the track — the Queue button on an
        // album, when the user has asked for that. Whether this view is SHOWN is
        // still App's business; this only reads the request.
        //
        // It waits for hasQueue() because the album was added a moment ago and
        // the section does not exist until a snapshot says there is a queue;
        // scrolling before that lands on a zero-high element. afterNextRender,
        // because the row it is scrolling to is rendered by this same change.
        effect(() => {
            if (!this.sheet.atQueue() || !this.hasQueue()) return;
            this.sheet.settled();
            afterNextRender(() => this.scrollToQueue(), { injector: this.injector });
        });
    }

    /** Advanced locally between snapshots so the progress bar moves smoothly. */
    private readonly tick = signal(0);

    readonly elapsed = computed(() => {
        this.tick(); // re-evaluate on every tick
        return this.api.elapsedNow();
    });

    readonly elapsedLabel = computed(() => clock(this.elapsed()));
    readonly durationLabel = computed(() => clock(this.snapshot()?.duration ?? null));

    /** "FLAC 24/96" — what the DAC is actually being fed. Null when unknown. */
    readonly formatLabel = computed(() => {
        const track = this.snapshot()?.track;
        return audioFormat(track?.format, track?.encoding);
    });

    readonly progress = computed(() => {
        const duration = this.snapshot()?.duration ?? null;
        const elapsed = this.elapsed();
        if (duration === null || elapsed === null || duration <= 0) return 0;
        return Math.min(100, (elapsed / duration) * 100);
    });

    readonly playing = computed(() => this.snapshot()?.state === 'play');

    /** scaleX rather than width — see the comment in app.scss for why it matters. */
    readonly progressTransform = computed(() => `scaleX(${this.progress() / 100})`);

    /** The connected Bluetooth device, or null. */
    readonly bluetooth = this.api.bluetooth;

    /**
     * True when a phone owns the DAC.
     *
     * Used only to decide what EXTRA to show — the device chip and the disconnect
     * button. The now-playing block itself is source-agnostic, because the
     * snapshot's top-level fields describe whichever source is active.
     */
    readonly onBluetooth = computed(() => this.snapshot()?.source === 'bluetooth');

    /** The playing album, when the library can open it: an MPD track with both tags. */
    readonly libraryAlbum = computed(() => {
        const snap = this.snapshot();
        const track = snap?.track;
        // The release too: the album screen is keyed by it, and without one there
        // is no album page to link to — four self-titled Weezers share a title.
        if (snap?.source !== 'mpd' || !track?.albumArtist || !track.album || !track.release) {
            return null;
        }
        return { albumArtist: track.albumArtist, album: track.album, release: track.release };
    });

    /** "Luke's iPhone · aptX HD", or just the name until the codec is known. */
    readonly bluetoothLine = computed(() => {
        const bt = this.bluetooth();
        if (!bt) return null;
        return bt.codec ? `${bt.name} · ${bt.codec}` : bt.name;
    });

    /** Best available name for a track, whatever source it came from. */
    readonly trackTitle = computed(() => {
        const track = this.snapshot()?.track;
        if (!track) return null;
        // `file` is absent for a Bluetooth track, so it cannot be the fallback it
        // is for MPD. A phone that reports nothing at all still gets a row rather
        // than a blank.
        return track.title || track.file || 'Unknown track';
    });

    /**
     * Shown instead of the now-playing block when there is nothing to show.
     *
     * Bluetooth is checked before MPD's conditions: while a phone owns the DAC,
     * MPD being stopped or unreachable is not worth reporting — it is not what
     * you are listening to.
     */
    readonly statusLine = computed(() => {
        if (this.stream() === 'offline') return 'Reconnecting to musicbox…';
        if (this.stream() === 'connecting') return 'Connecting…';
        const snap = this.snapshot();
        if (this.onBluetooth()) {
            // A connected phone with nothing playing yet. The chip below still
            // names the device, so this only has to explain the silence.
            return snap?.track ? null : 'Connected — start playing on your phone';
        }
        if (!this.mpdAvailable()) return 'MPD is not running';
        if (!snap?.track) return snap?.queueLength ? 'Stopped' : 'Nothing queued';
        return null;
    });

    /**
     * Colour for the status pill.
     *
     * The branches are in the same order, and test the same things, as the ones
     * choosing the pill's TEXT in the template — keep them that way, or the pill
     * ends up saying one thing and coloured for another. It lives here rather
     * than as three [class.x] bindings because each state is a pair of utilities,
     * and two competing `bg-*` classes on one element resolve by stylesheet
     * order, which is not something the template controls.
     */
    /** "mpd · FLAC 24/96", "bluetooth · Luke's iPhone · aptX HD", or the state alone when neither applies. */
    readonly sourceLabel = computed(() => {
        if (this.stream() !== 'live') return 'offline';
        if (this.onBluetooth()) {
            const device = this.bluetoothLine();
            return device ? `bluetooth · ${device}` : 'bluetooth';
        }
        if (!this.mpdAvailable()) return 'no mpd';
        const format = this.formatLabel();
        return format ? `mpd · ${format}` : 'mpd';
    });

    readonly pillClass = computed(() => {
        if (this.stream() !== 'live') return 'bg-warn text-white';
        if (this.onBluetooth()) return 'bg-accent text-on-accent';
        if (!this.mpdAvailable()) return 'bg-warn text-white';
        return 'bg-raised text-muted';
    });

    readonly error = signal<string | null>(null);

    /**
     * The one art URI that failed to load, if any.
     *
     * No explicit reset is needed: the URI is keyed by ALBUM, so moving to a
     * different album produces a different string and the comparison below stops
     * matching on its own. Within an album a failed cover stays hidden instead of
     * being retried on every track.
     */
    private readonly artFailed = signal<string | null>(null);

    /**
     * Cover art URI, or null when there is none to show.
     *
     * About 7.5% of the library has no cover file, so the 404 path is normal
     * rather than exceptional — hence a placeholder rather than an error.
     *
     * Because this value is identical for every track on an album, Angular does
     * not touch the <img> when the track changes: no refetch, and no repaint of
     * the image. That is deliberate — see the ticker comment below for why
     * repaints on this panel are something to spend care avoiding.
     */
    readonly artUri = computed(() => {
        const image = this.snapshot()?.track?.image ?? null;
        if (!image) return null;
        // Through the API resolver, not raw: the server sends a root-relative
        // path, and an <img> would resolve it against the PAGE's origin. With
        // environment.apiUrl pointed at the real box, raw binding fetches the art
        // from the dev server instead, and 404s.
        const resolved = this.api.resolve(image);
        // Compare the RESOLVED url, because that is what onArtError() is handed
        // by the template — comparing the raw path would never match and a failed
        // cover would flicker back on every snapshot.
        return resolved === this.artFailed() ? null : resolved;
    });

    onArtError(uri: string): void {
        this.artFailed.set(uri);
    }

    /*
     * 1Hz, and only while playing.
     *
     * This is not a style preference. Every repaint on the DSI panel becomes a
     * vc4 atomic commit, which calls the GPU firmware over the mailbox while
     * holding the kernel clock mutex — a path that has hard-locked this box.
     * At 1Hz with no CSS transition the panel commits about once a second
     * instead of ~60 times a second, which is a ~60x reduction in traffic
     * through it.
     *
     * A second of granularity is invisible on a progress bar for a 4-6 minute
     * track: one step is well under half a percent of its width. The elapsed
     * time readout only has second resolution anyway.
     */
    private readonly ticker = setInterval(() => {
        if (this.playing()) this.tick.update((n) => n + 1);
    }, 1000);

    ngOnDestroy(): void {
        clearInterval(this.ticker);
    }

    async command(name: PlaybackCommand): Promise<void> {
        this.error.set(null);
        try {
            await this.api.playback(name);
        } catch (err) {
            this.error.set((err as Error).message);
        }
    }

    async toggle(): Promise<void> {
        // Works unchanged for both sources now that `state` describes the active
        // one. It used to be the mechanism for taking the speaker back from a
        // phone — `playing()` was always false during a session, so this always
        // sent `play`, which started MPD and made the arbiter disconnect. That is
        // now an explicit Disconnect button.
        await this.command(this.playing() ? 'pause' : 'play');
    }

    /** Hand the DAC back to MPD. Leaves MPD paused where it was. */
    async disconnectBluetooth(): Promise<void> {
        this.error.set(null);
        try {
            await this.api.disconnectBluetooth();
        } catch (err) {
            this.error.set((err as Error).message);
        }
    }
}
