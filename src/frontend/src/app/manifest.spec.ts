interface ManifestIcon {
    src: string;
    sizes: string;
    purpose: string;
}

describe('the web manifest', () => {
    let manifest: { start_url: string; display: string; icons: ManifestIcon[] };
    beforeAll(async () => {
        manifest = await (await fetch('manifest.webmanifest')).json();
    });

    it('opens the app standalone at its root', () => {
        expect(manifest.start_url).toBe('/');
        expect(manifest.display).toBe('standalone');
    });

    it('offers the icons Android needs to install it, maskable included', () => {
        const has = (sizes: string, purpose: string) =>
            manifest.icons.some((i) => i.sizes === sizes && i.purpose === purpose);
        expect(has('192x192', 'any')).toBeTrue();
        expect(has('512x512', 'any')).toBeTrue();
        expect(has('512x512', 'maskable')).toBeTrue();
    });

    it('names only icons that exist', async () => {
        for (const icon of manifest.icons) {
            expect((await fetch(icon.src)).ok).withContext(icon.src).toBeTrue();
        }
    });
});
