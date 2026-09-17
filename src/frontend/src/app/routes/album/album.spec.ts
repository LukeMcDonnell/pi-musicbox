import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AlbumResponse, AlbumSummary, Track } from '@musicbox/shared';
import { Album } from './album';
import { LibraryStore } from '../../services/library-store';
import { NowPlayingSheet } from '../../services/now-playing-sheet';
import { PREFERENCES_KEY, Preferences } from '../../services/preferences';

function track(
    title: string,
    duration: number | undefined,
    file: string,
    tags: Partial<Track> = {},
): Track {
    return { title, duration, file, image: '/api/art?album=x', ...tags };
}

/** `album` overrides the header, which the backend derives from the same tracks. */
function response(
    over: Partial<AlbumResponse> = {},
    album: Partial<AlbumSummary> = {},
): AlbumResponse {
    return {
        album: {
            album: 'Kid A',
            albumArtist: 'Radiohead',
            date: '2000-10-02',
            trackCount: 2,
            genres: ['Alternative Rock', 'Art Rock'],
            discCount: 1,
            duration: 531,
            image: '/api/art?album=Radiohead%2FKid%20A',
            ...album,
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
    // The Interface tab decides what Play and Queue do to the screen, and it
    // is stored per device — so each case here starts from the defaults.
    beforeEach(() => localStorage.removeItem(PREFERENCES_KEY));
    afterAll(() => localStorage.removeItem(PREFERENCES_KEY));

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

    it('leaves now-playing alone on Play when the user turned that off', async () => {
        const store = fakeStore();
        const fixture = create(store);
        fixture.detectChanges();
        await fixture.whenStable();
        TestBed.inject(Preferences).set('openNowPlayingOnPlay', false);

        await fixture.componentInstance.play();
        expect(store.playAlbum).toHaveBeenCalled();
        expect(TestBed.inject(NowPlayingSheet).open()).toBeFalse();
    });

    it('opens on the queue after Queue when the user asked for that', async () => {
        const store = fakeStore();
        const fixture = create(store);
        fixture.detectChanges();
        await fixture.whenStable();
        TestBed.inject(Preferences).set('openQueueOnAdd', true);

        await fixture.componentInstance.queue();
        const sheet = TestBed.inject(NowPlayingSheet);
        expect(sheet.open()).toBeTrue();
        // On the queue, not on the track: the album was appended, not started.
        expect(sheet.atQueue()).toBeTrue();
    });

    it('does NOT open on the queue when Queue was refused', async () => {
        const store = fakeStore();
        store.queueAlbum.and.rejectWith(new Error('cannot queue while a phone owns the DAC'));
        const fixture = create(store);
        fixture.detectChanges();
        await fixture.whenStable();
        TestBed.inject(Preferences).set('openQueueOnAdd', true);

        await fixture.componentInstance.queue();
        expect(TestBed.inject(NowPlayingSheet).open()).toBeFalse();
        expect(fixture.componentInstance.error()).toMatch(/phone owns the DAC/);
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
                response(
                    { tracks: [track('a', 267, 'a/1.flac'), track('b', undefined, 'a/2.flac')] },
                    // The backend withholds the runtime when a track has none.
                    { duration: null },
                ),
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
                response(
                    { tracks: [track('long', 4934, 'a/1.flac')] },
                    { trackCount: 1, duration: 4934 },
                ),
            ),
        );
        fixture.detectChanges();
        await fixture.whenStable();
        // clock() would say 82:14, which is not how an album length is read.
        expect(fixture.componentInstance.summary()).toBe('1 track · 1:22:14');
    });

    it('leaves a single-disc album as one unheaded group', async () => {
        const fixture = create(fakeStore());
        fixture.detectChanges();
        await fixture.whenStable();
        // 2,562 of this library's 2,876 albums. The common case must not sprout
        // a "Disc 1" heading.
        const groups = fixture.componentInstance.discs();
        expect(groups.length).toBe(1);
        expect(groups[0].disc).toBeNull();
        expect(groups[0].tracks.length).toBe(2);
    });

    it('splits a multi-disc album and restarts the numbering on each disc', async () => {
        // Alice in Chains / Music Bank is three discs, each starting at track 1.
        // Numbering by position ran it 1 to 48.
        const fixture = create(
            fakeStore(
                response(
                    {
                        tracks: [
                            track('d1t1', 10, 'a/1.flac', { disc: '1', track: '1' }),
                            track('d1t2', 10, 'a/2.flac', { disc: '1', track: '2' }),
                            track('d2t1', 10, 'b/1.flac', { disc: '2', track: '1' }),
                            track('d3t1', 10, 'c/1.flac', { disc: '3', track: '1' }),
                        ],
                    },
                    { discCount: 3, trackCount: 4, duration: 40 },
                ),
            ),
        );
        fixture.detectChanges();
        await fixture.whenStable();

        const cmp = fixture.componentInstance;
        expect(cmp.discs().map((g) => g.disc)).toEqual(['1', '2', '3']);
        expect(cmp.discs().map((g) => g.tracks.length)).toEqual([2, 1, 1]);
        // Each disc's first track is number 1, not 1, then 3, then 4.
        expect(cmp.discs().map((g) => cmp.numberOf(g.tracks[0], 0))).toEqual([1, 1, 1]);
    });

    it('takes the leading integer of an n/total track tag', async () => {
        const cmp = create(fakeStore()).componentInstance;
        // Some files here tag it `4/12`.
        expect(cmp.numberOf(track('a', 10, 'a.flac', { track: '4/12' }), 7)).toBe(4);
        expect(cmp.numberOf(track('a', 10, 'a.flac', { track: '10' }), 0)).toBe(10);
        // Untagged falls back to its place in the disc, not to zero.
        expect(cmp.numberOf(track('a', 10, 'a.flac'), 2)).toBe(3);
    });

    it('keeps untagged tracks in a trailing group with no heading', async () => {
        const fixture = create(
            fakeStore(
                response(
                    {
                        tracks: [
                            track('a', 10, 'a/1.flac', { disc: '1', track: '1' }),
                            track('b', 10, 'b/1.flac'),
                        ],
                    },
                    { discCount: 2, trackCount: 2, duration: 20 },
                ),
            ),
        );
        fixture.detectChanges();
        await fixture.whenStable();
        // ~6 songs in 38,978 have no Disc tag. Inventing one for them would be a
        // confident guess about which disc they belong to.
        expect(fixture.componentInstance.discs().map((g) => g.disc)).toEqual(['1', null]);
    });

    it('joins the genres into one line, and says nothing when there are none', async () => {
        const fixture = create(fakeStore());
        fixture.detectChanges();
        await fixture.whenStable();
        expect(fixture.componentInstance.genreLine()).toBe('Alternative Rock, Art Rock');
    });

    it('has no genre line for an untagged album', async () => {
        const fixture = create(fakeStore(response({}, { genres: [] })));
        fixture.detectChanges();
        await fixture.whenStable();
        // 4 albums here carry no Genre tag at all.
        expect(fixture.componentInstance.genreLine()).toBeNull();
    });

    it('plays a whole album with NO disc key at all', async () => {
        const store = fakeStore();
        const fixture = create(store);
        fixture.detectChanges();
        await fixture.whenStable();

        await fixture.componentInstance.play();
        const ref = store.playAlbum.calls.mostRecent().args[0];
        expect(ref).toEqual({ albumArtist: 'Radiohead', album: 'Kid A' });
        // Absent, not `disc: null` — the backend rejects a non-string disc, so
        // the key has to be missing rather than nulled.
        expect('disc' in ref).toBeFalse();
    });

    it('plays and queues a single disc by narrowing the same ref', async () => {
        const store = fakeStore();
        const fixture = create(store, 'Alice in Chains', 'Music Bank');
        fixture.detectChanges();
        await fixture.whenStable();

        await fixture.componentInstance.play('2');
        expect(store.playAlbum).toHaveBeenCalledWith({
            albumArtist: 'Alice in Chains',
            album: 'Music Bank',
            disc: '2',
        });

        await fixture.componentInstance.queue('3');
        expect(store.queueAlbum).toHaveBeenCalledWith({
            albumArtist: 'Alice in Chains',
            album: 'Music Bank',
            disc: '3',
        });
    });

    it('does not raise now-playing when a disc Play was refused', async () => {
        const store = fakeStore();
        store.playAlbum.and.rejectWith(new Error('cannot play an album while a phone owns the DAC'));
        const fixture = create(store);
        fixture.detectChanges();
        await fixture.whenStable();

        await fixture.componentInstance.play('2');
        expect(TestBed.inject(NowPlayingSheet).open()).toBeFalse();
        expect(fixture.componentInstance.error()).toMatch(/phone owns the DAC/);
    });

    it('shares one busy guard across the album and disc buttons', async () => {
        const store = fakeStore();
        let release: () => void = () => {};
        store.playAlbum.and.returnValue(new Promise<void>((r) => { release = r; }));
        const fixture = create(store);
        fixture.detectChanges();
        await fixture.whenStable();

        const first = fixture.componentInstance.play();
        // A disc button pressed while the album request is in flight must not
        // send a second command.
        await fixture.componentInstance.play('2');
        release();
        await first;

        expect(store.playAlbum).toHaveBeenCalledTimes(1);
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
