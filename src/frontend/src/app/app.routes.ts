import { Routes } from '@angular/router';
import { Favourites } from './components/favourites/favourites';
import { Album } from './components/library/album/album';
import { Artist } from './components/library/artist/artist';
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
    /*
      Artist and album are addressed by QUERY PARAMETER, not by a path segment:
      `AC/DC` is a real artist here and album titles contain `/` too, so the
      identity would have to travel as `%2F`, which routers and proxies are
      entitled to normalise back. Same reason /api/art takes one.

      Bound to component inputs by withComponentInputBinding() — see app.config.ts.
    */
    { path: 'library/artist', component: Artist, title: 'Artist · musicbox' },
    { path: 'library/album', component: Album, title: 'Album · musicbox' },
    { path: 'favourites', component: Favourites, title: 'Favourites · musicbox' },
    { path: 'settings', component: Settings, title: 'Settings · musicbox' },
    // The panel never types a URL, but a phone can hold a stale bookmark.
    { path: '**', redirectTo: 'library' },
];
