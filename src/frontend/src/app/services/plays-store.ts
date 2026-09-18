import { Injectable, inject } from '@angular/core';
import { MusicboxApi } from './musicbox-api';

/*
  What the box has played, most recent album first.

  The list is the box's and arrives on the stream, so there is nothing to fetch
  and nothing to cache. Note it is NOT in LibraryStore: that cache is dropped
  when a scan finishes, and a play has nothing to do with a scan.
*/
@Injectable({ providedIn: 'root' })
export class PlaysStore {
    private readonly box = inject(MusicboxApi);

    /** Null before the first frame. */
    readonly albums = this.box.plays;
}
