import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DECADE_PRESETS, GENERATOR_PRESETS } from '@musicbox/shared';
import { PresetCard } from './preset-card';

@Component({
    imports: [PresetCard],
    template: `<app-preset-card [preset]="preset" [busy]="busy()" (play)="played = played + 1" />`,
})
class Host {
    preset = GENERATOR_PRESETS.find((p) => p.id === 'hidden-gems')!;
    readonly busy = signal(false);
    played = 0;
}

describe('PresetCard', () => {
    it('shows the name and description, and plays on a tap', () => {
        const fixture = TestBed.createComponent(Host);
        fixture.detectChanges();
        const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
        expect(button.getAttribute('aria-label')).toBe('Play Hidden Gems');
        expect(button.textContent).toContain('Lesser-known artists at their best');
        expect(button.querySelector('svg')).not.toBeNull();
        button.click();
        expect(fixture.componentInstance.played).toBe(1);
    });

    it('shows a decade as text in place of the icon, until it starts', () => {
        const fixture = TestBed.createComponent(Host);
        fixture.componentInstance.preset = DECADE_PRESETS.find((p) => p.id === 'decade-2000s')!;
        fixture.detectChanges();
        const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
        expect(button.textContent).toContain('2000s');
        expect(button.querySelector('svg')).toBeNull();
        fixture.componentInstance.busy.set(true);
        fixture.detectChanges();
        expect(button.querySelector('svg.animate-spin')).not.toBeNull();
    });

    it('spins while its preset starts', () => {
        const fixture = TestBed.createComponent(Host);
        fixture.componentInstance.busy.set(true);
        fixture.detectChanges();
        const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(button.querySelector('svg.animate-spin')).not.toBeNull();
    });
});
