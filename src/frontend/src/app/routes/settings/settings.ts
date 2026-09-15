import { ChangeDetectionStrategy, Component, ElementRef, signal, viewChildren } from '@angular/core';
import { InterfaceSettings } from './components/interface-settings/interface-settings';
import { LibrarySettings } from './components/library-settings/library-settings';
import { PowerButton } from './components/power-button/power-button';
import { SystemSettings } from './components/system-settings/system-settings';

/*
  The Settings screen: a header carrying the power control, three tabs, and one
  panel.

  THE TAB IS NOT A ROUTE. Child routes would put it in the URL, which buys a
  bookmark nobody makes — the panel has no address bar — at the cost of a nested
  outlet and three more entries in app.routes. The tabs are plain components
  under components/, switched by a signal.

  All three are eager, like the routes are: the whole bundle comes off the Pi's
  own disk, so a lazy tab would only add a fetch to the first tap.
*/
export const TABS = [
    { id: 'interface', label: 'Interface' },
    { id: 'library', label: 'Library' },
    { id: 'system', label: 'System' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

@Component({
    selector: 'app-settings',
    imports: [PowerButton, InterfaceSettings, LibrarySettings, SystemSettings],
    templateUrl: './settings.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Settings {
    readonly tabs = TABS;

    readonly active = signal<TabId>('interface');

    // Static and in TABS order, so an index into one indexes the other.
    private readonly buttons = viewChildren<ElementRef<HTMLButtonElement>>('tabButton');

    select(id: TabId): void {
        this.active.set(id);
    }

    /** Arrow keys move between tabs, as the tabs pattern expects of a tablist. */
    onKeydown(event: KeyboardEvent): void {
        const last = this.tabs.length - 1;
        const from = this.tabs.findIndex((tab) => tab.id === this.active());
        let to: number;
        switch (event.key) {
            case 'ArrowRight': to = from === last ? 0 : from + 1; break;
            case 'ArrowLeft': to = from === 0 ? last : from - 1; break;
            case 'Home': to = 0; break;
            case 'End': to = last; break;
            default: return;
        }
        event.preventDefault();
        this.select(this.tabs[to].id);
        this.buttons()[to]?.nativeElement.focus();
    }
}
