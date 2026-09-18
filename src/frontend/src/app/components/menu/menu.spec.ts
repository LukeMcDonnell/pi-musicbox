import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Menu } from './menu';
import { routes } from '../../app.routes';

describe('Menu', () => {
    beforeEach(() => {
        TestBed.configureTestingModule({ imports: [Menu], providers: [provideRouter(routes)] });
    });

    it('links to every top-level screen', () => {
        const fixture = TestBed.createComponent(Menu);
        fixture.detectChanges();
        const hrefs = Array.from(
            (fixture.nativeElement as HTMLElement).querySelectorAll('a'),
            (a) => a.getAttribute('href'),
        );
        expect(hrefs).toEqual(['/home', '/library', '/favourites', '/settings']);
    });

    it('marks the current screen with aria-current, which is what styles it', async () => {
        const fixture = TestBed.createComponent(Menu);
        await TestBed.inject(Router).navigateByUrl('/favourites');
        fixture.detectChanges();
        await fixture.whenStable();
        const current = (fixture.nativeElement as HTMLElement).querySelector('[aria-current="page"]');
        expect(current?.getAttribute('href')).toBe('/favourites');
    });
});
