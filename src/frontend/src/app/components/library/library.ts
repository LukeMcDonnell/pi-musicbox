import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import {
    VirtualScrollerComponent,
    VirtualScrollerModule,
} from '@iharbeck/ngx-virtual-scroller';
import { LucideUserRound } from '@lucide/angular';
import type { ArtistSummary } from '@musicbox/shared';
import { LibraryStore } from '../../library-store';
import { ScrollFrame } from '../../scroll-frame';

/*
  The Library screen: every artist in the library, in one list.

  A LIST, NOT A GRID. The row carries three things — picture, name, and how many
  albums — and a grid of 487 square covers gives up the last two to fit more of
  the first. This is the same row the queue uses, for the same reasons.

  MPD'S ORDER, UNCHANGED. The backend returns `list album group albumartist`,
  which MPD sorts by AlbumArtist, and that is what is rendered. No letter
  headers, no index rail, no stripping of a leading "The" — `!!!` and `2Pac` sit
  ahead of the letters and `The Panics` sits under T, because those are MPD's
  answers and a second opinion about sorting is a thing to maintain forever.

  REPAINTS: no transitions, no animations, every picture in a box fixed by its
  width and height attributes, so a decode never moves a row. This is the longest
  list in the UI and scrolling it is the most repaint-heavy thing here; on the
  DSI panel every repaint is a vc4 atomic commit. See
  .claude/docs/clock-deadlock.md.

  VIRTUALISED, AND ONLY IN ONE SENSE. 13 to 19 rows exist at a time instead of
  487, measured at 800x480 against the real library. The page is still 31,232px
  tall — the scroller swaps the rows for a spacer of the same height, so nothing
  about the scrollbar or a fling changes — and the
  pictures are still 1000x1000 JPEGs drawn at 48x48, so what dropped is the
  NUMBER of decodes, not the cost of one. It also bought some churn: a row
  leaving the window is destroyed, so scrolling back up decodes its picture
  again. The response is in the HTTP cache; the decoded bitmap is not. `/api/art`
  serving a thumbnail is the half of this that fixes cost-per-decode, and it is
  still open — see the renderer-crash entry in .claude/docs/roadmap.md, which
  this does not close.

  THE SCROLLER IS <main>, WHICH THIS COMPONENT DOES NOT OWN. app.html explains
  why the page scrolls there rather than in the window. So the list is
  `parentScroll`-ed onto that element instead of being given a viewport of its
  own, and the element arrives through ScrollFrame — read its header before
  reaching for `closest('main')`, which answers null here and fails silently.

  THE RESIZE CONTRACT. `checkResizeInterval` is off, because its default is a
  1Hz getBoundingClientRect on <main> for as long as this screen is mounted, and
  the same OnPush reasoning applies: nothing should touch these rows while
  nothing has changed. In its place is a window resize listener, which is
  sufficient only while every change to <main>'s box is viewport-driven — the
  46rem width switch, the `short:` height variant, 100dvh moving as phone
  browser chrome hides, zoom. The now-playing sheet is `fixed inset-0` and does
  not resize it. Chrome that ever appears in the flow above or beside <main>
  would break this quietly.

  ONE KNOWN ROUGH EDGE: a row holding keyboard focus that is destroyed at the
  buffer edge drops focus to <body>, so the next Tab restarts at the top of the
  page. It costs the panel nothing (no keyboard) and there is no cheap fix in
  this scroller.
*/

/**
 * The height of one row, in pixels.
 *
 * The scroller is told this rather than measuring: 48px of avatar (`size-12`)
 * plus `py-2` top and bottom, which beats the `min-h-[3.5rem]` floor, and both
 * text lines are `truncate` so nothing can wrap a row taller. It is the same row
 * the queue uses.
 *
 * A CONSTANT THE TEMPLATE CANNOT DISAGREE WITH. Every index the scroller
 * computes comes from this number, so a change to the row's padding that misses
 * this line would break scrolling with every assertion still green. library.spec
 * measures a rendered row against it for that reason.
 */
export const ROW_HEIGHT = 64;

