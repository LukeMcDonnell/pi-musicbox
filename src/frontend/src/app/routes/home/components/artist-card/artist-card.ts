import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { LucideUserRound } from '@lucide/angular';
import type { MostPlayedArtist } from '@musicbox/shared';

/*
  One artist in a shelf: a round picture, their name and how often they played.

  THE SAME BOX AS AN AlbumCard, only round — same width clamp and `aspect-square`,
  and two lines of text under it, so the two card types sit in one rail without
  the row changing height and the skeleton fits both.

  The picture arrives already resolved and a 404 goes back out as `failed`, as on
  the album card: the screen owns the set that has failed.
*/
@Component({
    selector: 'app-artist-card',
    imports: [LucideUserRound],
    template: `
        <button type="button"
                class="flex w-[clamp(7rem,22vw,9.5rem)] flex-none snap-start cursor-pointer
                       touch-manipulation flex-col gap-2 rounded-md text-left select-none
                       active:bg-raised"
                (click)="open.emit()">
            <span class="grid aspect-square w-full place-items-center overflow-hidden rounded-full
                         bg-surface">
                @if (cover(); as uri) {
                    <img class="h-full w-full object-cover" [src]="uri" alt=""
                         loading="lazy" decoding="async" (error)="failed.emit(uri)">
                } @else {
                    <svg lucideUserRound class="size-8 text-muted" aria-hidden="true"></svg>
                }
            </span>
            <span class="w-full min-w-0">
                <span class="block truncate text-[0.95rem]">{{ artist().name }}</span>
                <span class="block truncate text-[0.8rem] text-muted">{{ playsLabel() }}</span>
            </span>
        </button>
    `,
    host: { class: 'contents' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArtistCard {
    readonly artist = input.required<MostPlayedArtist>();

    /** Resolved by the screen through LibraryStore, or null when there is none. */
    readonly cover = input<string | null>(null);

    /** The picture URI that 404ed. */
    readonly failed = output<string>();
    readonly open = output<void>();

    readonly playsLabel = computed(() => playsLabel(this.artist().plays));
}

/** "1 play", "412 plays" — shared with the screen behind the shelf. */
export function playsLabel(plays: number): string {
    return plays === 1 ? '1 play' : `${plays} plays`;
}
