import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    effect,
    signal,
    viewChild,
} from '@angular/core';
import { LucidePower, LucideRotateCw } from '@lucide/angular';

/** What the modal offers. Nothing acts on it yet — see the header. */
export type PowerAction = 'restart' | 'shutdown';

/*
  The power control in the Settings header: a button, and a modal asking which.

  A MODAL, NOT A DROPDOWN. Both choices end the session and the panel is
  touch-only, so a 44px menu item under a thumb is how the box gets shut down by
  accident. This way the second tap is the deliberate one, and both choices get
  a full-width target.

  NOT WIRED. There is no power endpoint on the backend, so choosing either
  option only closes the modal.
*/
@Component({
    selector: 'app-power-button',
    imports: [LucidePower, LucideRotateCw],
    templateUrl: './power-button.html',
    host: {
        class: 'contents',
        // Escape closes from anywhere: the modal is inert until something
        // inside it has focus, and that is not guaranteed on a phone.
        '(document:keydown.escape)': 'hide()',
    },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PowerButton {
    readonly open = signal(false);

    private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
    private readonly cancel = viewChild<ElementRef<HTMLButtonElement>>('cancel');

    constructor() {
        // Focus lands on Cancel, not on an action: an Enter held from the tap
        // that opened this must not shut the box down.
        effect(() => {
            if (this.open()) this.cancel()?.nativeElement.focus();
        });
    }

    show(): void {
        this.open.set(true);
    }

    hide(): void {
        if (!this.open()) return;
        this.open.set(false);
        this.trigger().nativeElement.focus();
    }

    /** Inert until the backend has somewhere to send this. */
    choose(action: PowerAction): void {
        void action;
        this.hide();
    }
}
