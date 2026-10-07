import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Range } from '@musicbox/shared';
import { RangeSlider } from './range-slider';

@Component({
    imports: [RangeSlider],
    template: `<app-range-slider label="Era" [min]="1960" [max]="2020" [(value)]="value" />`,
})
class Host {
    readonly value = signal<Range>({ min: 1970, max: 1990 });
}

function create() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const [low, high] = [...(fixture.nativeElement as HTMLElement).querySelectorAll('input')];
    return { fixture, low: low!, high: high! };
}

function slide(input: HTMLInputElement, value: number): void {
    input.value = String(value);
    input.dispatchEvent(new Event('input'));
}

describe('RangeSlider', () => {
    it('labels each thumb and starts where it is told', () => {
        const { low, high } = create();
        expect(low.getAttribute('aria-label')).toBe('Era from');
        expect(high.getAttribute('aria-label')).toBe('Era to');
        expect(low.value).toBe('1970');
        expect(high.value).toBe('1990');
    });

    it('moves either end, and never lets them cross', () => {
        const { fixture, low, high } = create();
        slide(low, 1980);
        expect(fixture.componentInstance.value()).toEqual({ min: 1980, max: 1990 });
        slide(high, 1975);
        expect(fixture.componentInstance.value()).toEqual({ min: 1980, max: 1980 });
        expect(high.value).toBe('1980');
        slide(low, 2000);
        expect(fixture.componentInstance.value()).toEqual({ min: 1980, max: 1980 });
    });
});
