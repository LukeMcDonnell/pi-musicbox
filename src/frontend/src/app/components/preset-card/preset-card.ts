import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import {
    LucideEar,
    LucideFlame,
    LucideGem,
    LucideHeart,
    LucideLoaderCircle,
    LucidePackageOpen,
    LucideRadio,
    LucideRepeat,
    LucideShovel,
} from '@lucide/angular';
import type { GeneratorPreset, GeneratorPresetIcon } from '@musicbox/shared';

/** A preset's icon, by name. Sized by the host's class. */
@Component({
    selector: 'app-preset-icon',
    imports: [
        LucideEar,
        LucideFlame,
        LucideGem,
        LucideHeart,
        LucideLoaderCircle,
        LucidePackageOpen,
        LucideRadio,
        LucideRepeat,
        LucideShovel,
    ],
    template: `
        @if (busy()) {
          <svg lucideLoaderCircle class="size-full animate-spin" aria-hidden="true"></svg>
        } @else {
          @switch (icon()) {
            @case ('radio') { <svg lucideRadio class="size-full" aria-hidden="true"></svg> }
            @case ('heart') { <svg lucideHeart class="size-full" aria-hidden="true"></svg> }
            @case ('shovel') { <svg lucideShovel class="size-full" aria-hidden="true"></svg> }
            @case ('gem') { <svg lucideGem class="size-full" aria-hidden="true"></svg> }
            @case ('ear') { <svg lucideEar class="size-full" aria-hidden="true"></svg> }
            @case ('package-open') { <svg lucidePackageOpen class="size-full" aria-hidden="true"></svg> }
            @case ('repeat') { <svg lucideRepeat class="size-full" aria-hidden="true"></svg> }
            @case ('flame') { <svg lucideFlame class="size-full" aria-hidden="true"></svg> }
          }
        }
    `,
    host: { class: 'block' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PresetIcon {
    readonly icon = input.required<GeneratorPresetIcon>();
    /** A spinner in place of the icon while the preset starts. */
    readonly busy = input(false);
}

/** One preset in a Home shelf: an icon tile where an album has its cover. */
@Component({
    selector: 'app-preset-card',
    imports: [PresetIcon],
    template: `
        <button type="button"
                class="flex w-card flex-none snap-start cursor-pointer touch-manipulation flex-col gap-2
                       rounded-md text-left select-none active:bg-raised disabled:opacity-60"
                [attr.aria-label]="'Play ' + preset().name" [attr.aria-busy]="busy()" [disabled]="disabled()"
                (click)="play.emit()">
            <span class="grid aspect-square w-full place-items-center rounded-md bg-surface
                         bg-gradient-to-br from-accent/35 to-transparent text-accent">
                <app-preset-icon class="size-1/3" [icon]="preset().icon" [busy]="busy()" />
            </span>
            <span class="w-full min-w-0">
                <span class="block truncate text-[0.95rem]">{{ preset().name }}</span>
                <span class="block truncate text-[0.8rem] text-muted">{{ preset().description }}</span>
            </span>
        </button>
    `,
    host: { class: 'contents' },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PresetCard {
    readonly preset = input.required<GeneratorPreset>();
    readonly busy = input(false);
    /** Another preset is starting. */
    readonly disabled = input(false);
    readonly play = output<void>();
}
