import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CdInfo, Snapshot } from '@musicbox/shared';
import { MusicboxApi } from '../../../../services/musicbox-api';
import { CdCard } from './cd-card';

function info(over: Partial<CdInfo>): CdInfo {
    return { tracks: 11, discId: null, lookup: 'not-found', album: null, artist: null, date: null, image: null, ...over };
}

function create(cd: Partial<CdInfo> | null, source: Snapshot['source'] = 'mpd') {
    const disc = signal<CdInfo | null>(cd === null ? null : info(cd));
    const snapshot = signal<Partial<Snapshot> | null>({ source });
    const api = {
        cd: disc.asReadonly(),
        snapshot,
        playCd: jasmine.createSpy('playCd').and.resolveTo(),
        ejectCd: jasmine.createSpy('ejectCd').and.resolveTo(),
        resolve: (p: string) => p,
    };
    TestBed.configureTestingModule({
        imports: [CdCard],
        providers: [{ provide: MusicboxApi, useValue: api }],
    });
    const fixture = TestBed.createComponent(CdCard);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = (label: string) =>
        el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    return { fixture, el, api, disc, snapshot, button };
}

describe('CdCard', () => {
    it('is absent without a disc', () => {
        const { el } = create(null);
        expect(el.textContent!.trim()).toBe('');
    });

    it('offers Play and Eject for a disc that is not playing', async () => {
        const { el, api, button, fixture } = create({ tracks: 11 });
        expect(el.textContent).toContain('Audio CD');
        expect(el.textContent).toContain('11 tracks');
        button('Play')!.click();
        button('Eject')!.click();
        await fixture.whenStable();
        expect(api.playCd).toHaveBeenCalled();
        expect(api.ejectCd).toHaveBeenCalled();
    });

    it('drops Play once the disc is what is playing', () => {
        const { button, el } = create({ tracks: 1 }, 'cd');
        expect(button('Play')).toBeNull();
        expect(button('Eject')).not.toBeNull();
        expect(el.textContent).toContain('1 track');
        expect(el.textContent).toContain('playing');
    });

    it('still offers Play while a phone is playing', () => {
        const { button } = create({ tracks: 5 }, 'bluetooth');
        expect(button('Play')).not.toBeNull();
    });

    it('says why when the box refuses', async () => {
        const { api, button, fixture, el } = create({ tracks: 5 });
        api.ejectCd.and.rejectWith(new Error('the CD helper is not running'));
        button('Eject')!.click();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(el.querySelector('[role="alert"]')!.textContent).toContain('CD helper is not running');
    });

    it('names a looked-up disc and shows its cover', () => {
        const { el } = create({
            lookup: 'found', album: 'Ten', artist: 'Pearl Jam', date: '1991-08-27',
            image: '/api/cd/art?release=8d0bc6d4-8700-44e8-90c8-b86c23e7ff14',
        });
        expect(el.textContent).toContain('Ten');
        expect(el.textContent).toContain('Pearl Jam · 1991');
        expect(el.textContent).not.toContain('Audio CD');
        expect(el.querySelector('img')?.getAttribute('src')).toBe('/api/cd/art/thumb?release=8d0bc6d4-8700-44e8-90c8-b86c23e7ff14');
    });

    it('says it is looking the disc up', () => {
        const { el } = create({ lookup: 'pending', discId: 'x-' });
        expect(el.textContent).toContain('Audio CD');
        expect(el.textContent).toContain('looking up');
    });
});
