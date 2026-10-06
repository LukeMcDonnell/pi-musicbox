/**
 * Playlists: MPD's own stored playlists, read through the bridge and cached
 * until MPD reports `stored_playlist`. Why MPD and not the database: see
 * .claude/docs/decisions.md.
 */

import { randomUUID } from 'node:crypto';
import { CD_URI_PREFIX, type PlaylistResponse, type PlaylistSummary } from '../../shared/api.ts';
import { artUriFor } from './art.ts';
import type { MpdBridge } from './mpd/bridge.ts';
import { MpdError, firstValue, quoteArg } from './mpd/protocol.ts';

export type SaveMode = 'create' | 'append' | 'replace';

export type PlaylistsListener = (playlists: PlaylistSummary[]) => void;

/** ACK [50]: MPD has no playlist by that name. */
export class PlaylistNotFoundError extends Error {}
/** ACK [56]: a playlist by that name already exists. */
export class PlaylistExistsError extends Error {}
/** The track a request named is no longer where it said: someone else edited the playlist. */
export class PlaylistChangedError extends Error {}

export interface Playlists {
    /** The cached list, or null before the first successful read. */
    current(): PlaylistSummary[] | null;
    /** The list, read from MPD unless cached. */
    list(): Promise<PlaylistSummary[]>;
    get(name: string): Promise<PlaylistResponse>;
    create(name: string): Promise<PlaylistSummary[]>;
    rename(from: string, to: string): Promise<PlaylistSummary[]>;
    remove(name: string): Promise<PlaylistSummary[]>;
    /** Save these files: as a new playlist, onto the end of one, or in place of its contents. */
    saveQueue(name: string, files: readonly string[], mode: SaveMode): Promise<PlaylistSummary[]>;
    /** Append one library song, or insert it at `pos`. An absent playlist is not-found, not created. */
    addTrack(name: string, file: string, pos?: number): Promise<PlaylistSummary[]>;
    /** Move the track at `from` to `to`, provided `file` is still at `from`. */
    moveTrack(name: string, from: number, to: number, file: string): Promise<PlaylistResponse>;
    /** Remove the track at `pos`, provided `file` is still there. */
    removeTrack(name: string, pos: number, file: string): Promise<PlaylistResponse>;
    onChange(listener: PlaylistsListener): () => void;
}

type PlaylistBridge = Pick<
    MpdBridge,
    | 'listPlaylists'
    | 'playlistLength'
    | 'playlistTracks'
    | 'playlistFiles'
    | 'anySong'
    | 'runAll'
    | 'onIdle'
    | 'onSnapshot'
>;

/** A usable name, or why not. MPD itself refuses `/` and newlines. */
export function playlistNameError(name: unknown): string | null {
    if (typeof name !== 'string' || name.trim() === '') return 'a playlist needs a name';
    if (name !== name.trim()) return 'a playlist name cannot start or end with a space';
    if ([...name].length > 100) return 'a playlist name is at most 100 characters';
    if (name.includes('/')) return "a playlist name cannot contain '/'";
    if (name.startsWith('.')) return "a playlist name cannot start with '.'";
    if (/[\u0000-\u001f\u007f]/.test(name)) return 'a playlist name cannot contain control characters';
    return null;
}

/** Up to four different covers, in order. A cover is its file's folder, as Track.image is. */
export function coversOf(files: readonly string[]): string[] {
    const covers = new Set<string>();
    for (const file of files) {
        if (file.startsWith(CD_URI_PREFIX)) continue;
        covers.add(artUriFor(file));
        if (covers.size === 4) break;
    }
    return [...covers];
}

/** `missing` is the name an ACK [50] is about, `taken` the one an ACK [56] is. */
export function mapPlaylistAck(err: unknown, missing: string, taken = missing): unknown {
    if (!(err instanceof MpdError)) return err;
    if (err.message.startsWith('ACK [50@')) return new PlaylistNotFoundError(`no playlist named '${missing}'`);
    if (err.message.startsWith('ACK [56@')) return new PlaylistExistsError(`a playlist named '${taken}' already exists`);
    return err;
}

