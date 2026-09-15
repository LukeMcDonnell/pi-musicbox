import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AlbumResponse, Track } from '@musicbox/shared';
import { Album } from './album';
import { LibraryStore } from '../../services/library-store';
import { NowPlayingSheet } from '../../services/now-playing-sheet';

function track(title: string, duration: number | undefined, file: string): Track {
    return { title, duration, file, image: '/api/art?album=x' };
}

function response(over: Partial<AlbumResponse> = {}): AlbumResponse {
    return {
        album: {
            album: 'Kid A',
            albumArtist: 'Radiohead',
            date: '2000-10-02',
            trackCount: 2,
            image: '/api/art?album=Radiohead%2FKid%20A',
        },
        tracks: [track('Everything', 267, 'a/1.flac'), track('Kid A', 264, 'a/2.flac')],
        ...over,
    };
}

function fakeStore(data: AlbumResponse = response()) {
    return {
        fetchAlbum: jasmine.createSpy('fetchAlbum').and.resolveTo(data),
        playAlbum: jasmine.createSpy('playAlbum').and.resolveTo(undefined),
        queueAlbum: jasmine.createSpy('queueAlbum').and.resolveTo(undefined),
        resolve: (path: string) => path,
    };
}

function create(store: ReturnType<typeof fakeStore>, artist = 'Radiohead', album = 'Kid A') {
    TestBed.configureTestingModule({
        imports: [Album],
        providers: [provideRouter([]), { provide: LibraryStore, useValue: store }],
    });
    const fixture = TestBed.createComponent(Album);
    fixture.componentRef.setInput('artist', artist);
    fixture.componentRef.setInput('album', album);
    return fixture;
}

describe('Album', () => {
    it('creates without a backend present', () => {
        const fixture = create(fakeStore(), '', '');
        fixture.detectChanges();
        expect(fixture.componentInstance).toBeTruthy();
    });

    it('fetches by artist and album, both untouched', async () => {
        const store = fakeStore();
        const fixture = create(store, 'AC/DC', 'Back in Black');
        fixture.detectChanges();
        await fixture.whenStable();
        expect(store.fetchAlbum).toHaveBeenCalledWith('AC/DC', 'Back in Black');
    });

    it('raises now-playing after a successful Play', async () => {
        const store = fakeStore();
        const fixture = create(store);
        fixture.detectChanges();
        await fixture.whenStable();

        const sheet = TestBed.inject(NowPlayingSheet);
        expect(sheet.open()).toBeFalse();
        await fixture.componentInstance.play();

        expect(store.playAlbum).toHaveBeenCalledWith({
            albumArtist: 'Radiohead',
            album: 'Kid A',
        });
        expect(sheet.open()).toBeTrue();
    });

    it('does NOT raise now-playing when Play was refused', async () => {
        const store = fakeStore();
        // 409 while a phone owns the DAC is the real case.
        store.playAlbum.and.rejectWith(new Error('cannot play an album while a phone owns the DAC'));
        const fixture = create(store);
        fixture.detectChanges();
        await fixture.whenStable();

        await fixture.componentInstance.play();
        // Sliding up a stale screen would state the button had worked.
        expect(TestBed.inject(NowPlayingSheet).open()).toBeFalse();
        expect(fixture.componentInstance.error()).toMatch(/phone owns the DAC/);
    });

    it('Queue appends and leaves the screen alone', async () => {
        const store = fakeStore();
        const fixture = create(store);
        fixture.detectChanges();
        await fixture.whenStable();

        await fixture.componentInstance.queue();
        expect(store.queueAlbum).toHaveBeenCalledWith({
            albumArtist: 'Radiohead',
            album: 'Kid A',
        });
        expect(store.playAlbum).not.toHaveBeenCalled();
        expect(TestBed.inject(NowPlayingSheet).open()).toBeFalse();
    });

    it('cannot be double-sent while a request is in flight', async () => {
        const store = fakeStore();
        let release: () => void = () => {};
        store.playAlbum.and.returnValue(
            new Promise<void>((r) => {
                release = r;
            }),
        );
        const fixture = create(store);
        fixture.detectChanges();
        await fixture.whenStable();

        const first = fixture.componentInstance.play();
        await fixture.componentInstance.play(); // ignored: busy
        release();
        await first;

        expect(store.playAlbum).toHaveBeenCalledTimes(1);
    });

    it('states the running time when every track has a duration', async () => {
        const fixture = create(fakeStore());
        fixture.detectChanges();
        await fixture.whenStable();
        // 267 + 264 = 531s = 8:51
        expect(fixture.componentInstance.summary()).toBe('2 tracks · 8:51');
    });

    it('states no running time when a track has no duration', async () => {
        const fixture = create(
            fakeStore(
                response({
                    tracks: [track('a', 267, 'a/1.flac'), track('b', undefined, 'a/2.flac')],
                }),
            ),
        );
        fixture.detectChanges();
        await fixture.whenStable();
        // A partial sum stated as the album's length would simply be wrong.
        expect(fixture.componentInstance.summary()).toBe('2 tracks');
    });

    it('renders an album over an hour as h:mm:ss, not as minutes', async () => {
        const fixture = create(
            fakeStore(
                response({
                    tracks: [track('long', 4934, 'a/1.flac')],
                }),
            ),
        );
        fixture.detectChanges();
        await fixture.whenStable();
        // clock() would say 82:14, which is not how an album length is read.
        expect(fixture.componentInstance.summary()).toBe('1 track · 1:22:14');
    });

    it('reports an error instead of loading forever', async () => {
        const store = fakeStore();
        store.fetchAlbum.and.rejectWith(new Error('no such album'));
        const fixture = create(store);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(fixture.componentInstance.error()).toBe('no such album');
        expect(fixture.componentInstance.loading()).toBeFalse();
    });
});