@Component({
    selector: 'app-library',
    imports: [LucideUserRound, VirtualScrollerModule],
    templateUrl: './library.html',
    // The scroller's own resize polling is off; this is what replaces it. See
    // THE RESIZE CONTRACT above for what that does and does not cover.
    host: { '(window:resize)': 'onResize()' },
    // The rows depend on nothing but signals. There is no reason to re-check
    // them when the 1Hz now-playing ticker fires — and the scroller's ngDoCheck
    // rides on this view being checked, so OnPush keeps that idle too.
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Library {
    private readonly library = inject(LibraryStore);
    private readonly router = inject(Router);

    /**
     * The list, from the store's cache.
     *
     * Null until the first fetch lands — which is a different state from an
     * empty library, and the template says so.
     */
    readonly artists = this.library.artists;

    readonly error = signal<string | null>(null);

    readonly loading = computed(() => this.artists() === null && this.error() === null);

    /**
     * The list as the scroller wants it: an array, never null.
     *
     * A `computed` rather than `artists() ?? []` in the template, because the
     * scroller's `items` setter compares by reference and recomputes its whole
     * geometry on any new one. An inline `?? []` hands it a fresh empty array on
     * every change-detection pass; this hands back the same one.
     */
    readonly rows = computed<ArtistSummary[]>(() => this.artists() ?? []);

    /** The <main> element, or null before App's view exists. See ScrollFrame. */
    readonly frame = inject(ScrollFrame).element;

    readonly rowHeight = ROW_HEIGHT;

    /** The rows the scroller has decided are on screen, plus its buffer. */
    readonly visible = signal<ArtistSummary[]>([]);

    /** Where `visible()` starts in the full list. Only aria-posinset needs it. */
    readonly firstIndex = signal(0);

    private readonly scroller = viewChild(VirtualScrollerComponent);

    onViewport(items: ArtistSummary[]): void {
        this.visible.set(items);
        // Read back from the refresh that produced this slice — viewPortInfo is
        // set before the event fires — so the index and the rows cannot end up a
        // frame apart. That is why this wires vsUpdate alone and not vsChange as
        // well: one event, one answer.
        this.firstIndex.set(this.scroller()?.viewPortInfo.startIndexWithBuffer ?? 0);
    }

    /** See THE RESIZE CONTRACT above. The scroller is absent while loading. */
    onResize(): void {
        this.scroller()?.refresh();
    }

    constructor() {
        // Cached after the first visit, so coming back from an album is instant
        // and costs the backend nothing. See LibraryStore.
        void this.load();
    }

    async load(): Promise<void> {
        this.error.set(null);
        try {
            await this.library.loadArtists();
        } catch (err) {
            this.error.set((err as Error).message);
        }
    }

    /**
     * Pictures that 404ed, by resolved URI.
     *
     * A Set, like the queue's: many rows fail independently, and 16 of this
     * library's artists have no image file. One miss hides the placeholder for
     * that artist and never retries.
     */
    private readonly artFailed = signal<ReadonlySet<string>>(new Set());

    /** The picture for a row, or null when there is none to show. */
    artOf(artist: ArtistSummary): string | null {
        if (!artist.image) return null;
        // Through the resolver: the server sends a root-relative path and an
        // <img> would otherwise resolve it against the PAGE's origin.
        const uri = this.library.resolve(artist.image);
        return this.artFailed().has(uri) ? null : uri;
    }

    onArtError(uri: string): void {
        this.artFailed.update((failed) => new Set(failed).add(uri));
    }

    albumsLabel(artist: ArtistSummary): string {
        return artist.albumCount === 1 ? '1 album' : `${artist.albumCount} albums`;
    }

    /**
     * Open an artist.
     *
     * The name travels as a QUERY PARAMETER, not a path segment: `AC/DC` is a
     * real artist here, and carrying that in a path means `%2F`, which routers
     * and proxies are entitled to normalise back. Same reason /api/art uses one.
     */
    open(artist: ArtistSummary): void {
        void this.router.navigate(['/library/artist'], { queryParams: { name: artist.name } });
    }
}
