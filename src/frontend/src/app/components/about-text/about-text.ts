import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { IS_PANEL } from '../../services/panel-client';

/** Characters shown before "Show more". */
export const ABOUT_LIMIT = 400;

/** One paragraph per line of the text, blank lines dropped. */
export function paragraphsOf(text: string): string[] {
    return text
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line !== '');
}

/** The text cut to `limit` characters on a word boundary, or unchanged when it fits. */
export function clip(text: string, limit: number): string {
    if (text.length <= limit) return text;
    const cut = text.slice(0, limit);
    const space = cut.search(/\s\S*$/);
    return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/*
  A biography or album intro: paragraphs, cut short behind "Show more", and
  credited when it came from Wikipedia — once the whole text is showing. The
  credit is plain text on the panel: a link there would navigate the kiosk's
  only window away from the app.
*/
@Component({
    selector: 'app-about-text',
    template: `
        @for (paragraph of paragraphs(); track $index) {
            <p class="[overflow-wrap:anywhere]" [class.pt-2]="!$first">{{ paragraph }}</p>
        }
        @if (url(); as href) {
            @if (!long() || open()) {
                <p class="pt-1 text-[0.75rem] text-muted">
                    @if (isPanel) {
                        From Wikipedia
                    } @else {
                        <a class="text-accent" [href]="href" target="_blank" rel="noopener">From Wikipedia</a>
                    }
                </p>
            }
        }
        @if (long()) {
            <button type="button"
                    class="-ms-2 flex min-h-11 cursor-pointer touch-manipulation items-center rounded-full px-2
                           text-[0.85rem] font-semibold text-accent select-none active:bg-raised"
                    [attr.aria-expanded]="open()"
                    (click)="open.set(!open())">
                {{ open() ? 'Show less' : 'Show more' }}
            </button>
        }
    `,
    host: { class: 'block' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AboutText {
    protected readonly isPanel = inject(IS_PANEL);

    readonly text = input.required<string>();
    /** The Wikipedia article, or null for text with nothing to credit. */
    readonly url = input<string | null>(null);
    readonly limit = input(ABOUT_LIMIT);

    readonly open = signal(false);

    protected readonly long = computed(() => this.text().length > this.limit());
    protected readonly paragraphs = computed(() =>
        paragraphsOf(this.open() ? this.text() : clip(this.text(), this.limit())),
    );
}
