import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { DECADE_PRESETS, GENERATOR_PRESETS, type PlaylistSummary } from '@musicbox/shared';
import { PresetPlayer } from '../../services/preset-player';
import { Playlists, summaryOf } from './playlists';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { PlaylistsStore } from '../../services/playlists-store';
import { PREFERENCES_KEY, Preferences } from '../../services/preferences';

function playlist(name: string, trackCount = 3, duration: number | null = 600): PlaylistSummary {
    return { name, trackCount, duration, modified: '2026-10-06T00:00:00Z', covers: [] };
}

function create(list: PlaylistSummary[] | null = [playlist('Road trip'), playlist('Empty one', 0, null)]) {
    const playlists = signal(list);
    const store = {
        playlists: playlists.asReadonly(),
        play: jasmine.createSpy('play').and.resolveTo(undefined),
        queue: jasmine.createSpy('queue').and.resolveTo(undefined),
        create: jasmine.createSpy('create').and.resolveTo(undefined),
    };
    TestBed.configureTestingModule({
        imports: [Playlists],
        providers: [provideRouter([]), { provide: PlaylistsStore, useValue: store }],
    });
    const fixture = TestBed.createComponent(Playlists);
    fixture.detectChanges();
    return { fixture, store, playlists, el: fixture.nativeElement as HTMLElement };
}

