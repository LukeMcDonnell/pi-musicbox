import { Injectable, inject } from '@angular/core';
import type { GeneratorCount, GeneratorFilters, GeneratorOptions } from '@musicbox/shared';
import { ApiClient } from './api-client';

/** The playlist generator's three routes. */
@Injectable({ providedIn: 'root' })
export class GeneratorClient {
    private readonly api = inject(ApiClient);

    options(): Promise<GeneratorOptions> {
        return this.api.getJson<GeneratorOptions>('/api/generator/options');
    }

    async count(filters: GeneratorFilters): Promise<number> {
        return (await this.api.postJson<GeneratorCount>('/api/generator/count', { filters })).count;
    }

    /** Replace the queue with a fresh pick and play it. */
    async play(filters: GeneratorFilters, length: number): Promise<void> {
        await this.api.post('/api/generator/play', { filters, length });
    }
}
