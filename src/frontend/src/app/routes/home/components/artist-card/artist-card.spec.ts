import { TestBed } from '@angular/core/testing';
import type { MostPlayedArtist } from '@musicbox/shared';
import { ArtistCard, playsLabel } from './artist-card';

const artist: MostPlayedArtist = { name: 'Radiohead', image: '/api/art?album=Radiohead', plays: 412 };

function create(cover: string | null = null, over: Partial<MostPlayedArtist> = {}) {
    TestBed.configureTestingModule({ imports: [ArtistCard] });
    const fixture = TestBed.createComponent(ArtistCard);
    fixture.componentRef.setInput('artist', { ...artist, ...over });
    fixture.componentRef.setInput('cover', cover);
    fixture.detectChanges();
    return fixture;
}

describe('ArtistCard', () => {
    it('shows the artist and how often they have played', () => {
        const text = (create().nativeElement as HTMLElement).textContent!;
        expect(text).toContain('Radiohead');
        expect(text).toContain('412 plays');
    });

    it('says "1 play" for the one that played once', () => {
        expect((create(null, { plays: 1 }).nativeElement as HTMLElement).textContent)
            .toContain('1 play');
        expect(playsLabel(0)).toBe('0 plays');
    });

    it('is round, where an album cover is square', () => {
        const box = (create().nativeElement as HTMLElement).querySelector('.aspect-square')!;
        expect(box.classList).toContain('rounded-full');
    });

    it('stands a figure in for a picture it has not got', () => {
        const host = create().nativeElement as HTMLElement;
        expect(host.querySelector('img')).toBeNull();
        expect(host.querySelector('svg')).not.toBeNull();
    });

    it('reports a picture that fails, so the screen can stop asking for it', () => {
        const fixture = create('/api/art?album=Radiohead');
        const failed = jasmine.createSpy('failed');
        fixture.componentInstance.failed.subscribe(failed);
        fixture.nativeElement.querySelector('img').dispatchEvent(new Event('error'));
        expect(failed).toHaveBeenCalledWith('/api/art?album=Radiohead');
    });

    it('is one button, and the whole card opens the artist', () => {
        const fixture = create();
        const open = jasmine.createSpy('open');
        fixture.componentInstance.open.subscribe(open);
        fixture.nativeElement.querySelector('button').click();
        expect(open).toHaveBeenCalled();
    });
});
