import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ThumbSrc } from './thumb-src';

@Component({
    imports: [ThumbSrc],
    template: `<img [appThumbSrc]="uri" alt="" (failed)="failed.push($event)">`,
})
class Host {
    uri = '/api/art?album=A';
    readonly failed: string[] = [];
}

function create(uri?: string) {
    TestBed.configureTestingModule({ imports: [Host] });
    const fixture = TestBed.createComponent(Host);
    if (uri !== undefined) fixture.componentInstance.uri = uri;
    fixture.detectChanges();
    const img = () => fixture.nativeElement.querySelector('img') as HTMLImageElement;
    const fail = () => {
        img().dispatchEvent(new Event('error'));
        fixture.detectChanges();
    };
    return { fixture, img, fail };
}

describe('ThumbSrc', () => {
    it('asks for the thumbnail first', () => {
        const { img } = create();
        expect(img().getAttribute('src')).toBe('/api/art/thumb?album=A');
    });

    it('falls back to the original when the thumbnail is not built yet', () => {
        const { fixture, img, fail } = create();
        fail();
        expect(img().getAttribute('src')).toBe('/api/art?album=A');
        expect(fixture.componentInstance.failed).toEqual([]);
    });

    it('reports the ORIGINAL only when it fails too', () => {
        const { fixture, fail } = create();
        fail();
        fail();
        expect(fixture.componentInstance.failed).toEqual(['/api/art?album=A']);
    });

    it('tries the thumbnail again for a new cover', () => {
        const { fixture, img, fail } = create();
        fail();
        fixture.componentInstance.uri = '/api/art?album=B';
        fixture.detectChanges();
        expect(img().getAttribute('src')).toBe('/api/art/thumb?album=B');
    });

    it('maps CD covers and passes anything else straight through', () => {
        expect(create('/api/cd/art?release=r').img().getAttribute('src')).toBe('/api/cd/art/thumb?release=r');
        TestBed.resetTestingModule();
        const { fixture, img, fail } = create('/elsewhere.jpg');
        expect(img().getAttribute('src')).toBe('/elsewhere.jpg');
        fail();
        expect(fixture.componentInstance.failed).toEqual(['/elsewhere.jpg']);
    });
});
