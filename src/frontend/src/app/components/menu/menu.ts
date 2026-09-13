import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { LucideHeart, LucideLibraryBig, LucideSettings } from '@lucide/angular';

/*
  The main menu: a rail down the left when there is width for it, a row along
  the bottom, beneath the mini now-playing bar, when there is not. The breakpoint is the one app.html uses to switch
  the frame between the two, and the two must move together.

  Placement — sticky or fixed, size, background — belongs to the parent and is set on the
  host in app.html. This component only lays out its own links, filling
  whatever box it is given.

  Every link is at least 44px in both directions: the panel is touch-only.

  The active link is styled through `aria-current`, which routerLinkActive sets,
  rather than by having routerLinkActive add `text-accent`. Added that way it
  sits beside the static `text-muted`, and two text colours on one element
  resolve by stylesheet order — muted won. A variant is always the later rule.
*/
@Component({
    selector: 'app-menu',
    imports: [RouterLink, RouterLinkActive, LucideLibraryBig, LucideHeart, LucideSettings],
    templateUrl: './menu.html',
    host: { class: 'block' },
})
export class Menu {}
