import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { LucideChevronLeft, LucideChevronRight, LucidePlay } from '@lucide/angular';
import {
    GENERATOR_ANY,
    GENERATOR_LENGTHS,
    GENERATOR_LISTS,
    fold,
    presetById,
    presetFilters,
    type GeneratorFilters,
    type GeneratorList,
    type GeneratorOptions,
    type Range,
} from '@musicbox/shared';
import { MultiPick, type PickOption } from '../../components/multi-pick/multi-pick';
import { RangeSlider } from '../../components/range-slider/range-slider';
import { SettingSwitch } from '../settings/components/setting-switch/setting-switch';
import { AppHistory } from '../../services/app-history';
import { GeneratorClient } from '../../services/generator-client';
import { LibraryStore } from '../../services/library-store';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { Preferences } from '../../services/preferences';

/** How long the filters must sit still before the match count is asked for. */
export const COUNT_DEBOUNCE_MS = 250;
/** The Era slider's floor before the library has said how old it goes. */
const FALLBACK_FIRST_YEAR = 1950;

/** Filters in, a fresh queue out. The filters are this device's, and kept. */
@Component({
    selector: 'app-generate',
    imports: [LucideChevronLeft, LucideChevronRight, LucidePlay, MultiPick, RangeSlider, SettingSwitch],
    templateUrl: './generate.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Generate {
    private readonly prefs = inject(Preferences);
    private readonly client = inject(GeneratorClient);
    private readonly library = inject(LibraryStore);
    private readonly sheet = inject(NowPlayingSheet);
    private readonly history = inject(AppHistory);

    readonly lists = GENERATOR_LISTS;
    readonly lengths = GENERATOR_LENGTHS;

    readonly options = signal<GeneratorOptions | null>(null);
    readonly filters = this.prefs.generatorFilters;
    readonly length = this.prefs.generatorLength;
    readonly count = signal<number | null>(null);
    readonly busy = signal(false);
    readonly error = signal<string | null>(null);
    readonly picking = signal<'artists' | 'related' | 'genres' | null>(null);

    readonly artistOptions = computed<PickOption[]>(() =>
        (this.library.artists() ?? []).map((a) => ({ name: a.name, detail: `${a.trackCount}` })),
    );
    readonly genreOptions = computed<PickOption[]>(() =>
        (this.options()?.genres ?? []).map((g) => ({ name: g.name, detail: `${g.tracks}` })),
    );

    readonly yearBounds = computed<Range>(() => ({
        min: this.options()?.years?.min ?? FALLBACK_FIRST_YEAR,
        max: Math.max(new Date().getFullYear(), this.options()?.years?.max ?? 0),
    }));
    readonly years = computed<Range>(() => this.filters().years ?? this.yearBounds());

    /** What is sent: a remembered artist or genre the library no longer has is dropped. */
    readonly effective = computed<GeneratorFilters>(() => {
        const f = this.filters();
        const artists = this.library.artists();
        const genres = this.options()?.genres;
        const known = genres === undefined ? null : new Set(genres.map((g) => fold(g.name)));
        return {
            ...f,
            artists: artists === null ? f.artists : f.artists.filter((n) => artists.some((a) => a.name === n)),
            related: artists === null ? f.related : f.related.filter((n) => artists.some((a) => a.name === n)),
            genres: known === null ? f.genres : f.genres.filter((g) => known.has(fold(g))),
        };
    });

    readonly isDefault = computed(() => JSON.stringify(this.filters()) === JSON.stringify(GENERATOR_ANY));

    constructor() {
        // From a preset's Customise: its filters replace the last ones, once.
        const id = inject(ActivatedRoute).snapshot.queryParamMap.get('preset');
        const preset = presetById(id);
        if (preset !== undefined) this.prefs.set('generatorFilters', presetFilters(preset));

        void this.library.loadArtists().catch(() => undefined);
        this.client.options().then(
            (options) => this.options.set(options),
            (err: Error) => this.error.set(err.message),
        );

        let asked = 0;
        effect((onCleanup) => {
            const filters = this.effective();
            const mine = ++asked;
            const timer = setTimeout(() => {
                this.client.count(filters).then(
                    (count) => mine === asked && this.count.set(count),
                    (err: Error) => mine === asked && this.error.set(err.message),
                );
            }, COUNT_DEBOUNCE_MS);
            onCleanup(() => clearTimeout(timer));
        });
    }

    private update(change: Partial<GeneratorFilters>): void {
        this.error.set(null);
        this.prefs.set('generatorFilters', { ...this.filters(), ...change });
    }

    hasList(id: GeneratorList): boolean {
        return this.filters().lists.includes(id);
    }

    toggleList(id: GeneratorList): void {
        const lists = this.filters().lists;
        this.update({ lists: lists.includes(id) ? lists.filter((l) => l !== id) : [...lists, id] });
    }

    setPopularity(popularity: Range): void {
        this.update({ popularity });
    }

    setLibraryPopularity(libraryPopularity: Range): void {
        this.update({ libraryPopularity });
    }

    /** The full span is stored as null, so a library that grows older is still covered. */
    setYears(years: Range): void {
        const bounds = this.yearBounds();
        this.update({ years: years.min <= bounds.min && years.max >= bounds.max ? null : years });
    }

    setArtists(artists: string[]): void {
        this.update({ artists });
    }

    setRelated(related: string[]): void {
        this.update({ related });
    }

    setGenres(genres: string[]): void {
        this.update({ genres });
    }

    setOuttakes(outtakes: boolean): void {
        this.update({ outtakes });
    }

    setLength(length: number): void {
        this.prefs.set('generatorLength', length);
    }

    reset(): void {
        this.update(GENERATOR_ANY);
    }

    summaryOf(names: string[]): string {
        if (names.length === 0) return 'Any';
        return names.length <= 2 ? names.join(', ') : `${names.length} selected`;
    }

    percent = (value: number): string => `${value}%`;

    async play(): Promise<void> {
        if (this.busy()) return;
        this.busy.set(true);
        this.error.set(null);
        try {
            await this.client.play(this.effective(), this.length());
            if (this.prefs.openNowPlayingOnPlay()) this.sheet.show();
        } catch (err) {
            this.error.set((err as Error).message);
        } finally {
            this.busy.set(false);
        }
    }

    back(): void {
        this.history.back(['/playlists']);
    }
}
