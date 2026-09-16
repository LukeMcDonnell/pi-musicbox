/**
 * Whether there is somewhere in this app to go back to, and going there.
 *
 * THE BACK ARROWS ARE REAL HISTORY BACK. They used to navigate to a fixed
 * parent — "up, not back" — which meant the browser's own restoration never
 * fired for them, and coming back from an artist lost both the place in the
 * 487-row list and the `?filter=` term it was filtered by. See the scroll
 * restoration entry in .claude/docs/decisions.md.
 *
 * WHICH NEEDS A FALLBACK, because `location.back()` off the first entry leaves
 * the app entirely: a phone opening a bookmarked artist, or a panel reloaded on
 * one. So this counts the in-app entries behind the current one.
 *
 * Angular's own navigations are the reason that count is not `history.length`:
 * the initial navigation and every popstate are `replaceUrl`, and so is every
 * keystroke in the library filter.
 */

import { Location } from '@angular/common';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import type { NavigationExtras } from '@angular/router';

@Injectable({ providedIn: 'root' })
export class AppHistory {
    private readonly router = inject(Router);
    private readonly location = inject(Location);

    /** In-app entries behind this one. */
    private behind = 0;

    /** The id of the navigation that created the entry we are on. */
    private entry = 0;

    private trigger: 'imperative' | 'popstate' | 'hashchange' = 'imperative';
    private restored = 0;
    private replacing = false;

    constructor() {
        const navigations = this.router.events.subscribe((event) => {
            if (event instanceof NavigationStart) {
                this.trigger = event.navigationTrigger ?? 'imperative';
                this.restored = event.restoredState?.navigationId ?? 0;
                this.replacing = this.router.currentNavigation()?.extras.replaceUrl === true;
            } else if (event instanceof NavigationEnd) {
                this.arrived(event.id);
            }
        });
        inject(DestroyRef).onDestroy(() => navigations.unsubscribe());
    }

    private arrived(id: number): void {
        // A popstate is also `replaceUrl` — the router is syncing to a move the
        // browser already made — so this order matters.
        if (this.trigger === 'popstate') {
            // Ids grow with history order, so a smaller one is behind us. An
            // unknown target counts as back: the cost of being wrong that way is
            // an arrow that goes up instead of back, never one that leaves.
            const back = this.restored === 0 || this.restored < this.entry;
            this.behind = Math.max(0, this.behind + (back ? -1 : 1));
            this.entry = this.restored || id;
        } else if (this.replacing) {
            // The entry is rewritten, not added — the initial navigation, and
            // every keystroke in the library filter.
            this.entry = id;
        } else {
            this.behind += 1;
            this.entry = id;
        }
    }

    canGoBack(): boolean {
        return this.behind > 0;
    }

    /** Back, or `commands` when this screen is the first thing that loaded. */
    back(commands: unknown[], extras?: NavigationExtras): void {
        if (this.canGoBack()) {
            this.location.back();
        } else {
            void this.router.navigate(commands, extras);
        }
    }
}
