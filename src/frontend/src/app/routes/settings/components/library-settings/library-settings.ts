import { Component } from '@angular/core';

/** The Library tab. A placeholder until there is something to put on it. */
@Component({
    selector: 'app-library-settings',
    template: `
        <h2 class="text-lg font-semibold">Library</h2>
        <p class="pt-2 text-[0.95rem] text-muted">
            The music on the NAS and how MPD scans it. Nothing to set here yet.
        </p>
    `,
})
export class LibrarySettings {}
