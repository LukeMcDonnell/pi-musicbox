/**
 * Whether the full now-playing screen is showing.
 *
 * ONE BOOLEAN, AND IT NEEDED A HOME. Now-playing is not a route — it is always
 * mounted and slides over whatever is underneath (see App) — so its visibility
 * was a private signal on App. That was right while the only thing that could
 * open it was the mini bar, which is App's own child. Playing an album from the
 * library screen should raise it too, and a routed component has no path to a
 * parent's private field.
 *
 * NOT ON MusicboxApi. This is UI chrome: which panel is on screen. That service
 * is about what the music is doing, and the Snapshot it mirrors has no business
 * growing a field for this. Keeping them apart is the whole reason it is here.
 */

import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class NowPlayingSheet {
    private readonly _open = signal(false);

    readonly open = this._open.asReadonly();

    show(): void {
        this._open.set(true);
    }

    hide(): void {
        this._open.set(false);
    }
}
