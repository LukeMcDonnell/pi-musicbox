/**
 * HTTP to the musicbox backend. Transport only — no state, no policy.
 *
 * This exists because two services genuinely need the same three things and
 * neither should own them: MusicboxApi (live playback state) and LibraryStore
 * (the browse catalogue). They have nothing else in common — different
 * lifetimes, different invalidation, different shapes — so the transport is what
 * gets shared rather than the service.
 *
 * Kept deliberately thin. Anything that decides WHEN to call, or what to do with
 * the answer, belongs to a caller.
 */

import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

/**
 * A request the server refused, with the code it refused it with.
 *
 * The code is here because a caller sometimes has to tell a permanent refusal
 * from a passing one — panel sleep retries a 409 and gives up on a 503.
 */
export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

@Injectable({ providedIn: 'root' })
export class ApiClient {
    /**
     * Prefix an API path with the configured origin.
     *
     * Blank apiUrl — production, and dev by default — returns the path untouched,
     * so the request stays root-relative and same-origin. A configured value
     * makes the URL absolute, for pointing a dev frontend at a real box; the
     * backend allows any origin on /api, so that needs no configuration there.
     *
     * PUBLIC because paths also arrive FROM the server — `Track.image` and
     * `ArtistSummary.image` are root-relative `/api/art?...`. Anything binding
     * one of those into the DOM must send it through here: the browser would
     * otherwise resolve it against the page's own origin, so with apiUrl set to a
     * real box the art would be fetched from the dev server and 404. Images need
     * no CORS, so this works cross-origin as-is.
     */
    resolve(path: string): string {
        return environment.apiUrl.replace(/\/+$/, '') + path;
    }

    async getJson<T>(path: string): Promise<T> {
        const response = await fetch(this.resolve(path));
        if (!response.ok) throw new ApiError(await detail(response, path), response.status);
        return (await response.json()) as T;
    }

    /**
     * POST, discarding the body.
     *
     * Callers deliberately do not use the response to update anything: for MPD
     * the command lands, MPD's idle fires, and the snapshot arrives over SSE. One
     * source of truth. See the note in MusicboxApi.
     */
    async post(path: string, body?: unknown): Promise<void> {
        const response = await fetch(this.resolve(path), {
            method: 'POST',
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!response.ok) throw new ApiError(await detail(response, path), response.status);
    }

    /**
     * PATCH with a JSON body, returning the server's answer.
     *
     * Unlike post(), the response IS used: the settings routes answer with the
     * complete set, and the SSE event that follows is the same value. Reading it
     * here means a client that made the change does not have to wait for its own
     * event to come back before the UI agrees with it.
     */
    async patchJson<T>(path: string, body: unknown): Promise<T> {
        const response = await fetch(this.resolve(path), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) throw new ApiError(await detail(response, path), response.status);
        return (await response.json()) as T;
    }

    /** PUT with no body, returning the server's answer. Used as patchJson is. */
    async putJson<T>(path: string): Promise<T> {
        return this.bodyless<T>('PUT', path);
    }

    /** DELETE, returning the server's answer. */
    async deleteJson<T>(path: string): Promise<T> {
        return this.bodyless<T>('DELETE', path);
    }

    private async bodyless<T>(method: string, path: string): Promise<T> {
        const response = await fetch(this.resolve(path), { method });
        if (!response.ok) throw new ApiError(await detail(response, path), response.status);
        return (await response.json()) as T;
    }

    /** GET a file, with the name the server suggested for it. */
    async getBlob(path: string): Promise<{ blob: Blob; filename: string | null }> {
        const response = await fetch(this.resolve(path));
        if (!response.ok) throw new ApiError(await detail(response, path), response.status);
        const disposition = response.headers.get('content-disposition') ?? '';
        const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? null;
        return { blob: await response.blob(), filename };
    }

    /** POST raw bytes, returning the server's JSON answer. */
    async postBlob<T>(path: string, body: Blob, contentType: string): Promise<T> {
        const response = await fetch(this.resolve(path), {
            method: 'POST',
            headers: { 'content-type': contentType },
            body,
        });
        if (!response.ok) throw new ApiError(await detail(response, path), response.status);
        return (await response.json()) as T;
    }
}

/** The server's own message where there is one, the status code otherwise. */
async function detail(response: Response, path: string): Promise<string> {
    try {
        const parsed = (await response.json()) as { error?: string };
        if (parsed.error) return parsed.error;
    } catch {
        // Non-JSON error body; the status code is enough.
    }
    return `${path}: HTTP ${response.status}`;
}
