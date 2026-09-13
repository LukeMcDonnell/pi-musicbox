import { Routes } from '@angular/router';
import { Favourites } from './components/favourites/favourites';
import { Library } from './components/library/library';
import { Settings } from './components/settings/settings';

/*
  Eager, not loadComponent. Lazy chunks would save nothing worth having — the
  whole bundle comes off the Pi's own disk — and would add a fetch on first
  navigation to each screen.
*/
export const routes: Routes = [
    { path: '', pathMatch: 'full', redirectTo: 'library' },
    { path: 'library', component: Library, title: 'Library · musicbox' },
    { path: 'favourites', component: Favourites, title: 'Favourites · musicbox' },
    { path: 'settings', component: Settings, title: 'Settings · musicbox' },
    // The panel never types a URL, but a phone can hold a stale bookmark.
    { path: '**', redirectTo: 'library' },
];
