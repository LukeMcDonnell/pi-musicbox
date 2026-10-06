import { Directive, computed, input, output, signal } from '@angular/core';
import { thumbUriFor } from '@musicbox/shared';

/*
  An <img> that shows a cover's thumbnail, falling back to the original.

  Given the resolved ORIGINAL URI, it asks for the thumbnail first. A thumbnail
  is a 404 until the box has built it, so the first error swaps to the original;
  only the original failing too emits `failed`, with the original URI — the key
  every "stop asking" cache already uses. The fallback is per element and per
  URI: the 404 is no-store, so a new element or a new URI tries the thumbnail again.
*/
@Directive({
    selector: 'img[appThumbSrc]',
    host: { '[src]': 'src()', '(error)': 'onError()' },
})
export class ThumbSrc {
    /** The original cover URI, already resolved. */
    readonly appThumbSrc = input.required<string>();

    /** Both the thumbnail and the original failed: the original URI. */
    readonly failed = output<string>();

    /** The URI whose thumbnail has already failed, so its original is showing. */
    private readonly fellBack = signal<string | null>(null);

    protected readonly src = computed(() => {
        const uri = this.appThumbSrc();
        const thumb = thumbUriFor(uri);
        return thumb === null || this.fellBack() === uri ? uri : thumb;
    });

    protected onError(): void {
        const uri = this.appThumbSrc();
        if (thumbUriFor(uri) !== null && this.fellBack() !== uri) {
            this.fellBack.set(uri);
            return;
        }
        this.failed.emit(uri);
    }
}
