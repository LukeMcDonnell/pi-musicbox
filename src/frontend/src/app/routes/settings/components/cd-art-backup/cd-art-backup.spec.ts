import { TestBed } from '@angular/core/testing';
import { ApiClient, ApiError } from '../../../../services/api-client';
import { CdArtBackup } from './cd-art-backup';

function create() {
    const client = {
        getBlob: jasmine.createSpy('getBlob').and.resolveTo({
            blob: new Blob([new Uint8Array([1])]),
            filename: 'musicbox-cd-covers-20260917-0905.tar.gz',
        }),
        postBlob: jasmine.createSpy('postBlob').and.resolveTo({ restored: 12 }),
    };

    TestBed.configureTestingModule({
        imports: [CdArtBackup],
        providers: [{ provide: ApiClient, useValue: client }],
    });
    const fixture = TestBed.createComponent(CdArtBackup);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = (label: string) =>
        Array.from(el.querySelectorAll('button')).find((b) => b.textContent!.includes(label))!;
    const pick = async (file: File) => {
        const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new Event('change'));
        await fixture.whenStable();
        fixture.detectChanges();
    };
    return { el, client, button, pick };
}

const archive = () => new File([new Uint8Array([0x1f, 0x8b])], 'musicbox-cd-covers.tar.gz');

describe('CdArtBackup', () => {
    it('downloads the covers under the server’s filename', async () => {
        const { client, button } = create();
        const clicked: HTMLAnchorElement[] = [];
        spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) {
            clicked.push(this);
        });

        button('Download covers').click();
        // Not whenStable: the object URL's revoke timer would hold it for ten seconds.
        for (let i = 0; i < 20 && clicked.length === 0; i++) await Promise.resolve();

        expect(client.getBlob).toHaveBeenCalledWith('/api/cd/art/backup');
        expect(clicked[0]?.download).toBe('musicbox-cd-covers-20260917-0905.tar.gz');
    });

    it('uploads a chosen file straight away and says how many covers came back', async () => {
        const { el, client, pick } = create();
        const file = archive();
        await pick(file);

        expect(client.postBlob).toHaveBeenCalledWith('/api/cd/art/restore', file, 'application/gzip');
        expect(el.textContent).toContain('Restored 12 covers.');
    });

    it('says so when the backup held no covers', async () => {
        const { el, client, pick } = create();
        client.postBlob.and.resolveTo({ restored: 0 });
        await pick(archive());
        expect(el.textContent).toContain('no covers');
    });

    it('shows the server’s reason when it refuses the file', async () => {
        const { el, client, pick } = create();
        client.postBlob.and.rejectWith(new ApiError('not a CD cover backup', 400));
        await pick(archive());

        expect(el.querySelector('[role="alert"]')?.textContent).toContain('not a CD cover backup');
        expect(el.textContent).not.toContain('Restored');
    });
});
