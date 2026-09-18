import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Shelf } from './shelf';

/* A real width and real cards: the buttons appear from measured overflow, so this
   needs layout rather than a stub. */
@Component({
    imports: [Shelf],
    template: `
        <div [style.width.px]="140">
            <app-shelf heading="From your Favourites" [link]="link()">
                @for (i of items(); track i) {
                    <div class="card" style="flex: none; width: 100px; height: 40px"></div>
                }
            </app-shelf>
        </div>
    `,
})
class Host {
    readonly items = signal<number[]>([0, 1, 2, 3, 4, 5]);
    readonly link = signal<string | null>('/favourites');
}

function create() {
    TestBed.configureTestingModule({ imports: [Host], providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return fixture;
}

function buttons(fixture: ReturnType<typeof create>): HTMLButtonElement[] {
    return Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
    );
}

function rail(fixture: ReturnType<typeof create>): HTMLElement {
    return (fixture.nativeElement as HTMLElement).querySelector('.no-scrollbar')!;
}

describe('Shelf', () => {
    it('carries its heading and a link through to the full list', () => {
        const fixture = create();
        const host = fixture.nativeElement as HTMLElement;
        expect(host.querySelector('h2')!.textContent!.trim()).toBe('From your Favourites');
        const link = host.querySelector('a')!;
        expect(link.getAttribute('href')).toBe('/favourites');
        expect(link.textContent!.trim()).toBe('See all');
    });

    it('has no link when it is not given one', () => {
        const fixture = create();
        fixture.componentInstance.link.set(null);
        fixture.detectChanges();
        expect((fixture.nativeElement as HTMLElement).querySelector('a')).toBeNull();
    });

    it('projects whatever it is given', () => {
        expect((create().nativeElement as HTMLElement).querySelectorAll('.card').length).toBe(6);
    });

    it('offers a button each way, labelled', () => {
        expect(buttons(create()).map((b) => b.getAttribute('aria-label')))
            .toEqual(['Scroll left', 'Scroll right']);
    });

    it('has no buttons at all when the row already fits', () => {
        const fixture = create();
        fixture.componentInstance.items.set([0]);
        fixture.detectChanges();
        // The row changed under it; a resize is what the host would see.
        window.dispatchEvent(new Event('resize'));
        fixture.detectChanges();
        expect(buttons(fixture).length).toBe(0);
    });

    it('starts against the left end, so only one way is open', () => {
        const fixture = create();
        expect(buttons(fixture)[0].disabled).toBe(true);
        expect(buttons(fixture)[1].disabled).toBe(false);
    });

    it('scrolls the row, and both ways open up once it has moved', () => {
        const fixture = create();
        buttons(fixture)[1].click();
        fixture.detectChanges();
        expect(rail(fixture).scrollLeft).toBeGreaterThan(0);
        expect(buttons(fixture)[0].disabled).toBe(false);
    });

    it('scrolls back', () => {
        const fixture = create();
        buttons(fixture)[1].click();
        fixture.detectChanges();
        const moved = rail(fixture).scrollLeft;
        buttons(fixture)[0].click();
        fixture.detectChanges();
        expect(rail(fixture).scrollLeft).toBeLessThan(moved);
    });
});
