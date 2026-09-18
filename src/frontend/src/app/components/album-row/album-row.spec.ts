import { TestBed } from '@angular/core/testing';
import { ALBUM_ROW_HEIGHT, AlbumRow } from './album-row';

function create(over: { cover?: string | null; subtitle?: string; busy?: boolean } = {}) {
    TestBed.configureTestingModule({ imports: [AlbumRow] });
    const fixture = TestBed.createComponent(AlbumRow);
    fixture.componentRef.setInput('album', { album: 'Kid A', albumArtist: 'Radiohead' });
    fixture.componentRef.setInput('cover', over.cover ?? null);
    fixture.componentRef.setInput('subtitle', over.subtitle ?? 'Radiohead · 2000');
    fixture.componentRef.setInput('busy', over.busy ?? false);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const button = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
    return { fixture, host, button };
}

describe('AlbumRow', () => {
    it('shows the album, the line under it, and Queue before Play', () => {
        const { host } = create();
        expect(host.querySelector('.text-xl')!.textContent!.trim()).toBe('Kid A');
        expect(host.textContent).toContain('Radiohead · 2000');
        const labels = [...host.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
        expect(labels).toEqual([null, 'Add Kid A to the queue', 'Play Kid A']);
    });

    it('reports every press to whoever owns the list', () => {
        const { fixture, host, button } = create();
        const seen: string[] = [];
        fixture.componentInstance.open.subscribe(() => seen.push('open'));
        fixture.componentInstance.queue.subscribe(() => seen.push('queue'));
        fixture.componentInstance.play.subscribe(() => seen.push('play'));
        (host.querySelector('button') as HTMLButtonElement).click();
        button('Add Kid A to the queue').click();
        button('Play Kid A').click();
        expect(seen).toEqual(['open', 'queue', 'play']);
    });

    it('draws the placeholder until there is a cover, and reports one that 404s', () => {
        expect(create().host.querySelector('img')).toBeNull();
        TestBed.resetTestingModule();
        const { fixture, host } = create({ cover: '/api/art?album=x' });
        const failed: string[] = [];
        fixture.componentInstance.failed.subscribe((uri) => failed.push(uri));
        host.querySelector('img')!.dispatchEvent(new Event('error'));
        expect(failed).toEqual(['/api/art?album=x']);
    });

    it('disables Play and Queue while one is in flight, but not the row itself', () => {
        const { host, button } = create({ busy: true });
        expect(button('Play Kid A').disabled).toBeTrue();
        expect(button('Add Kid A to the queue').disabled).toBeTrue();
        expect((host.querySelector('button') as HTMLButtonElement).disabled).toBeFalse();
    });

    it('is ALBUM_ROW_HEIGHT tall, which is what the virtual scrollers are told', () => {
        // Measured against the real template: every index the scrollers compute
        // comes from this number, and a padding change that missed it would
        // break scrolling with every other assertion still green.
        const { host } = create();
        const row = document.createElement('li');
        row.className = 'flex items-center gap-1';
        row.append(...host.childNodes);
        document.body.appendChild(row);
        expect(row.offsetHeight).toBe(ALBUM_ROW_HEIGHT);
        row.remove();
    });
});
