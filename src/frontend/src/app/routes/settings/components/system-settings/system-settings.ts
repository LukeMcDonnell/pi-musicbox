import { Component } from '@angular/core';

/** The System tab. A placeholder until there is something to put on it. */
@Component({
    selector: 'app-system-settings',
    template: `
        <h2 class="text-lg font-semibold">System</h2>
        <p class="pt-2 text-[0.95rem] text-muted">
            The box itself — network, storage and build. Nothing to set here yet.
        </p>
    `,
})
export class SystemSettings {}
