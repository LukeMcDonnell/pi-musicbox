import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CoverArt } from './cover-art';

@Component({
    imports: [CoverArt],
    template: `
        <app-cover-art [uri]="uri" [width]="width" [height]="height" [lazy]="lazy"
                       (failed)="failed.push($event)">
            <svg class="icon" aria-hidden="true"></svg>
        </app-cover-art>
    `,
})
class Host {
    uri: string | null = null;
    width: number | null = null;
    height: number | null = null;
    lazy = false;
    readonly failed: string[] = [];
}

function create(over: Partial<Pick<Host, 'uri' | 'width' | 'height' | 'lazy'>> = {}) {
    TestBed.configureTestingModule({ imports: [Host] });
    const fixture = TestBed.createComponent(Host);
    Object.assign(fixture.componentInstance, over);
    fixture.detectChanges();
    return { fixture, host: fixture.nativeElement as HTMLElement };
}

describe('CoverArt', () => {
    it('keeps the icon under the image rather than instead of it', () => {
        const { host } = create({ uri: '/api/art?album=x' });
        const icon = host.querySelector('.icon')!;
        const img = host.querySelector('img')!;
        expect(icon).not.toBeNull();
        expect(img).not.toBeNull();
        // Under, so a picture that has arrived but has not painted is not a blank box.
        expect(icon.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('draws the icon alone until there is a picture', () => {
        const { host } = create();
        expect(host.querySelector('.icon')).not.toBeNull();
        expect(host.querySelector('img')).toBeNull();
    });

    it('reports the picture that failed, so the screen can stop asking for it', () => {
        const { fixture, host } = create({ uri: '/api/art?album=x' });
        host.querySelector('img')!.dispatchEvent(new Event('error'));
        expect(fixture.componentInstance.failed).toEqual(['/api/art?album=x']);
    });

    it('sets width and height only where the caller fixed the box', () => {
        expect(create({ uri: '/x' }).host.querySelector('img')!.hasAttribute('width')).toBeFalse();
        TestBed.resetTestingModule();
        const { host } = create({ uri: '/x', width: 48, height: 48 });
        expect(host.querySelector('img')!.getAttribute('width')).toBe('48');
        expect(host.querySelector('img')!.getAttribute('height')).toBe('48');
    });

    it('is eager unless the caller asks for lazy', () => {
        expect(create({ uri: '/x' }).host.querySelector('img')!.hasAttribute('loading')).toBeFalse();
        TestBed.resetTestingModule();
        expect(create({ uri: '/x', lazy: true }).host.querySelector('img')!.getAttribute('loading'))
            .toBe('lazy');
    });

    // decoding="async" is what stopped covers painting; see decisions.md.
    it('never decodes asynchronously', () => {
        expect(create({ uri: '/x' }).host.querySelector('img')!.hasAttribute('decoding')).toBeFalse();
    });
});
