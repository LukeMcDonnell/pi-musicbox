import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { LucideHeart } from '@lucide/angular';
import { FavouritesStore } from '../../services/favourites-store';

/**
 * A heart that favourites one album. Sits inside tappable rows, so it stops its own click.
 * The fill hangs off aria-pressed: Lucide's own class binding wipes a [class.x] on the svg.
 */
@Component({
    selector: 'app-favourite-button',
    imports: [LucideHeart],
    template: `
        @if (variant() === 'pill') {
            <button type="button"
                    class="flex min-h-8 cursor-pointer touch-manipulation items-center gap-2
                           rounded-full border border-muted px-4 text-[0.95rem] font-semibold
                           text-muted select-none active:bg-raised disabled:opacity-40
                           aria-pressed:border-accent aria-pressed:text-accent aria-pressed:*:fill-current"
                    [disabled]="busy()" [attr.aria-pressed]="on()" [attr.aria-label]="label()"
                    (click)="toggle($event)">
                <svg lucideHeart class="size-5" aria-hidden="true"></svg>
            </button>
        } @else {
            <button type="button"
                    class="grid size-11 flex-none cursor-pointer touch-manipulation place-items-center
                           rounded-full text-muted select-none active:bg-raised disabled:opacity-40
                           aria-pressed:text-accent aria-pressed:*:fill-current"
                    [disabled]="busy()" [attr.aria-pressed]="on()" [attr.aria-label]="label()"
                    (click)="toggle($event)">
                <svg lucideHeart class="size-5" aria-hidden="true"></svg>
            </button>
        }
    `,
    host: { class: 'contents' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FavouriteButton {
    private readonly favourites = inject(FavouritesStore);

    readonly albumArtist = input.required<string>();
    readonly album = input.required<string>();
    readonly variant = input<'pill' | 'icon'>('icon');

    /** The server's reason, when a toggle is refused. */
    readonly failed = output<string>();

    readonly busy = signal(false);
    readonly on = computed(() => this.favourites.isFavourite(this.albumArtist(), this.album()));
    readonly label = computed(() =>
        this.on() ? `Remove ${this.album()} from favourites` : `Add ${this.album()} to favourites`,
    );

    async toggle(event: Event): Promise<void> {
        event.stopPropagation();
        if (this.busy()) return;
        this.busy.set(true);
        try {
            await this.favourites.toggle({ albumArtist: this.albumArtist(), album: this.album() });
        } catch (err) {
            this.failed.emit((err as Error).message);
        } finally {
            this.busy.set(false);
        }
    }
}
