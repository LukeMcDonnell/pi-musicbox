import { TestBed } from '@angular/core/testing';
import { favouriteAlbum } from '../../../../testing/fixtures';
import { AlbumCard } from './album-card';

function create(cover: string | null = null) {
    TestBed.configureTestingModule({ imports: [AlbumCard] });
    const fixture = TestBed.createComponent(AlbumCard);
    fixture.componentRef.setInput('album', favouriteAlbum());
    fixture.componentRef.setInput('cover', cover);
    fixture.detectChanges();
    return fixture;
}

describe('AlbumCard', () => {
    it('shows the album and the artist it is filed under', () => {
        const text = (create().nativeElement as HTMLElement).textContent!;
        expect(text).toContain('Kid A');
        expect(text).toContain('Radiohead');
    });

    it('stands a disc in for a cover it has not got', () => {
        const host = create().nativeElement as HTMLElement;
        expect(host.querySelector('img')).toBeNull();
        expect(host.querySelector('svg')).not.toBeNull();
    });

    it('reports a cover that fails, so the screen can stop asking for it', () => {
        const fixture = create('/api/art?album=x');
        const failed = jasmine.createSpy('failed');
        fixture.componentInstance.failed.subscribe(failed);
        fixture.nativeElement.querySelector('img').dispatchEvent(new Event('error'));
        expect(failed).toHaveBeenCalledWith('/api/art?album=x');
    });

    it('is one button, and the whole card opens the album', () => {
        const fixture = create();
        const open = jasmine.createSpy('open');
        fixture.componentInstance.open.subscribe(open);
        fixture.nativeElement.querySelector('button').click();
        expect(open).toHaveBeenCalled();
    });
});
