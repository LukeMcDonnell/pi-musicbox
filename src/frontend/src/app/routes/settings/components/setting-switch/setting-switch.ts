import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/*
  One row of the settings screen: a label, and a switch that is the whole row.

  The row is the target, not just the switch — a 48px control at the far right
  of an 800px panel is a poor thing to ask a thumb for when the whole row can be
  the button.

  role="switch" rather than a checkbox: there is no form here and nothing is
  submitted; the change applies as it is made.

  No transition on the knob. Every repaint on the DSI panel is a vc4 atomic
  commit — see the ticker comment in now-playing.ts.
*/
@Component({
    selector: 'app-setting-switch',
    template: `
        <button type="button" role="switch" [attr.aria-checked]="checked()"
                class="flex min-h-14 w-full cursor-pointer touch-manipulation items-center gap-4
                       rounded-lg px-2 py-2 text-left select-none active:bg-raised"
                (click)="toggled.emit(!checked())">
            <span class="min-w-0 flex-1 text-[1rem]">{{ label() }}</span>
            <span class="relative h-7 w-12 flex-none rounded-full"
                  [class]="checked() ? 'bg-accent' : 'bg-raised'"
                  aria-hidden="true">
                <span class="absolute top-1 size-5 rounded-full"
                      [class]="checked() ? 'right-1 bg-on-accent' : 'left-1 bg-muted'"></span>
            </span>
        </button>
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingSwitch {
    readonly label = input.required<string>();
    readonly checked = input.required<boolean>();

    /** The value the row was tapped towards. The owner of the setting writes it. */
    readonly toggled = output<boolean>();
}
