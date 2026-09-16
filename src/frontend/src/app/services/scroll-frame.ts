/**
 * The element the page scrolls in.
 *
 * ONE ELEMENT REFERENCE, AND IT NEEDED A HOME. The page scrolls in `<main>`, not
 * in the window — App owns that element and app.html carries the reasoning, which
 * is load-bearing. A virtualised list has to attach its scroll listener to
 * whatever actually scrolls, and a routed component has no path to a field on its
 * parent. Same problem as NowPlayingSheet, same answer: App still owns the
 * wiring, this owns only the reference.
 *
 * NOT A DOM QUERY. `closest('main')` from a routed component looks equivalent and
 * is not: a routed host element is created detached and inserted after the
 * constructor runs, so it answers null. That failure is silent — a virtual
 * scroller with no frame measures itself, decides every row is on screen, and
 * renders all 487 of them looking exactly like the list that works.
 *
 * And `document.querySelector('main')` is worse: there are TWO <main> elements on
 * this page. now-playing has its own, and because the sheet is always mounted and
 * sits first in app.html, it is the one that query returns — an element that is
 * translated off screen and does not scroll. Verified while measuring this
 * change, after the first probe reported nonsense.
 *
 * Null until App's view exists, and for the life of a component mounted outside
 * the frame. Callers must handle that rather than assert it.
 *
 * TWO CONSUMERS NOW: the library's virtual scroller, and FrameViewportScroller,
 * which reads and writes scrollTop across navigations so the router can put a
 * screen back where it was left.
 */

import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ScrollFrame {
    private readonly _element = signal<HTMLElement | null>(null);

    readonly element = this._element.asReadonly();

    set(element: HTMLElement | null): void {
        this._element.set(element);
    }
}
