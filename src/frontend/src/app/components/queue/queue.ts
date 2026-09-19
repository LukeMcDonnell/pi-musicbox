import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideMusic } from '@lucide/angular';
import type { Track } from '@musicbox/shared';
import { MusicboxApi } from '../../services/musicbox-api';
import { clock } from '../now-playing/now-playing';
import { CoverArt } from '../cover-art/cover-art';

/** Which half of the queue is on screen. */
type Tab = 'back' | 'next';

/*
  The queue, beneath the now-playing screen.

  IT IS TWO LISTS, NOT ONE, and the playing track is in neither: that track is
  the whole screen above this one, and repeating it here as a highlighted row
  would be the third place the same thing is said. So the queue is split at
  `queuePosition` — everything before it under "Back to", everything after under
  "Up next", which is the one people want and so is the default.

  BACK TO RUNS BACKWARDS. In queue order the track you just heard would be the
  LAST row, at the bottom of a possibly long list; the tab exists to get back to
  something a moment ago, so the nearest track is the first row.

  The listing itself is fetched by MusicboxApi, not here — see the queue signal
  there. This component only renders it.

  REPAINTS: no transitions, no animations, and every cover is `loading="lazy"`
  with a fixed box. Scrolling this list is the most repaint-heavy thing the UI
  does, and on the DSI panel every repaint is a vc4 atomic commit — see the
  ticker comment in now-playing.ts and .claude/docs/clock-deadlock.md.
*/
@Component({
    selector: 'app-queue',
    imports: [CoverArt, LucideMusic],
    templateUrl: './queue.html',
    // The list is up to a few hundred rows and none of them depend on anything
    // but signals, so there is no reason to re-check them on every unrelated
    // event — and the 1Hz ticker next door is exactly such an event.
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Queue {
    private readonly api = inject(MusicboxApi);

    readonly tab = signal<Tab>('next');

    private readonly tracks = this.api.queue;

    /**
     * Where to split, from the SNAPSHOT rather than from the listing.
     *
     * `queuePosition` is authoritative: it comes from MPD's `status`, so it is
     * still right when `currentsong` returns nothing. See src/shared/api.ts.
     *
     * Null means nothing is selected — MPD stopped with a queue loaded. Then
     * nothing has been played yet and the entire queue is up next.
     */
    private readonly position = computed(() => this.api.snapshot()?.queuePosition ?? null);

    readonly upNext = computed(() => {
        const pos = this.position();
        return pos === null ? this.tracks() : this.tracks().slice(pos + 1);
    });

    /** Most recent first — see the header. */
    readonly backTo = computed(() => {
        const pos = this.position();
        return pos === null ? [] : this.tracks().slice(0, pos).reverse();
    });

    readonly rows = computed(() => (this.tab() === 'next' ? this.upNext() : this.backTo()));

    /**
     * Whether there is a queue worth showing at all.
     *
     * False collapses the section to nothing, which leaves the page exactly one
     * viewport tall and unscrollable — the state it was in before this existed.
     * That is the honest answer for a Bluetooth source: `queueVersion` is -1,
     * there is no listing to be had, and an empty "Up next" would imply the
     * phone had told us its queue was empty. It has told us nothing.
     */
    readonly visible = this.api.hasQueue;

    readonly error = signal<string | null>(null);

    /**
     * Covers that 404ed, by resolved URI.
     *
     * A Set rather than the single signal now-playing uses: many rows can fail
     * independently here, and about 7.5% of this library's albums have no cover
     * file. Keyed by album directory like the URI itself, so one miss hides the
     * placeholder for every track on that album and none of them retries.
     */
    private readonly artFailed = signal<ReadonlySet<string>>(new Set());

    /** The cover URI for a row, or null when there is none to show. */
    artOf(track: Track): string | null {
        if (!track.image) return null;
        // Through the resolver: the server sends a root-relative path and an
        // <img> would otherwise resolve it against the PAGE's origin. See
        // MusicboxApi.resolve.
        const uri = this.api.resolve(track.image);
        return this.artFailed().has(uri) ? null : uri;
    }

    onArtError(uri: string): void {
        this.artFailed.update((failed) => new Set(failed).add(uri));
    }

    titleOf(track: Track): string {
        return track.title || track.file || 'Unknown track';
    }

    durationOf(track: Track): string {
        return clock(track.duration ?? null);
    }

    async play(track: Track): Promise<void> {
        // No id means this row did not come from the queue and there is nothing
        // to address. It cannot happen for an MPD listing; it is here so that it
        // stays a no-op rather than a `playid undefined` if it ever does.
        if (track.id === undefined) return;
        this.error.set(null);
        try {
            await this.api.playQueueId(track.id);
            // Deliberately no local change: the new position arrives on the next
            // snapshot and re-splits both lists. Guessing would move the row
            // under the finger before MPD had agreed to it.
        } catch (err) {
            this.error.set((err as Error).message);
        }
    }
}
