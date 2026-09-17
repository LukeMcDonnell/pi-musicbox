import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Snapshot } from '@musicbox/shared';
import { ApiClient, ApiError } from '../../../../services/api-client';
import { MusicboxApi, type StreamState } from '../../../../services/musicbox-api';
import { libraryState } from '../../../../testing/fixtures';
import { BackupRestore } from './backup-restore';

function create() {
    const library = signal(libraryState());
    const snapshot = signal<Partial<Snapshot> | null>(null);
    const stream = signal<StreamState>('live');
    const client = {
        getBlob: jasmine.createSpy('getBlob').and.resolveTo({
            blob: new Blob([new Uint8Array([1])]),
            filename: 'musicbox-backup-20260917-0905.tar.gz',
        }),
        postBlob: jasmine.createSpy('postBlob').and.resolveTo({ accepted: 'restore' }),
    };

    TestBed.configureTestingModule({
        imports: [BackupRestore],
        providers: [
            { provide: MusicboxApi, useValue: { library, snapshot, stream } },
            { provide: ApiClient, useValue: client },
        ],
    });
    const fixture = TestBed.createComponent(BackupRestore);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = (label: string) =>
        Array.from(el.querySelectorAll('button')).find((b) => b.textContent!.includes(label))!;
    const pick = (file: File) => {
        const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new Event('change'));
        fixture.detectChanges();
    };
    const settle = async () => {
        await fixture.whenStable();
        fixture.detectChanges();
    };
    return { fixture, el, client, library, snapshot, stream, button, pick, settle };
}

const archive = () => new File([new Uint8Array([0x1f, 0x8b])], 'musicbox-backup.tar.gz');

describe('BackupRestore', () => {
    it('downloads the backup under the server’s filename', async () => {
        const { client, button } = create();
        const clicked: HTMLAnchorElement[] = [];
        spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) {
            clicked.push(this);
        });

        button('Download backup').click();
        // Not whenStable: the object URL's revoke timer would hold it for ten seconds.
        for (let i = 0; i < 20 && clicked.length === 0; i++) await Promise.resolve();

        expect(client.getBlob).toHaveBeenCalledWith('/api/backup');
        expect(clicked.length).toBe(1);
        expect(clicked[0]!.download).toBe('musicbox-backup-20260917-0905.tar.gz');
    });

    it('asks before restoring, and cancelling uploads nothing', () => {
        const { el, client, button, pick, fixture } = create();
        pick(archive());
        expect(el.textContent).toContain('replaces the');

        button('Cancel').click();
        fixture.detectChanges();
        expect(el.textContent).not.toContain('replaces the');
        expect(client.postBlob).not.toHaveBeenCalled();
    });

    it('uploads the chosen file as gzip, then waits for the box to come back', async () => {
        const { el, client, button, pick, settle, stream } = create();
        const file = archive();
        pick(file);
        button('Confirm restore').click();
        await settle();

        expect(client.postBlob).toHaveBeenCalledWith('/api/restore', file, 'application/gzip');
        expect(el.textContent).toContain('Restoring');

        // The server restarts, so the stream drops and returns.
        stream.set('offline');
        await settle();
        expect(el.textContent).toContain('Restoring');
        stream.set('live');
        await settle();
        expect(el.textContent).toContain('Restored.');
    });

    it('shows the server’s refusal', async () => {
        const { el, client, button, pick, settle } = create();
        client.postBlob.and.rejectWith(new ApiError('backup is missing mpd/state', 400));
        pick(archive());
        button('Confirm restore').click();
        await settle();

        expect(el.querySelector('[role="alert"]')?.textContent).toContain('missing mpd/state');
        expect(el.textContent).not.toContain('Restoring');
    });

    it('does not offer a restore while a scan runs or a phone plays', () => {
        const { el, library, snapshot, button, fixture } = create();
        expect(button('Restore').disabled).toBeFalse();

        library.set(libraryState({ scanning: true }));
        fixture.detectChanges();
        expect(button('Restore').disabled).toBeTrue();
        expect(el.textContent).toContain('being scanned');

        library.set(libraryState());
        snapshot.set({ source: 'bluetooth' });
        fixture.detectChanges();
        expect(button('Restore').disabled).toBeTrue();
        expect(el.textContent).toContain('phone is playing');
    });
});
