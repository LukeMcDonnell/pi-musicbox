import { ChangeDetectionStrategy, Component, booleanAttribute, computed, input, output } from '@angular/core';
import { CoverArt } from '../cover-art/cover-art';

/**
 * A playlist's covers: four as a 2×2, otherwise the first alone, otherwise the
 * projected fallback. Thumbnails throughout — a tile is a quarter of its box.
 * The host sets the size.
 */
@Component({
    selector: 'app-cover-grid',
    imports: [CoverArt],
    template: `
        @for (uri of shown(); track uri) {
            <app-cover-art class="h-full w-full" [uri]="uri" thumb [lazy]="lazy()" (failed)="failed.emit($event)" />
        } @empty {
            <span class="place-self-center"><ng-content /></span>
        }
    `,
    host: {
        class: 'grid overflow-hidden',
        '[class.grid-cols-2]': 'shown().length === 4',
        '[class.grid-rows-2]': 'shown().length === 4',
    },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CoverGrid {
    /** Resolved cover URLs, already without any that failed. */
    readonly uris = input<readonly string[]>([]);
    readonly lazy = input(false, { transform: booleanAttribute });
    readonly failed = output<string>();

    readonly shown = computed(() => {
        const uris = this.uris();
        return uris.length >= 4 ? uris.slice(0, 4) : uris.slice(0, 1);
    });
}
