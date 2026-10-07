import { TestBed } from '@angular/core/testing';
import { GENERATOR_PRESETS, presetFilters } from '@musicbox/shared';
import { GeneratorClient } from './generator-client';
import { NowPlayingSheet } from './now-playing-sheet';
import { PresetPlayer } from './preset-player';
import { PREFERENCES_KEY, Preferences } from './preferences';

function create() {
    const client = { play: jasmine.createSpy('play').and.resolveTo(undefined) };
    TestBed.configureTestingModule({ providers: [{ provide: GeneratorClient, useValue: client }] });
    // The real playPreset, over the spied play.
    (client as unknown as GeneratorClient).playPreset = GeneratorClient.prototype.playPreset;
    return { client, player: TestBed.inject(PresetPlayer) };
}

describe('PresetPlayer', () => {
    beforeEach(() => localStorage.removeItem(PREFERENCES_KEY));
    afterAll(() => localStorage.removeItem(PREFERENCES_KEY));

    it('plays the preset at this device’s length and raises now-playing', async () => {
        const { client, player } = create();
        TestBed.inject(Preferences).set('generatorLength', 100);
        const preset = GENERATOR_PRESETS[0]!;
        await player.play(preset);
        expect(client.play).toHaveBeenCalledWith(presetFilters(preset), 100);
        expect(TestBed.inject(NowPlayingSheet).open()).toBeTrue();
        expect(player.busy()).toBeNull();
    });

    it('says which preset failed, and ignores a second tap while one starts', async () => {
        const { client, player } = create();
        let finish!: () => void;
        client.play.and.returnValue(new Promise<void>((resolve) => (finish = resolve)));
        const first = player.play(GENERATOR_PRESETS[0]!);
        expect(player.busy()).toBe(GENERATOR_PRESETS[0]!.id);
        await player.play(GENERATOR_PRESETS[1]!);
        expect(client.play).toHaveBeenCalledTimes(1);
        finish();
        await first;

        client.play.and.rejectWith(new Error('no tracks match'));
        await player.play(GENERATOR_PRESETS[1]!);
        expect(player.error()).toBe('Favourites Radio: no tracks match');
    });
});
