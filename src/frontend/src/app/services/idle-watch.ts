import { Injectable, effect, inject } from '@angular/core';
import { IdleTimer } from './idle-timer';
import { NowPlayingSheet } from './now-playing-sheet';
import { Preferences } from './preferences';

/*
  Raises now-playing when nobody has touched THIS browser for a while.

  Off unless asked for: the Interface tab sets the delay, and its default is
  Never. Per device, like every preference on that tab — the panel and a phone
  are entitled to different answers.

  The timer discipline lives in IdleTimer, which the panel-sleep watcher shares.
*/
@Injectable({ providedIn: 'root' })
export class IdleWatch {
    private readonly prefs = inject(Preferences);
    private readonly sheet = inject(NowPlayingSheet);
    private readonly idle = inject(IdleTimer);

    constructor() {
        const watcher = this.idle.watch(this.prefs.openNowPlayingAfterIdle(), () =>
            this.sheet.show(),
        );
        effect(() => watcher.setMinutes(this.prefs.openNowPlayingAfterIdle()));
    }
}
