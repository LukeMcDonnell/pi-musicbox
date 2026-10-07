import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MultiPick, type PickOption } from './multi-pick';

@Component({
    imports: [MultiPick],
    template: `<app-multi-pick title="Artists" [options]="options" [(selected)]="selected" [(open)]="open" />`,
})
class Host {
    readonly options: PickOption[] = [{ name: 'AC/DC' }, { name: 'Björk', detail: '120' }, { name: 'Tool' }];
    readonly selected = signal<string[]>(['Tool']);
    readonly open = signal(true);
}

function create() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const rows = () => [...el.querySelectorAll('[role="checkbox"] .flex-1')].map((name) => name.textContent!.trim());
    return { fixture, el, rows };
}

describe('MultiPick', () => {
    it('lists what was selected first, ticked', () => {
        const { el, rows } = create();
        expect(rows()).toEqual(['Tool', 'AC/DC', 'Björk']);
        expect(el.querySelector('[role="checkbox"]')!.getAttribute('aria-checked')).toBe('true');
        expect(el.querySelectorAll('[role="checkbox"]')[2]!.textContent).toContain('120');
    });

    it('toggles, without moving a row under the finger', () => {
        const { fixture, el, rows } = create();
        (el.querySelectorAll('[role="checkbox"]')[1] as HTMLButtonElement).click();
        fixture.detectChanges();
        expect(fixture.componentInstance.selected()).toEqual(['Tool', 'AC/DC']);
        expect(rows()).toEqual(['Tool', 'AC/DC', 'Björk']);
        (el.querySelector('[role="checkbox"]') as HTMLButtonElement).click();
        expect(fixture.componentInstance.selected()).toEqual(['AC/DC']);
    });

    it('filters without regard to accents or punctuation', () => {
        const { fixture, el, rows } = create();
        const field = el.querySelector('input') as HTMLInputElement;
        field.value = 'bjork';
        field.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        expect(rows()).toEqual(['Björk']);
        field.value = 'acdc';
        field.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        expect(rows()).toEqual(['AC/DC']);
    });

    it('clears, and closes on Done', () => {
        const { fixture, el } = create();
        const buttons = [...el.querySelectorAll('button')];
        buttons.find((b) => b.textContent!.trim() === 'Clear')!.click();
        expect(fixture.componentInstance.selected()).toEqual([]);
        buttons.find((b) => b.textContent!.trim() === 'Done')!.click();
        fixture.detectChanges();
        expect(fixture.componentInstance.open()).toBeFalse();
        expect(el.querySelector('[role="dialog"]')).toBeNull();
    });
});
