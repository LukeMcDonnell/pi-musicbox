import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { IS_PANEL } from '../../../../services/panel-client';
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

/**
 * Defaults to the panel, where the scroll is instant — the row has moved by the
 * time a click returns, so nothing has to wait on an animation. Pass
 * `{ panel: false }` for the phone, which scrolls smoothly.
 */
function create({ panel = true }: { panel?: boolean } = {}) {
    TestBed.configureTestingModule({
        imports: [Host],
        providers: [provideRouter([]), { provide: IS_PANEL, useValue: panel }],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return fixture;
}

/** What a click asked the rail for, without letting it actually animate. */
function behaviorOf(fixture: ReturnType<typeof create>, button: 0 | 1): ScrollBehavior {
    const scrollBy = spyOn(rail(fixture), 'scrollBy');
    buttons(fixture)[button].click();
    return (scrollBy.calls.mostRecent().args[0] as ScrollToOptions).behavior!;
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

    /* The panel is the one device where an animated scroll is not free: a repaint
       per frame is a vc4 atomic commit per frame, and clock-deadlock.md is open.
       Everywhere else it is a phone or a desktop browser and costs nothing. */
    it('scrolls smoothly on a phone', () => {
        expect(behaviorOf(create({ panel: false }), 1)).toBe('smooth');
    });

    it('scrolls instantly on the panel', () => {
        expect(behaviorOf(create(), 1)).toBe('auto');
    });

    it('scrolls instantly on a phone too when reduced motion is asked for', () => {
        const fixture = create({ panel: false });
        spyOn(window, 'matchMedia').and.returnValue({ matches: true } as MediaQueryList);
        expect(behaviorOf(fixture, 1)).toBe('auto');
    });

    /* The arrows' own state is the thing a smooth scroll could break: `scrollBy`
       returns before the row has moved, so the measurement has to come from the
       scroll events it emits on the way. Real animation, really waited on. */
    it('the arrows still catch up after a smooth scroll has settled', async () => {
        const fixture = create({ panel: false });
        expect(buttons(fixture)[0].disabled).toBe(true);

        buttons(fixture)[1].click();
        const deadline = Date.now() + 2_000;
        while (rail(fixture).scrollLeft === 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 16));
        }
        // Settle: wait for scrollLeft to stop changing.
        let last = -1;
        while (last !== rail(fixture).scrollLeft && Date.now() < deadline) {
            last = rail(fixture).scrollLeft;
            await new Promise((r) => setTimeout(r, 50));
        }
        fixture.detectChanges();

        expect(rail(fixture).scrollLeft).toBeGreaterThan(0);
        expect(buttons(fixture)[0].disabled).toBe(false);
    });
});
