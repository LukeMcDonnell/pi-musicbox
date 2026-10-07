import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { GENERATOR_ANY, type ArtistSummary, type GeneratorFilters, type GeneratorOptions } from '@musicbox/shared';
import { COUNT_DEBOUNCE_MS, Generate } from './generate';
import { GeneratorClient } from '../../services/generator-client';
import { LibraryStore } from '../../services/library-store';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { PREFERENCES_KEY, Preferences } from '../../services/preferences';

const OPTIONS: GeneratorOptions = { genres: [{ name: 'Rock', tracks: 30 }, { name: 'Jazz', tracks: 4 }], years: { min: 1966, max: 2024 } };

function artist(name: string): ArtistSummary {
    return { name, directory: name, albumCount: 1, trackCount: 10, duration: null, image: null };
}

async function settle(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
}

async function create() {
    const client = {
        options: jasmine.createSpy('options').and.resolveTo(OPTIONS),
        count: jasmine.createSpy('count').and.resolveTo(1234),
        play: jasmine.createSpy('play').and.resolveTo(undefined),
    };
    const artists = signal<ArtistSummary[] | null>([artist('Tool'), artist('Low')]);
    const library = { artists: artists.asReadonly(), loadArtists: jasmine.createSpy('loadArtists').and.resolveTo([]) };
    TestBed.configureTestingModule({
        imports: [Generate],
        providers: [
            provideRouter([]),
            { provide: GeneratorClient, useValue: client },
            { provide: LibraryStore, useValue: library },
        ],
    });
    const fixture = TestBed.createComponent(Generate);
    await settle(fixture);
    return { fixture, page: fixture.componentInstance, client, el: fixture.nativeElement as HTMLElement };
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
    return [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === text)!;
}

describe('Generate', () => {
    beforeEach(() => localStorage.removeItem(PREFERENCES_KEY));
    afterAll(() => localStorage.removeItem(PREFERENCES_KEY));

    it('offers every list, and toggles them into the stored filters', async () => {
        const { fixture, el } = await create();
        const chip = button(el, 'Unplayed Albums');
        expect(chip.getAttribute('aria-pressed')).toBe('false');
        chip.click();
        await settle(fixture);
        expect(chip.getAttribute('aria-pressed')).toBe('true');
        expect(TestBed.inject(Preferences).generatorFilters().lists).toEqual(['unplayed-albums']);
        expect(el.querySelectorAll('[aria-pressed]').length).toBe(7);
    });

    it('counts the matches once the filters sit still', async () => {
        jasmine.clock().install();
        try {
            const { fixture, page, client, el } = await create();
            client.count.calls.reset();
            page.toggleList('favourite-albums');
            page.toggleList('recent-albums');
            fixture.detectChanges();
            jasmine.clock().tick(COUNT_DEBOUNCE_MS - 1);
            expect(client.count).not.toHaveBeenCalled();
            jasmine.clock().tick(1);
            expect(client.count).toHaveBeenCalledTimes(1);
            expect((client.count.calls.mostRecent().args[0] as GeneratorFilters).lists).toEqual(['favourite-albums', 'recent-albums']);
            await settle(fixture);
            expect(el.textContent).toContain('1,234 tracks match');
        } finally {
            jasmine.clock().uninstall();
        }
    });

    it('stores a full-span era as any, so a library that grows older is still covered', async () => {
        const { page } = await create();
        const year = new Date().getFullYear();
        page.setYears({ min: 1980, max: 1989 });
        expect(page.filters().years).toEqual({ min: 1980, max: 1989 });
        page.setYears({ min: 1966, max: year });
        expect(page.filters().years).toBeNull();
        expect(page.yearBounds()).toEqual({ min: 1966, max: year });
    });

    it('drops a remembered artist or genre the library no longer has', async () => {
        localStorage.setItem(
            PREFERENCES_KEY,
            JSON.stringify({ generatorFilters: { ...GENERATOR_ANY, artists: ['Tool', 'Gone'], genres: ['rock', 'Polka'] } }),
        );
        const { page, el } = await create();
        expect(page.effective().artists).toEqual(['Tool']);
        expect(page.effective().genres).toEqual(['rock']);
        expect(el.textContent).toContain('Tool');
    });

    it('plays the length chosen and raises now-playing', async () => {
        const { fixture, page, client, el } = await create();
        button(el, '100').click();
        await settle(fixture);
        await page.play();
        expect(client.play).toHaveBeenCalledWith(jasmine.objectContaining({ lists: [] }), 100);
        expect(TestBed.inject(NowPlayingSheet).open()).toBeTrue();
    });

    it('shows a refusal inline', async () => {
        const { fixture, page, client, el } = await create();
        client.play.and.rejectWith(new Error('cannot play while a phone owns the DAC'));
        await page.play();
        await settle(fixture);
        expect(el.querySelector('[role="alert"]')!.textContent).toContain('phone owns the DAC');
    });

    it('offers both popularity sliders, and sends the library one', async () => {
        const { fixture, page, client, el } = await create();
        const labels = [...el.querySelectorAll('input[type="range"]')].map((i) => i.getAttribute('aria-label'));
        expect(labels).toContain('Artist popularity from');
        expect(labels).toContain('Library popularity to');
        page.setLibraryPopularity({ min: 90, max: 100 });
        await settle(fixture);
        await page.play();
        expect(client.play).toHaveBeenCalledWith(
            jasmine.objectContaining({ libraryPopularity: { min: 90, max: 100 } }),
            jasmine.any(Number),
        );
    });

    it('resets to no filters', async () => {
        const { fixture, page, el } = await create();
        page.setPopularity({ min: 80, max: 100 });
        page.setLibraryPopularity({ min: 0, max: 30 });
        await settle(fixture);
        expect(button(el, 'Reset').disabled).toBeFalse();
        button(el, 'Reset').click();
        await settle(fixture);
        expect(page.filters()).toEqual(GENERATOR_ANY);
        expect(button(el, 'Reset').disabled).toBeTrue();
    });

    it('picks related artists from the same list, and drops ones the library lost', async () => {
        localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ generatorFilters: { ...GENERATOR_ANY, related: ['Low', 'Gone'] } }));
        const { fixture, page, client, el } = await create();
        expect(page.effective().related).toEqual(['Low']);
        ([...el.querySelectorAll('button[aria-haspopup]')].find((b) => b.textContent!.includes('Related')) as HTMLButtonElement).click();
        await settle(fixture);
        const dialog = el.querySelector('[role="dialog"]')!;
        expect(dialog.getAttribute('aria-label')).toBe('Related to artists');
        expect(dialog.querySelectorAll('[role="checkbox"]').length).toBe(2);
        page.setRelated(['Tool']);
        await page.play();
        expect(client.play).toHaveBeenCalledWith(jasmine.objectContaining({ related: ['Tool'], artists: [] }), jasmine.any(Number));
    });

    it('opens the artist picker from its row', async () => {
        const { fixture, el } = await create();
        ([...el.querySelectorAll('button[aria-haspopup]')].find((b) => b.textContent!.includes('Artist')) as HTMLButtonElement).click();
        await settle(fixture);
        expect(el.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Artists');
    });
});