export function createPlaylists(bridge: PlaylistBridge): Playlists {
    const listeners = new Set<PlaylistsListener>();
    let cache: PlaylistSummary[] | null = null;
    let loading: Promise<PlaylistSummary[]> | null = null;
    // Bumped on every invalidation, so a read that began before a change is not cached.
    let generation = 0;

    async function summaryOf(name: string, modified: string): Promise<PlaylistSummary> {
        const [reply, files] = await Promise.all([bridge.playlistLength(name), bridge.playlistFiles(name)]);
        const trackCount = Number(firstValue(reply, 'songs') ?? 0);
        const playtime = Number(firstValue(reply, 'playtime') ?? 0);
        return { name, trackCount, duration: trackCount === 0 ? null : playtime, modified, covers: coversOf(files) };
    }

    async function read(): Promise<PlaylistSummary[]> {
        const reply = await bridge.listPlaylists();
        const entries: Array<[string, string]> = [];
        for (const [k, v] of reply.pairs) {
            if (k === 'playlist') entries.push([v, '']);
            else if (k === 'Last-Modified' && entries.length > 0) entries[entries.length - 1][1] = v;
        }
        const summaries = await Promise.all(entries.map(([name, modified]) => summaryOf(name, modified)));
        return summaries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }

    function list(): Promise<PlaylistSummary[]> {
        if (cache !== null) return Promise.resolve(cache);
        if (loading !== null) return loading;
        const started = generation;
        const pending = read().then(
            (playlists) => {
                if (loading === pending) loading = null;
                if (started === generation) {
                    cache = playlists;
                    for (const listener of [...listeners]) listener(playlists);
                }
                return playlists;
            },
            (err: unknown) => {
                if (loading === pending) loading = null;
                throw err;
            },
        );
        loading = pending;
        return pending;
    }

    function invalidate(): void {
        generation += 1;
        cache = null;
        loading = null;
    }

    /** Re-read after a change, so every listener hears about it. */
    async function reload(): Promise<PlaylistSummary[]> {
        invalidate();
        return list();
    }

    bridge.onIdle((subsystems) => {
        if (subsystems.includes('stored_playlist')) void reload().catch(() => {});
    });
    // MPD may still be starting when the first client connects; read once it answers.
    bridge.onSnapshot((snapshot) => {
        if (cache === null && loading === null && snapshot.status === 'ok') void list().catch(() => {});
    });

    async function write(cmds: string[], missing: string, taken = missing): Promise<PlaylistSummary[]> {
        try {
            await bridge.runAll(cmds);
        } catch (err) {
            throw mapPlaylistAck(err, missing, taken);
        }
        return reload();
    }

    async function filesOf(name: string): Promise<string[]> {
        try {
            return await bridge.playlistFiles(name);
        } catch (err) {
            throw mapPlaylistAck(err, name);
        }
    }

    // A stored playlist has no song ids, so the file the client saw stands in for one.
    function expectAt(files: readonly string[], pos: number, file: string): void {
        if (pos >= files.length) throw new RangeError(`position ${pos} is past the end`);
        if (files[pos] !== file) throw new PlaylistChangedError('the playlist has changed; reload it');
    }

        async function mustExist(name: string): Promise<void> {
        if (!(await list()).some((p) => p.name === name)) {
            throw new PlaylistNotFoundError(`no playlist named '${name}'`);
        }
    }

    /** A new playlist holding `files`, under a scratch name. MPD has no "create": an empty one is add-then-delete. */
    async function buildScratch(files: readonly string[]): Promise<string> {
        const scratch = `musicbox-new-${randomUUID()}`;
        const add = (file: string) => `playlistadd ${quoteArg(scratch)} ${quoteArg(file)}`;
        let cmds = files.map(add);
        if (cmds.length === 0) {
            const song = await bridge.anySong();
            if (song?.file === undefined) throw new Error('the library is empty');
            cmds = [add(song.file), `playlistdelete ${quoteArg(scratch)} 0`];
        }
        try {
            await bridge.runAll(cmds);
        } catch (err) {
            await bridge.runAll([`rm ${quoteArg(scratch)}`]).catch(() => {});
            throw mapPlaylistAck(err, scratch);
        }
        return scratch;
    }

    /**
     * Built under a scratch name and renamed into place, so a taken name or a
     * failed build never touches an existing playlist. Replace moves the old one
     * aside first and puts it back if the swap fails.
     */
    async function saveFiles(name: string, files: readonly string[], mode: SaveMode): Promise<PlaylistSummary[]> {
        if (mode === 'append') {
            await mustExist(name);
            return write(files.map((f) => `playlistadd ${quoteArg(name)} ${quoteArg(f)}`), name);
        }
        if (mode === 'replace') await mustExist(name);
        const scratch = await buildScratch(files);
        const target = quoteArg(name);
        const backup = quoteArg(`musicbox-old-${randomUUID()}`);
        try {
            if (mode === 'create') {
                await bridge.runAll([`rename ${quoteArg(scratch)} ${target}`]);
            } else {
                await bridge.runAll([`rename ${target} ${backup}`]);
                try {
                    await bridge.runAll([`rename ${quoteArg(scratch)} ${target}`]);
                } catch (err) {
                    await bridge.runAll([`rename ${backup} ${target}`]).catch(() => {});
                    throw err;
                }
                await bridge.runAll([`rm ${backup}`]).catch(() => {});
            }
        } catch (err) {
            await bridge.runAll([`rm ${quoteArg(scratch)}`]).catch(() => {});
            throw mapPlaylistAck(err, name);
        }
        return reload();
    }

    async function getPlaylist(name: string): Promise<PlaylistResponse> {
        const summary = (await list()).find((p) => p.name === name);
        if (summary === undefined) throw new PlaylistNotFoundError(`no playlist named '${name}'`);
        try {
            return { playlist: summary, tracks: await bridge.playlistTracks(name) };
        } catch (err) {
            throw mapPlaylistAck(err, name);
        }
    }

    return {
        current: () => cache,
        list,
        get: getPlaylist,
        create(name) {
            return saveFiles(name, [], 'create');
        },
        saveQueue: saveFiles,
        rename(from, to) {
            return write([`rename ${quoteArg(from)} ${quoteArg(to)}`], from, to);
        },
        remove(name) {
            return write([`rm ${quoteArg(name)}`], name);
        },
        async addTrack(name, file, pos) {
            // `playlistadd` would quietly create a misspelt playlist.
            await mustExist(name);
            const add = `playlistadd ${quoteArg(name)} ${quoteArg(file)}`;
            if (pos === undefined) return write([add], name);
            const files = await filesOf(name);
            if (pos > files.length) throw new RangeError(`position ${pos} is past the end`);
            return write([`${add} ${pos}`], name);
        },
        async moveTrack(name, from, to, file) {
            const files = await filesOf(name);
            if (to >= files.length) throw new RangeError(`position ${to} is past the end`);
            expectAt(files, from, file);
            await write([`playlistmove ${quoteArg(name)} ${from} ${to}`], name);
            return getPlaylist(name);
        },
        async removeTrack(name, pos, file) {
            expectAt(await filesOf(name), pos, file);
            await write([`playlistdelete ${quoteArg(name)} ${pos}`], name);
            return getPlaylist(name);
        },
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
