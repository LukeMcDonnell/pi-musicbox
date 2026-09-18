import { TestBed } from '@angular/core/testing';
import { ARTIST_ROW_HEIGHT, ArtistRow } from './artist-row';

function create(cover: string | null = null, detail = '412 plays') {
    TestBed.configureTestingModule({ imports: [ArtistRow] });
    const fixture = TestBed.createComponent(ArtistRow);
    fixture.componentRef.setInput('name', 'Radiohead');
    fixture.componentRef.setInput('cover', cover);
    fixture.componentRef.setInput('detail', detail);
    fixture.detectChanges();
    return fixture;
}

describe('ArtistRow', () => {
    it('shows the name and whatever the screen put in the second line', () => {
        const text = (create().nativeElement as HTMLElement).textContent!;
        expect(text).toContain('Radiohead');
        expect(text).toContain('412 plays');
    });

    it('stands a figure in for a picture it has not got', () => {
        const host = create().nativeElement as HTMLElement;
        expect(host.querySelector('img')).toBeNull();
        expect(host.querySelector('svg')).not.toBeNull();
    });

    it('has no Play or Queue: the library plays albums, not artists', () => {
        expect((create().nativeElement as HTMLElement).querySelectorAll('button').length).toBe(1);
    });

    it('reports a picture that fails, so the screen can stop asking for it', () => {
        const fixture = create('/api/art?album=Radiohead');
        const failed = jasmine.createSpy('failed');
        fixture.componentInstance.failed.subscribe(failed);
        fixture.nativeElement.querySelector('img').dispatchEvent(new Event('error'));
        expect(failed).toHaveBeenCalledWith('/api/art?album=Radiohead');
    });

    it('opens the artist when the row is pressed', () => {
        const fixture = create();
        const open = jasmine.createSpy('open');
        fixture.componentInstance.open.subscribe(open);
        fixture.nativeElement.querySelector('button').click();
        expect(open).toHaveBeenCalled();
    });

    it('renders exactly as tall as the constant the scroller indexes by', () => {
        const fixture = create();
        const host = document.createElement('div');
        host.style.width = '800px';
        document.body.appendChild(host);
        host.appendChild(fixture.nativeElement);
        fixture.detectChanges();
        expect((host.querySelector('button') as HTMLElement).offsetHeight)
            .toBe(ARTIST_ROW_HEIGHT);
        host.remove();
    });
});
