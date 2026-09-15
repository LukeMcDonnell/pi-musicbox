import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    effect,
    inject,
    signal,
    viewChild,
} from '@angular/core';
import { LucidePower, LucideRotateCw } from '@lucide/angular';
import { ApiClient } from '../../../../services/api-client';

/** What the modal offers. */
export type PowerAction = 'restart' | 'shutdown';

/*
  The power control in the Settings header: a button, and a modal asking which.

  A MODAL, NOT A DROPDOWN. Both choices end the session and the panel is
  touch-only, so a 44px menu item under a thumb is how the box gets shut down by
  accident. This way the second tap is the deliberate one, and both choices get
  a full-width target.

  THE SERVER CANNOT DO THIS ITSELF. It has NoNewPrivileges and one capability,
  and no child_process by design, so POST /api/power/<action> drops a file that a
  root path unit acts on. See src/backend/src/power.ts.

  Once a choice is made the modal stays up and says what is happening, because
  the alternative is a UI that looks idle while the box is going down — and on
  shutdown nothing else will ever arrive to correct it.
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
    private readonly client = inject(ApiClient);

    readonly open = signal(false);

    /** The action under way, once one has been chosen. */
    readonly pending = signal<PowerAction | null>(null);

    readonly error = signal<string | null>(null);

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
        // Not while the box is going down: there is nothing to go back to, and
        // a settings screen that reappears mid-shutdown reads as "it failed".
        if (!this.open() || this.pending() !== null) return;
        this.open.set(false);
        this.error.set(null);
        this.trigger().nativeElement.focus();
    }

    async choose(action: PowerAction): Promise<void> {
        if (this.pending() !== null) return;
        this.pending.set(action);
        this.error.set(null);
        try {
            await this.client.post(`/api/power/${action}`);
        } catch (err) {
            // 503 on a box where setup-server.sh has not run. Say so and let the
            // modal be dismissed again — nothing is going to happen.
            this.error.set((err as Error).message);
            this.pending.set(null);
        }
    }
}
