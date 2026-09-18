import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Stub: what the box has played lately. */
@Component({
    selector: 'app-recent-plays',
    templateUrl: './recent-plays.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecentPlays {}
