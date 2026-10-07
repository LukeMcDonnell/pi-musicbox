import {
    ChangeDetectionStrategy,
    Component,
    computed,
    input,
    linkedSignal,
    model,
    signal,
    untracked,
} from '@angular/core';
import { LucideCheck, LucideX } from '@lucide/angular';
import { fold, squeeze } from '../../services/text-match';

export interface PickOption {
    name: string;
    detail?: string;
}

/** A full-screen checklist with a search field. Selected entries are listed first, as they were on opening. */
@Component({
    selector: 'app-multi-pick',
    imports: [LucideCheck, LucideX],
    template: `
        @if (open()) {
          <!-- z-35, as the playlist dialog: over the menu and mini bar, under the sheet and keyboard. -->
          <div class="fixed inset-0 z-[35] flex flex-col bg-bg" role="dialog" aria-modal="true"
               [attr.aria-label]="title()">
            <div class="flex items-center gap-2 px-4 pt-2">
              <h2 class="min-w-0 flex-1 truncate text-xl font-bold">{{ title() }}</h2>
              <button type="button"
                      class="min-h-11 cursor-pointer touch-manipulation rounded-full px-4 text-[0.95rem]
                             text-muted select-none active:bg-raised disabled:opacity-40"
                      [disabled]="selected().length === 0" (click)="selected.set([])">
                Clear
              </button>
              <button type="button"
                      class="min-h-11 cursor-pointer touch-manipulation rounded-full bg-accent px-5
                             text-[0.95rem] font-semibold text-on-accent select-none active:bg-raised"
                      (click)="open.set(false)">
                Done
              </button>
            </div>
            <div class="relative px-4 py-2">
              <!-- text-base: iOS zooms on focus below 16px. -->
              <input #field type="text" enterkeyhint="search" autocomplete="off" spellcheck="false"
                     [attr.aria-label]="'Filter ' + title()" placeholder="Filter"
                     class="h-11 w-full rounded-lg border border-raised bg-surface px-3 pe-11 text-base text-text
                            placeholder:text-muted focus:border-accent focus:outline-none"
                     [value]="query()" (input)="query.set(field.value)">
              @if (query()) {
                <button type="button" aria-label="Clear the filter"
                        class="absolute end-4 top-2 grid size-11 cursor-pointer place-items-center text-muted"
                        (click)="query.set(''); field.focus()">
                  <svg lucideX class="size-5" aria-hidden="true"></svg>
                </button>
              }
            </div>
            <ul class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              @for (option of shown(); track option.name) {
                <li>
                  <button type="button" role="checkbox" [attr.aria-checked]="chosen().has(option.name)"
                          class="flex min-h-12 w-full cursor-pointer touch-manipulation items-center gap-3
                                 rounded-md px-1 text-left select-none active:bg-raised"
                          (click)="toggle(option.name)">
                    <span class="grid size-6 flex-none place-items-center rounded border-2"
                          [class]="chosen().has(option.name) ? 'border-accent bg-accent text-on-accent' : 'border-muted'">
                      @if (chosen().has(option.name)) {
                        <svg lucideCheck class="size-4" aria-hidden="true"></svg>
                      }
                    </span>
                    <span class="min-w-0 flex-1 truncate text-[1.05rem]">{{ option.name }}</span>
                    @if (option.detail) {
                      <span class="flex-none text-[0.85rem] text-muted tabular-nums">{{ option.detail }}</span>
                    }
                  </button>
                </li>
              } @empty {
                <li class="py-6 text-[0.95rem] text-muted">Nothing matches.</li>
              }
            </ul>
          </div>
        }
    `,
    host: { class: 'contents', '(document:keydown.escape)': 'open.set(false)' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MultiPick {
    readonly title = input.required<string>();
    readonly options = input.required<readonly PickOption[]>();
    readonly selected = model<string[]>([]);
    readonly open = model(false);

    /** Cleared each time the list opens. */
    readonly query = linkedSignal({ source: this.open, computation: () => '' });
    readonly chosen = computed(() => new Set(this.selected()));
    /** Fixed when the list opens, so a row does not jump away from the finger that ticked it. */
    private readonly pinned = linkedSignal(() => (this.open() ? new Set(untracked(this.selected)) : new Set<string>()));

    readonly shown = computed(() => {
        const q = fold(this.query().trim());
        const sq = squeeze(q);
        const pinned = this.pinned();
        const matches = this.options().filter((o) => {
            if (q === '') return true;
            const name = fold(o.name);
            return name.includes(q) || (sq !== '' && squeeze(name).includes(sq));
        });
        return [...matches.filter((o) => pinned.has(o.name)), ...matches.filter((o) => !pinned.has(o.name))];
    });

    toggle(name: string): void {
        this.selected.update((names) => (names.includes(name) ? names.filter((n) => n !== name) : [...names, name]));
    }
}
