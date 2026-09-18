import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SHELF_SIZE } from '../../../../services/favourite-picks';
import { AlbumCard } from '../album-card/album-card';
import { ShelfSkeleton } from './shelf-skeleton';

function create() {
    TestBed.configureTestingModule({ imports: [ShelfSkeleton] });
    const fixture = TestBed.createComponent(ShelfSkeleton);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
}

describe('ShelfSkeleton', () => {
    it('stands in for a full shelf', () => {
        expect(create().querySelectorAll('[aria-hidden="true"]').length).toBe(SHELF_SIZE);
    });

    it('is nothing to read out, beyond saying it is still loading', () => {
        const host = create();
        expect(host.querySelector('.sr-only')!.textContent).toContain('Loading');
        // Nothing to tap or tab to: a blank card is not a card.
        expect(host.querySelectorAll('button, a, img').length).toBe(0);
    });

    it('does not animate — a shimmer is a vc4 atomic commit per frame', () => {
        expect(create().innerHTML).not.toMatch(/animate-|transition/);
    });

    it('goes round for a shelf of artists, and no other size changes', () => {
        TestBed.configureTestingModule({ imports: [ShelfSkeleton] });
        const fixture = TestBed.createComponent(ShelfSkeleton);
        fixture.componentRef.setInput('round', true);
        fixture.detectChanges();
        const box = (fixture.nativeElement as HTMLElement).querySelector('.aspect-square')!;
        expect(box.classList).toContain('rounded-full');
        expect(box.classList).not.toContain('rounded-md');
    });

    /* Real layout rather than a stub: the point of the blank card is that the row
       below it does not move when the albums land, and only the browser can say
       whether it does. Both rails at the panel's width. */
    it('is the size of the card it stands in for, so nothing moves when they land', () => {
        @Component({
            imports: [AlbumCard, ShelfSkeleton],
            template: `
                <div id="real" style="width: 800px; display: flex; gap: 12px">
                    <app-album-card [album]="{ album: 'A', albumArtist: 'B' }" [cover]="null" />
                </div>
                <div id="skel" style="width: 800px; display: flex; gap: 12px">
                    <app-shelf-skeleton />
                </div>
            `,
        })
        class Host {}

        TestBed.configureTestingModule({ imports: [Host] });
        const fixture = TestBed.createComponent(Host);
        fixture.detectChanges();
        const host = fixture.nativeElement as HTMLElement;
        const real = host.querySelector('#real button') as HTMLElement;
        const skel = host.querySelector('#skel [aria-hidden="true"]') as HTMLElement;
        expect([skel.offsetWidth, skel.offsetHeight])
            .toEqual([real.offsetWidth, real.offsetHeight]);
    });
});
