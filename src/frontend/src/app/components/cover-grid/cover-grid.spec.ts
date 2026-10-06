import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CoverGrid } from './cover-grid';

@Component({
    imports: [CoverGrid],
    template: `<app-cover-grid [uris]="uris()"><span class="fallback">icon</span></app-cover-grid>`,
})
class Host {
    readonly uris = signal<string[]>([]);
}

function render(uris: string[]) {
    TestBed.configureTestingModule({ imports: [Host] });
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.uris.set(uris);
    fixture.detectChanges();
    const grid = (fixture.nativeElement as HTMLElement).querySelector('app-cover-grid')!;
    return { tiles: grid.querySelectorAll('app-cover-art').length, grid };
}

describe('CoverGrid', () => {
    it('tiles four covers 2×2', () => {
        const { tiles, grid } = render(['a', 'b', 'c', 'd']);
        expect(tiles).toBe(4);
        expect(grid.classList).toContain('grid-cols-2');
    });

    it('shows the first alone when there are fewer than four', () => {
        const { tiles, grid } = render(['a', 'b', 'c']);
        expect(tiles).toBe(1);
        expect(grid.classList).not.toContain('grid-cols-2');
    });

    it('shows the fallback when there are none', () => {
        const { tiles, grid } = render([]);
        expect(tiles).toBe(0);
        expect(grid.querySelector('.fallback')).not.toBeNull();
    });
});
