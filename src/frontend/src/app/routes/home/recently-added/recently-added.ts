import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Stub: the albums most recently added to the library. */
@Component({
    selector: 'app-recently-added',
    templateUrl: './recently-added.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecentlyAdded {}
