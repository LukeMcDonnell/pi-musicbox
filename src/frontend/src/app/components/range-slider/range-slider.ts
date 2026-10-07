import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import type { Range } from '@musicbox/shared';

/** A min/max pair on one track: two range inputs laid over each other. */
@Component({
    selector: 'app-range-slider',
    template: `
        <div class="relative h-11">
            <div class="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-raised"></div>
            <div class="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent"
                 [style.left.%]="percent(value().min)" [style.right.%]="100 - percent(value().max)"></div>
            <input #low type="range" [min]="min()" [max]="max()" [step]="step()" [value]="value().min"
                   [class.z-1]="lowOnTop()" [attr.aria-label]="label() + ' from'"
                   [attr.aria-valuetext]="format()(value().min)"
                   (input)="setMin(low)">
            <input #high type="range" [min]="min()" [max]="max()" [step]="step()" [value]="value().max"
                   [attr.aria-label]="label() + ' to'" [attr.aria-valuetext]="format()(value().max)"
                   (input)="setMax(high)">
        </div>
    `,
    // Only the thumbs take touches, so either can be reached where the inputs overlap.
    styles: `
        input {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            margin: 0;
            appearance: none;
            background: transparent;
            pointer-events: none;
            touch-action: none;
        }
        input::-webkit-slider-thumb {
            appearance: none;
            pointer-events: auto;
            width: 1.75rem;
            height: 1.75rem;
            border-radius: 9999px;
            background: var(--color-text);
            border: 3px solid var(--color-accent);
            cursor: pointer;
        }
        input::-moz-range-thumb {
            pointer-events: auto;
            width: 1.75rem;
            height: 1.75rem;
            border-radius: 9999px;
            background: var(--color-text);
            border: 3px solid var(--color-accent);
            cursor: pointer;
        }
        input:focus-visible::-webkit-slider-thumb {
            outline: 2px solid var(--color-accent);
            outline-offset: 2px;
        }
    `,
    host: { class: 'block' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RangeSlider {
    readonly min = input.required<number>();
    readonly max = input.required<number>();
    readonly step = input(1);
    readonly label = input.required<string>();
    readonly format = input<(value: number) => string>(String);
    readonly value = model.required<Range>();

    /** Both thumbs at the top: the low one must be the one a drag picks up. */
    readonly lowOnTop = computed(() => this.value().min >= this.max());

    percent(value: number): number {
        const span = this.max() - this.min();
        return span <= 0 ? 0 : ((value - this.min()) / span) * 100;
    }

    setMin(el: HTMLInputElement): void {
        const min = Math.min(Number(el.value), this.value().max);
        el.value = String(min);
        this.value.set({ min, max: this.value().max });
    }

    setMax(el: HTMLInputElement): void {
        const max = Math.max(Number(el.value), this.value().min);
        el.value = String(max);
        this.value.set({ min: this.value().min, max });
    }
}
