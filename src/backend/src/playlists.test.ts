import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot, Track } from '../../shared/api.ts';
import type { MpdBridge } from './mpd/bridge.ts';
import { MpdError, type Reply } from './mpd/protocol.ts';
import {
    PlaylistChangedError,
    PlaylistExistsError,
    PlaylistNotFoundError,
    coversOf,
    createPlaylists,
    playlistNameError,
} from './playlists.ts';

/** An in-memory MPD holding stored playlists of song files. */
function fakeBridge(initial: Record<string, string[]> = {}) {
    const stored = new Map(Object.entries(initial));
    const calls: string[] = [];
    let idle: (subsystems: readonly string[]) => void = () => {};
    let snapshot: (s: Snapshot) => void = () => {};
    const unquote = (cmd: string) => [...cmd.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    const bridge = {
        calls,
        stored,
        idle: (subsystems: string[]) => idle(subsystems),
        snapshot: (s: Partial<Snapshot>) => snapshot(s as Snapshot),
        async listPlaylists(): Promise<Reply> {
            calls.push('listplaylists');
            return {
                pairs: [...stored.keys()].flatMap((name): Array<[string, string]> => [
                    ['playlist', name],
                    ['Last-Modified', '2026-10-06T00:00:00Z'],
                ]),
            };
        },
        async playlistLength(name: string): Promise<Reply> {
            const songs = stored.get(name);
            if (!songs) throw new MpdError('ACK [50@0] {playlistlength} No such playlist');
            return { pairs: [['songs', String(songs.length)], ['playtime', String(songs.length * 100)]] };
        },
        async playlistFiles(name: string): Promise<string[]> {
            const songs = stored.get(name);
            if (!songs) throw new MpdError('ACK [50@0] {listplaylist} No such playlist');
            return songs;
        },
        async playlistTracks(name: string): Promise<Track[]> {
            const songs = stored.get(name);
            if (!songs) throw new MpdError('ACK [50@0] {listplaylistinfo} No such playlist');
            return songs.map((file) => ({ file, title: file, image: null }));
        },
        async anySong(): Promise<Track | null> {
            return { file: 'a/1.flac', title: '1', image: null };
        },
        async runAll(cmds: string[]): Promise<void> {
            for (const cmd of cmds) {
                calls.push(cmd);
                const [verb] = cmd.split(' ');
                const [a, b] = unquote(cmd);
                const last = cmd.split(' ').at(-1)!;
                if (verb === 'playlistadd') {
                    const songs = [...(stored.get(a) ?? [])];
                    if (/^\d+$/.test(last)) songs.splice(Number(last), 0, b);
                    else songs.push(b);
                    stored.set(a, songs);
                } else if (verb === 'playlistmove') {
                    const [from, to] = cmd.split(' ').slice(-2).map(Number);
                    const songs = stored.get(a)!;
                    songs.splice(to, 0, ...songs.splice(from, 1));
                } else if (verb === 'playlistdelete') stored.get(a)!.splice(Number(cmd.split(' ').at(-1)), 1);
                else if (verb === 'rm') {
                    if (!stored.delete(a)) throw new MpdError('ACK [50@0] {rm} No such playlist');
                } else if (verb === 'rename') {
                    if (!stored.has(a)) throw new MpdError('ACK [50@0] {rename} No such playlist');
                    if (stored.has(b)) throw new MpdError('ACK [56@0] {rename} Playlist exists already');
                    stored.set(b, stored.get(a)!);
                    stored.delete(a);
                }
            }
        },
        onIdle(fn: typeof idle) {
            idle = fn;
            return () => {};
        },
        onSnapshot(fn: typeof snapshot) {
            snapshot = fn;
            return () => {};
        },
    };
    return bridge;
}

const asBridge = (b: ReturnType<typeof fakeBridge>) => b as unknown as MpdBridge;

test('a playlist name is refused before it can reach MPD', () => {
    for (const bad of [undefined, 1, '', '   ', ' lead', 'trail ', 'a/b', '.hidden', 'a\nb', 'x'.repeat(101)]) {
        assert.notEqual(playlistNameError(bad), null, JSON.stringify(bad));
    }
    for (const good of ['Road trip', 'AC-DC & friends', '日本語', 'x'.repeat(100)]) {
        assert.equal(playlistNameError(good), null, good);
    }
});

test('the list is sorted case-blind, counted, and an empty one has no duration', async () => {
    const bridge = fakeBridge({ zed: ['a'], alpha: [], Beta: ['a', 'b'] });
    const list = await createPlaylists(asBridge(bridge)).list();
    assert.deepEqual(
        list.map((p) => [p.name, p.trackCount, p.duration]),
        [['alpha', 0, null], ['Beta', 2, 200], ['zed', 1, 100]],
    );
});

test('the list is cached until MPD says a stored playlist changed', async () => {
    const bridge = fakeBridge({ one: [] });
    const playlists = createPlaylists(asBridge(bridge));
    const heard: string[][] = [];
    playlists.onChange((list) => heard.push(list.map((p) => p.name)));

    await playlists.list();
    await playlists.list();
    assert.equal(bridge.calls.filter((c) => c === 'listplaylists').length, 1);

    bridge.stored.set('two', []);
    bridge.idle(['player']);
    assert.equal(playlists.current()?.length, 1, 'other subsystems leave it alone');

    bridge.idle(['stored_playlist']);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(heard.at(-1), ['one', 'two']);
});

test('the first snapshot from a running MPD loads the list for clients already waiting', async () => {
    const bridge = fakeBridge({ one: [] });
    const playlists = createPlaylists(asBridge(bridge));
    bridge.snapshot({ status: 'unavailable' as Snapshot['status'] });
    assert.equal(bridge.calls.length, 0);
    bridge.snapshot({ status: 'ok' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(playlists.current()?.map((p) => p.name), ['one']);
});

test('a new playlist is built under a scratch name, emptied, then renamed into place', async () => {
    const bridge = fakeBridge();
    const list = await createPlaylists(asBridge(bridge)).create('Road trip');
    assert.deepEqual(list.map((p) => [p.name, p.trackCount]), [['Road trip', 0]]);
    const writes = bridge.calls.filter((c) => c !== 'listplaylists');
    assert.match(writes[0], /^playlistadd "musicbox-new-[0-9a-f-]+" "a\/1.flac"$/);
    assert.match(writes[1], /^playlistdelete "musicbox-new-[0-9a-f-]+" 0$/);
    assert.match(writes[2], /^rename "musicbox-new-[0-9a-f-]+" "Road trip"$/);
    assert.equal(bridge.stored.size, 1);
});

test('creating a name that exists leaves the existing playlist untouched', async () => {
    const bridge = fakeBridge({ Mine: ['x', 'y'] });
    await assert.rejects(createPlaylists(asBridge(bridge)).create('Mine'), PlaylistExistsError);
    assert.deepEqual(bridge.stored.get('Mine'), ['x', 'y']);
    assert.deepEqual([...bridge.stored.keys()], ['Mine'], 'the scratch playlist is cleaned up');
});

test('rename and delete map MPD refusals onto the playlist each is about', async () => {
    const bridge = fakeBridge({ a: [], b: [] });
    const playlists = createPlaylists(asBridge(bridge));
    await assert.rejects(playlists.rename('nope', 'c'), (err: Error) => {
        assert.ok(err instanceof PlaylistNotFoundError);
        assert.match(err.message, /'nope'/);
        return true;
    });
    await assert.rejects(playlists.rename('a', 'b'), (err: Error) => {
        assert.ok(err instanceof PlaylistExistsError);
        assert.match(err.message, /'b'/);
        return true;
    });
    await assert.rejects(playlists.remove('nope'), PlaylistNotFoundError);

    assert.deepEqual((await playlists.rename('a', 'c')).map((p) => p.name), ['b', 'c']);
    assert.deepEqual((await playlists.remove('b')).map((p) => p.name), ['c']);
});

test('one playlist comes back with its tracks; a missing one is a not-found', async () => {
    const bridge = fakeBridge({ mix: ['a/1.flac', 'b/2.flac'] });
    const playlists = createPlaylists(asBridge(bridge));
    const { playlist, tracks } = await playlists.get('mix');
    assert.equal(playlist.trackCount, 2);
    assert.deepEqual(tracks.map((t) => t.file), ['a/1.flac', 'b/2.flac']);
    await assert.rejects(playlists.get('nope'), PlaylistNotFoundError);
});

test('a track is appended to an existing playlist, and never creates one', async () => {
    const bridge = fakeBridge({ mix: ['a/1.flac'] });
    const playlists = createPlaylists(asBridge(bridge));
    const list = await playlists.addTrack('mix', 'b/2.flac');
    assert.deepEqual(bridge.stored.get('mix'), ['a/1.flac', 'b/2.flac']);
    assert.equal(list[0].trackCount, 2);

    await assert.rejects(playlists.addTrack('mxi', 'b/2.flac'), PlaylistNotFoundError);
    assert.equal(bridge.stored.has('mxi'), false);
});

test('the queue saves as a new playlist, in order, and never over a taken name', async () => {
    const bridge = fakeBridge({ Taken: ['x'] });
    const playlists = createPlaylists(asBridge(bridge));
    await playlists.saveQueue('Mine', ['a/1.flac', 'b/2.flac'], 'create');
    assert.deepEqual(bridge.stored.get('Mine'), ['a/1.flac', 'b/2.flac']);

    await assert.rejects(playlists.saveQueue('Taken', ['a/1.flac'], 'create'), PlaylistExistsError);
    assert.deepEqual(bridge.stored.get('Taken'), ['x']);
    assert.deepEqual([...bridge.stored.keys()].sort(), ['Mine', 'Taken'], 'no scratch left behind');
});

test('the queue appends onto an existing playlist, and an absent one is not created', async () => {
    const bridge = fakeBridge({ Mix: ['x'] });
    const playlists = createPlaylists(asBridge(bridge));
    await playlists.saveQueue('Mix', ['a/1.flac'], 'append');
    assert.deepEqual(bridge.stored.get('Mix'), ['x', 'a/1.flac']);
    await assert.rejects(playlists.saveQueue('Mxi', ['a/1.flac'], 'append'), PlaylistNotFoundError);
    assert.equal(bridge.stored.has('Mxi'), false);
});

test('replace swaps the contents and leaves nothing else behind', async () => {
    const bridge = fakeBridge({ Mix: ['x', 'y'] });
    const playlists = createPlaylists(asBridge(bridge));
    const list = await playlists.saveQueue('Mix', ['a/1.flac'], 'replace');
    assert.deepEqual(bridge.stored.get('Mix'), ['a/1.flac']);
    assert.deepEqual([...bridge.stored.keys()], ['Mix']);
    assert.equal(list[0].trackCount, 1);
    await assert.rejects(playlists.saveQueue('Mxi', ['a/1.flac'], 'replace'), PlaylistNotFoundError);
});

test('a replace whose build fails leaves the original exactly as it was', async () => {
    const bridge = fakeBridge({ Mix: ['x', 'y'] });
    const runAll = bridge.runAll.bind(bridge);
    bridge.runAll = async (cmds: string[]) => {
        if (cmds.some((c) => c.includes('bad.flac'))) throw new MpdError('ACK [50@0] {playlistadd} No such song');
        return runAll(cmds);
    };
    const playlists = createPlaylists(asBridge(bridge));
    await assert.rejects(playlists.saveQueue('Mix', ['a/1.flac', 'bad.flac'], 'replace'));
    assert.deepEqual(bridge.stored.get('Mix'), ['x', 'y']);
    assert.deepEqual([...bridge.stored.keys()], ['Mix']);
});

test('a playlist offers up to four different covers, in order, skipping disc tracks', async () => {
    assert.deepEqual(coversOf([]), []);
    assert.deepEqual(
        coversOf(['A/1.flac', 'A/2.flac', 'cdda:///3', 'B/1.flac', 'C/1.flac', 'D/1.flac', 'E/1.flac']),
        ['A', 'B', 'C', 'D'].map((d) => `/api/art?album=${d}`),
    );
    const bridge = fakeBridge({ mix: ['X/1.flac', 'Y/2.flac'] });
    const [summary] = await createPlaylists(asBridge(bridge)).list();
    assert.deepEqual(summary.covers, ['/api/art?album=X', '/api/art?album=Y']);
});

test('a track moves, and the answer is the playlist as it now is', async () => {
    const bridge = fakeBridge({ mix: ['a', 'b', 'c', 'd'] });
    const playlists = createPlaylists(asBridge(bridge));
    const down = await playlists.moveTrack('mix', 0, 2, 'a');
    assert.deepEqual(down.tracks.map((t) => t.file), ['b', 'c', 'a', 'd']);
    const up = await playlists.moveTrack('mix', 3, 0, 'd');
    assert.deepEqual(up.tracks.map((t) => t.file), ['d', 'b', 'c', 'a']);
});

test('a track is removed, and Undo can put it back where it was', async () => {
    const bridge = fakeBridge({ mix: ['a', 'b', 'c'] });
    const playlists = createPlaylists(asBridge(bridge));
    const after = await playlists.removeTrack('mix', 1, 'b');
    assert.deepEqual(after.tracks.map((t) => t.file), ['a', 'c']);
    assert.equal(after.playlist.trackCount, 2);
    await playlists.addTrack('mix', 'b', 1);
    assert.deepEqual(bridge.stored.get('mix'), ['a', 'b', 'c']);
});

test('an edit naming a track that is no longer there changes nothing', async () => {
    const bridge = fakeBridge({ mix: ['a', 'b', 'c'] });
    const playlists = createPlaylists(asBridge(bridge));
    await assert.rejects(playlists.removeTrack('mix', 1, 'c'), PlaylistChangedError);
    await assert.rejects(playlists.moveTrack('mix', 0, 2, 'b'), PlaylistChangedError);
    assert.deepEqual(bridge.stored.get('mix'), ['a', 'b', 'c']);
});

test('positions past the end are refused, and a missing playlist is not-found', async () => {
    const bridge = fakeBridge({ mix: ['a', 'b'] });
    const playlists = createPlaylists(asBridge(bridge));
    await assert.rejects(playlists.removeTrack('mix', 2, 'a'), RangeError);
    await assert.rejects(playlists.moveTrack('mix', 0, 2, 'a'), RangeError);
    await assert.rejects(playlists.addTrack('mix', 'z', 3), RangeError);
    await playlists.addTrack('mix', 'z', 2);
    assert.deepEqual(bridge.stored.get('mix'), ['a', 'b', 'z']);
    await assert.rejects(playlists.removeTrack('nope', 0, 'a'), PlaylistNotFoundError);
});
