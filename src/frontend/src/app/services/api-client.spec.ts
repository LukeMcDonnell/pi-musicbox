import { TestBed } from '@angular/core/testing';
import { ApiClient, ApiError } from './api-client';

/** A refusal shaped like the backend's: a JSON body with an `error` string. */
function refuse(status: number, error?: string): Response {
    const body = error === undefined ? 'not json' : JSON.stringify({ error });
    return new Response(body, { status, statusText: 'nope' });
}

describe('ApiClient', () => {
    let fetchSpy: jasmine.Spy;

    beforeEach(() => {
        TestBed.resetTestingModule();
        fetchSpy = spyOn(window, 'fetch');
    });

    it('carries the status code on a refusal, so a caller can tell them apart', async () => {
        const client = TestBed.inject(ApiClient);
        fetchSpy.and.resolveTo(refuse(503, 'this box has no panel backlight'));

        await expectAsync(client.post('/api/panel/backlight', { on: false })).toBeRejectedWithError(
            ApiError,
            'this box has no panel backlight',
        );
        // Panel sleep retries a 409 and gives up on a 503; without this it cannot.
        const err = await client.post('/api/panel/backlight', { on: false }).catch((e: unknown) => e);
        expect((err as ApiError).status).toBe(503);
    });

    it('falls back to the status code when the body is not the server’s', async () => {
        const client = TestBed.inject(ApiClient);
        fetchSpy.and.resolveTo(refuse(502));

        const err = await client.getJson('/api/status').catch((e: unknown) => e);
        expect(err instanceof ApiError).toBeTrue();
        expect((err as ApiError).message).toBe('/api/status: HTTP 502');
        expect((err as ApiError).status).toBe(502);
    });

    it('reads a download with the filename the server gave it', async () => {
        const client = TestBed.inject(ApiClient);
        fetchSpy.and.resolveTo(
            new Response(new Uint8Array([1, 2, 3]), {
                headers: { 'content-disposition': 'attachment; filename="musicbox-backup-20260917-0905.tar.gz"' },
            }),
        );

        const { blob, filename } = await client.getBlob('/api/backup');
        expect(filename).toBe('musicbox-backup-20260917-0905.tar.gz');
        expect(blob.size).toBe(3);
    });

    it('uploads raw bytes with the content type it is told', async () => {
        const client = TestBed.inject(ApiClient);
        fetchSpy.and.resolveTo(new Response(JSON.stringify({ accepted: 'restore' }), { status: 202 }));
        const file = new Blob([new Uint8Array([0x1f, 0x8b])]);

        expect(await client.postBlob('/api/restore', file, 'application/gzip')).toEqual({ accepted: 'restore' });
        const init = fetchSpy.calls.mostRecent().args[1] as RequestInit;
        expect(init.method).toBe('POST');
        expect(init.body).toBe(file);
        expect((init.headers as Record<string, string>)['content-type']).toBe('application/gzip');
    });
});
