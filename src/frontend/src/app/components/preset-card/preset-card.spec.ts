import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { GENERATOR_PRESETS } from '@musicbox/shared';
import { PresetCard } from './preset-card';

@Component({
    imports: [PresetCard],
    template: `<app-preset-card [preset]="preset" [busy]="busy()" (play)="played = played + 1" />`,
})
class Host {
    readonly preset = GENERATOR_PRESETS.find((p) => p.id === 'hidden-gems')!;
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

    it('spins while its preset starts', () => {
        const fixture = TestBed.createComponent(Host);
        fixture.componentInstance.busy.set(true);
        fixture.detectChanges();
        const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(button.querySelector('svg.animate-spin')).not.toBeNull();
    });
});
