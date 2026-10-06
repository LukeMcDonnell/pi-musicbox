import { Injectable, inject } from '@angular/core';
import type { AlbumRef, PlaylistResponse, PlaylistsResponse } from '@musicbox/shared';
import { ApiClient } from './api-client';
import { MusicboxApi } from './musicbox-api';

/*
  MPD's stored playlists. The list is the box's and arrives on the stream; the
  writes apply their answer at once rather than waiting for their own event.
*/
@Injectable({ providedIn: 'root' })
export class PlaylistsStore {
    private readonly api = inject(ApiClient);
    private readonly box = inject(MusicboxApi);

    /** Null before the first frame. */
    readonly playlists = this.box.playlists;

    fetchPlaylist(name: string): Promise<PlaylistResponse> {
        return this.api.getJson<PlaylistResponse>(`/api/playlist?name=${encodeURIComponent(name)}`);
    }

    async create(name: string): Promise<void> {
        const { playlists } = await this.api.postJson<PlaylistsResponse>('/api/playlists', { name });
        this.box.setPlaylists(playlists);
    }

    async rename(from: string, to: string): Promise<void> {
        const { playlists } = await this.api.postJson<PlaylistsResponse>('/api/playlist/rename', { from, to });
        this.box.setPlaylists(playlists);
    }

    async remove(name: string): Promise<void> {
        const { playlists } = await this.api.deleteJson<PlaylistsResponse>(
            `/api/playlist?name=${encodeURIComponent(name)}`,
        );
        this.box.setPlaylists(playlists);
    }

    /** Append one library song to a playlist, or insert it at `pos`. */
    async addTrack(name: string, file: string, pos?: number): Promise<void> {
        const body = pos === undefined ? { name, file } : { name, file, pos };
        const { playlists } = await this.api.postJson<PlaylistsResponse>('/api/playlist/add', body);
        this.box.setPlaylists(playlists);
    }

    /** Append a library album's tracks. */
    async addAlbum(name: string, ref: AlbumRef): Promise<void> {
        const { playlists } = await this.api.postJson<PlaylistsResponse>('/api/playlist/add-album', { name, ...ref });
        this.box.setPlaylists(playlists);
    }

    /** Move a track, naming the file at `from` so a stale screen is refused. */
    moveTrack(name: string, from: number, to: number, file: string): Promise<PlaylistResponse> {
        return this.api.postJson<PlaylistResponse>('/api/playlist/move', { name, from, to, file });
    }

    /** Remove a track, naming the file at `pos` so a stale screen is refused. */
    removeTrack(name: string, pos: number, file: string): Promise<PlaylistResponse> {
        return this.api.postJson<PlaylistResponse>('/api/playlist/remove', { name, pos, file });
    }

    /** Put the playlist in a random order. */
    shuffle(name: string): Promise<PlaylistResponse> {
        return this.api.postJson<PlaylistResponse>('/api/playlist/shuffle', { name });
    }

    /** The queue, less any CD tracks, as a new playlist. */
    saveQueue(name: string): Promise<void> {
        return this.write('/api/queue/save', name);
    }

    /** The queue onto the end of an existing playlist. */
    appendQueue(name: string): Promise<void> {
        return this.write('/api/queue/save/append', name);
    }

    /** The queue in place of an existing playlist's contents. */
    replaceWithQueue(name: string): Promise<void> {
        return this.write('/api/queue/save/replace', name);
    }

    private async write(path: string, name: string): Promise<void> {
        const { playlists } = await this.api.postJson<PlaylistsResponse>(path, { name });
        this.box.setPlaylists(playlists);
    }

    /** Replace the queue with the playlist and start playing it. */
    async play(name: string): Promise<void> {
        await this.api.post('/api/playlist/play', { name });
    }

    /** Append the playlist to the queue. */
    async queue(name: string): Promise<void> {
        await this.api.post('/api/playlist/queue', { name });
    }
}
