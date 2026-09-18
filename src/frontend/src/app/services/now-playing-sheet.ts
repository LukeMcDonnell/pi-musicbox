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
 *
 * IT OWNS A HISTORY ENTRY while open: a same-URL entry marked in history.state,
 * so browser Back closes the sheet and Forward reopens it. The router skips
 * same-URL popstates, so neither is a navigation.
 */

import { Location } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** The history.state key marking the entry the open sheet owns. */
export const NOW_PLAYING_STATE = 'musicboxNowPlaying';

/** How long hide() waits for its own Back before giving up on the popstate. */
const BACK_TIMEOUT_MS = 500;

@Injectable({ providedIn: 'root' })
export class NowPlayingSheet {
    private readonly location = inject(Location);

    private readonly _open = signal(false);
    private readonly _atQueue = signal(false);

    readonly open = this._open.asReadonly();

    /**
     * An open that has asked for the queue and has not reached it yet.
     *
     * A REQUEST, NOT A POSITION. The queue does not render until a snapshot says
     * there is one, which is a round trip after an album was added, so this stays
     * set until NowPlaying has actually scrolled and calls settled().
     */
    readonly atQueue = this._atQueue.asReadonly();

    /** Resolves the hide() waiting on the popstate its own Back causes. */
    private backed: (() => void) | null = null;

    constructor() {
        // A reload lands on a marked entry with the sheet closed; unmark it rather
        // than leave an entry whose Back would appear to do nothing.
        if (this.onOwnEntry()) {
            this.location.replaceState(this.location.path(true), '', this.stateWith(false));
        }
        const popstates = this.location.subscribe(() => {
            const open = this.onOwnEntry();
            this._open.set(open);
            if (!open) this._atQueue.set(false);
            this.backed?.();
        });
        inject(DestroyRef).onDestroy(() => popstates.unsubscribe());
    }

    show(): void {
        this.raise(false);
    }

    /** Open on the queue — see atQueue. */
    showQueue(): void {
        this.raise(true);
    }

    /** NowPlaying, once the queue is on screen. */
    settled(): void {
        this._atQueue.set(false);
    }

    /**
     * Close, popping the entry the sheet owns so Forward can reopen it.
     *
     * Resolves once that Back has landed, true if there was an entry to pop.
     * The router still has to process the popstate after that — see NowPlaying.follow.
     */
    hide(): Promise<boolean> {
        this._open.set(false);
        this._atQueue.set(false);
        if (!this.onOwnEntry()) return Promise.resolve(false);
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                if (this.backed === done) this.backed = null;
                resolve(true);
            };
            const timer = setTimeout(done, BACK_TIMEOUT_MS);
            this.backed = done;
            this.location.back();
        });
    }

    private raise(atQueue: boolean): void {
        if (!this._open() && !this.onOwnEntry()) {
            this.location.go(this.location.path(true), '', this.stateWith(true));
        }
        this._open.set(true);
        this._atQueue.set(atQueue);
    }

    private onOwnEntry(): boolean {
        const state = this.location.getState();
        return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[NOW_PLAYING_STATE] === true;
    }

    /** The current state with the marker set or cleared, keeping the router's own keys. */
    private stateWith(marked: boolean): Record<string, unknown> {
        const current = this.location.getState();
        const state = typeof current === 'object' && current !== null ? { ...(current as Record<string, unknown>) } : {};
        if (marked) state[NOW_PLAYING_STATE] = true;
        else delete state[NOW_PLAYING_STATE];
        return state;
    }
}
