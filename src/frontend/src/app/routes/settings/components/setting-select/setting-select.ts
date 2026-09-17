import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    computed,
    effect,
    input,
    output,
    signal,
    viewChild,
    viewChildren,
} from '@angular/core';
import { LucideCheck, LucideChevronDown } from '@lucide/angular';

/** One choice. Shaped to match the option lists in preferences.ts. */
export interface SettingOption {
    value: number;
    label: string;
}

/*
  One row of the settings screen: a label, the current answer, and a list of the
  others behind it.

  NOT A <select>. The panel runs chromium under cage, where a native select
  popup is a wayland popup surface — one more thing to be wrong on a screen
  nobody can debug from. This is the same modal the power button uses, on the
  same screen, and it gives thirteen options a list that scrolls properly at
  480px tall instead of a dropdown that has to fit.
*/
@Component({
    selector: 'app-setting-select',
    imports: [LucideCheck, LucideChevronDown],
    template: `
        <button #trigger type="button"
                class="flex min-h-14 w-full cursor-pointer touch-manipulation items-center gap-3
                       rounded-lg py-2 text-left select-none active:bg-raised"
                [class.px-2]="!flush()" [attr.aria-label]="triggerLabel() === undefined ? null : label() + ': ' + current()"
                aria-haspopup="listbox" [attr.aria-expanded]="open()"
                (click)="open.set(true)">
            <span class="min-w-0 flex-1 text-[1rem]">{{ triggerLabel() ?? label() }}</span>
            <span class="flex-none text-[0.95rem] font-semibold text-accent">{{ current() }}</span>
            <svg lucideChevronDown class="size-5 flex-none text-muted" aria-hidden="true"></svg>
        </button>

        @if (open()) {
            <!-- z-35: see the power button, which this matches. -->
            <div class="fixed inset-0 z-[35] grid place-items-center bg-black/70 p-4"
                 (click)="close()">
                <div class="flex max-h-[80dvh] w-full max-w-sm flex-col rounded-xl border
                            border-raised bg-surface p-4"
                     role="dialog" aria-modal="true" [attr.aria-label]="label()"
                     (click)="$event.stopPropagation()">
                    <h2 class="flex-none pb-2 text-lg font-bold">{{ label() }}</h2>
                    <div class="-mx-2 min-h-0 flex-1 overflow-y-auto px-2" role="listbox"
                         [attr.aria-label]="label()">
                        @for (option of options(); track option.value) {
                            <button #choice type="button" role="option"
                                    [attr.aria-selected]="option.value === value()"
                                    class="flex min-h-12 w-full cursor-pointer touch-manipulation
                                           items-center gap-3 rounded-lg px-3 text-left
                                           text-[1rem] select-none active:bg-raised
                                           aria-selected:text-accent"
                                    (click)="choose(option.value)">
                                <span class="min-w-0 flex-1">{{ option.label }}</span>
                                @if (option.value === value()) {
                                    <svg lucideCheck class="size-5 flex-none" aria-hidden="true"></svg>
                                }
                            </button>
                        }
                    </div>
                </div>
            </div>
        }
    `,
    // Escape closes from anywhere, like the power modal.
    host: { class: 'contents', '(document:keydown.escape)': 'close()' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingSelect {
    readonly label = input.required<string>();
    /** Shown on the row instead of `label`, which still titles the dialog. */
    readonly triggerLabel = input<string>();
    /** No side padding, for a row that must line up with the page's edge. */
    readonly flush = input(false);
    readonly value = input.required<number>();
    readonly options = input.required<readonly SettingOption[]>();

    /** The value that was chosen. The owner of the setting writes it. */
    readonly selected = output<number>();

    readonly open = signal(false);

    readonly current = computed(
        () => this.options().find((option) => option.value === this.value())?.label ?? '',
    );

    private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
    private readonly choices = viewChildren<ElementRef<HTMLButtonElement>>('choice');

    constructor() {
        // Focus the current answer, which also scrolls a long list to it.
        effect(() => {
            if (!this.open()) return;
            const index = this.options().findIndex((option) => option.value === this.value());
            this.choices()[Math.max(0, index)]?.nativeElement.focus();
        });
    }

    choose(value: number): void {
        this.selected.emit(value);
        this.close();
    }

    close(): void {
        if (!this.open()) return;
        this.open.set(false);
        this.trigger().nativeElement.focus();
    }
}
