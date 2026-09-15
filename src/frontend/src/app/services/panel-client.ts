/**
 * Whether this browser IS the panel.
 *
 * The kiosk loads `http://localhost/` (install/setup-kiosk.sh); a phone uses the
 * hostname and `ng serve` has a port. That one fact is what tells the box's own
 * screen apart from a remote, and the backend decides the same thing from the
 * other side by looking for a loopback address (isLoopback in routes.ts).
 *
 * TWO FEATURES NEED IT NOW, which is why it is here rather than inside the
 * keyboard service where it started: the on-screen keyboard (cage runs no
 * system keyboard, phones have their own) and panel sleep (only the box's own
 * screen has a backlight to turn off, and only touches ON IT count as someone
 * being there — a phone tapping about is not).
 *
 * `?panel` forces it on anywhere, for development, the same way `?keyboard`
 * does. It is not a privilege: the backend refuses to sleep the panel for any
 * request that is not loopback, whatever the page believes about itself.
 */

import { DOCUMENT } from '@angular/common';
import { InjectionToken, inject } from '@angular/core';

export function isPanel(location: Pick<Location, 'hostname' | 'port' | 'search'>): boolean {
    if (new URLSearchParams(location.search).has('panel')) return true;
    return (
        (location.hostname === 'localhost' || location.hostname === '127.0.0.1') &&
        location.port === ''
    );
}

export const IS_PANEL = new InjectionToken<boolean>('IS_PANEL', {
    providedIn: 'root',
    factory: () => isPanel(inject(DOCUMENT).location),
});