describe('Playlists', () => {
    beforeEach(() => localStorage.removeItem(PREFERENCES_KEY));
    afterAll(() => localStorage.removeItem(PREFERENCES_KEY));

    it('lists each playlist with its count and length', () => {
        const { el } = create();
        const rows = [...el.querySelectorAll('[aria-label="Stored playlists"] li')].map((li) => li.textContent!.replace(/\s+/g, ' ').trim());
        expect(rows[0]).toContain('Road trip');
        expect(rows[0]).toContain('3 tracks · 10:00');
        expect(rows[1]).toContain('Empty');
    });

    it('says so when there are none, and waits quietly before the first frame', () => {
        expect(create([]).el.textContent).toContain('No playlists yet');
        TestBed.resetTestingModule();
        expect(create(null).el.textContent).toContain('Loading playlists');
    });

    it('opens the new-playlist dialog from the button beside the Playlists heading', () => {
        const { fixture, el } = create();
        (el.querySelector('[aria-label="New playlist"]') as HTMLButtonElement).click();
        fixture.detectChanges();
        expect(el.querySelector('[role="dialog"]')!.textContent).toContain('New playlist');
    });

    it('opens Rename and Delete from a row', () => {
        const { fixture, el } = create();
        (el.querySelector('[aria-label="More for Road trip"]') as HTMLButtonElement).click();
        fixture.detectChanges();
        const dialog = el.querySelector('[role="dialog"]')!.textContent!;
        expect(dialog).toContain('Rename');
        expect(dialog).toContain('Delete');
    });

    it('opens the generator from Generate beside the Radio heading', () => {
        const { el } = create();
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        (el.querySelector('[aria-label="Generate a playlist"]') as HTMLButtonElement).click();
        expect(navigate).toHaveBeenCalledWith(['/playlists/generate']);
    });

    it('lists every radio preset above the playlists, and plays one from its row', () => {
        const { el } = create();
        const player = TestBed.inject(PresetPlayer);
        const play = spyOn(player, 'play').and.resolveTo();
        const rows = el.querySelectorAll('[aria-label="Radio"] li');
        expect(rows.length).toBe(GENERATOR_PRESETS.length);
        expect(rows[0]!.textContent).toContain('Library Radio');
        (el.querySelector('[aria-label="Play Hidden Gems"]') as HTMLButtonElement).click();
        expect(play).toHaveBeenCalledWith(GENERATOR_PRESETS.find((p) => p.id === 'hidden-gems')!);
    });

    it('lists the decade presets under their own heading', () => {
        const { el } = create();
        const rows = el.querySelectorAll('[aria-label="Decade Radio"] li');
        expect(rows.length).toBe(DECADE_PRESETS.length);
        expect(rows[2]!.textContent).toContain('70s Radio');
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        (el.querySelector('[aria-label="Customise 70s Radio"]') as HTMLButtonElement).click();
        expect(navigate).toHaveBeenCalledWith(['/playlists/generate'], { queryParams: { preset: 'decade-1970s' } });
    });

    it('customises a preset by opening Generate with it', () => {
        const { el } = create();
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        (el.querySelector('[aria-label="Customise Crowd Pleasers"]') as HTMLButtonElement).click();
        expect(navigate).toHaveBeenCalledWith(['/playlists/generate'], { queryParams: { preset: 'crowd-pleasers' } });
    });

    it('opens a playlist by its name', () => {
        const { el } = create();
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        (el.querySelector('[aria-label="Stored playlists"] li button') as HTMLButtonElement).click();
        expect(navigate).toHaveBeenCalledWith(['/playlists/playlist'], { queryParams: { name: 'Road trip' } });
    });

    it('plays and raises now-playing; queues and leaves the screen alone', async () => {
        const { fixture, store } = create();
        const sheet = TestBed.inject(NowPlayingSheet);
        await fixture.componentInstance.queue(playlist('Road trip'));
        expect(store.queue).toHaveBeenCalledWith('Road trip');
        expect(sheet.open()).toBeFalse();
        await fixture.componentInstance.play(playlist('Road trip'));
        expect(store.play).toHaveBeenCalledWith('Road trip');
        expect(sheet.open()).toBeTrue();
    });

    it('does not raise now-playing when Play was refused', async () => {
        const { fixture, store } = create();
        store.play.and.rejectWith(new Error('cannot play a playlist while a phone owns the DAC'));
        await fixture.componentInstance.play(playlist('Road trip'));
        expect(TestBed.inject(NowPlayingSheet).open()).toBeFalse();
        expect(fixture.componentInstance.error()).toMatch(/phone owns the DAC/);
    });

    it('opens on the queue after Queue when the user asked for that', async () => {
        const { fixture } = create();
        TestBed.inject(Preferences).set('openQueueOnAdd', true);
        await fixture.componentInstance.queue(playlist('Road trip'));
        expect(TestBed.inject(NowPlayingSheet).atQueue()).toBeTrue();
    });

    it('cannot Play or Queue an empty playlist', () => {
        const { el } = create();
        expect((el.querySelector('[aria-label="Play Empty one"]') as HTMLButtonElement).disabled).toBeTrue();
        expect((el.querySelector('[aria-label="Add Empty one to the queue"]') as HTMLButtonElement).disabled).toBeTrue();
    });
});

describe('Playlists covers', () => {
    it('gives each row its covers, resolved, and drops one that failed', () => {
        const covers = ['A', 'B', 'C', 'D'].map((d) => `/api/art?album=${d}`);
        const { fixture, el } = create([{ ...playlist('Mix'), covers }]);
        expect(el.querySelectorAll('li app-cover-grid app-cover-art').length).toBe(4);

        const page = fixture.componentInstance;
        const [first] = page.coversOf(page.playlists()[0]);
        page.onArtError(first);
        fixture.detectChanges();
        // Three left is fewer than four: the first alone.
        expect(page.coversOf(page.playlists()[0]).length).toBe(3);
        expect(el.querySelectorAll('li app-cover-grid app-cover-art').length).toBe(1);
    });
});

describe('summaryOf', () => {
    it('counts, singular and plural, and runs past an hour as h:mm:ss', () => {
        expect(summaryOf(playlist('a', 1, 61))).toBe('1 track · 1:01');
        expect(summaryOf(playlist('a', 20, 3725))).toBe('20 tracks · 1:02:05');
        expect(summaryOf(playlist('a', 0, null))).toBe('Empty');
    });
});
