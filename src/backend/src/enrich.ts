/**
 * What the internet knows about the library: Wikipedia text, MusicBrainz genres,
 * ListenBrainz similar artists and listen counts. Harvested into SQLite in the
 * background, keyed by MusicBrainz id, and never fetched while a page waits.
 * See .claude/docs/decisions.md.
 */

import type { MetadataStatus } from '../../shared/api.ts';
import type { Db } from './db.ts';
import type { Reply } from './mpd/protocol.ts';
import { MUSICBRAINZ, isReleaseId as isMbid } from './cd-lookup.ts';

export const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
export const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
export const LISTENBRAINZ = 'https://api.listenbrainz.org/1';
export const LISTENBRAINZ_LABS = 'https://labs.api.listenbrainz.org';
// The algorithm ListenBrainz's own artist pages use.
const SIMILAR_ALGORITHM =
    'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';

const DAY_MS = 24 * 60 * 60 * 1000;
export const ARTIST_TTL_MS = 30 * DAY_MS;
export const ALBUM_TTL_MS = 90 * DAY_MS;
export const MISS_TTL_MS = 7 * DAY_MS;

const TIMEOUT_MS = 30_000;
/** Measured from the box: 6–24s an artist, sometimes more. */
const SIMILAR_TIMEOUT_MS = 60_000;
/** Wikidata's own query limit; 30s timed out from the box. */
const SPARQL_TIMEOUT_MS = 60_000;
const SPARQL_BATCH = 100;
const TIMEOUT_BACKOFF_MS = 5_000;
/** The most `exintro` extracts Wikipedia returns in one request. */
const EXTRACT_BATCH = 20;
/** Artists written per transaction, so an interrupted run keeps what it fetched. */
const ARTIST_CHUNK = 25;
const MAX_GENRES = 6;
const MAX_SIMILAR = 100;
const MAX_TEXT = 6_000;
const RETRIES = 3;
const MAX_BACKOFF_MS = 60_000;

/**
 * Milliseconds between requests to each host, one at a time. MusicBrainz and
 * ListenBrainz each publish "one a second"; Wikimedia asks only for serial requests.
 */
export const HOST_INTERVAL_MS: Readonly<Record<string, number>> = {
    'musicbrainz.org': 1_000,
    'query.wikidata.org': 1_000,
    'en.wikipedia.org': 200,
    'api.listenbrainz.org': 1_000,
    'labs.api.listenbrainz.org': 1_000,
};

export interface SimilarArtist {
    mbid: string;
    name: string;
}

export interface ArtistInfo {
    bio: string | null;
    bioUrl: string | null;
    genres: string[];
    /** Empty until fetched; that call is allowed to fail on its own. */
    similar: SimilarArtist[];
}

export interface AlbumInfo {
    about: string;
    aboutUrl: string;
}

export interface EnrichResult {
    artists: number;
    /** Artists whose similar-artists call failed, to be asked again next run. */
    unsure: number;
    albums: number;
    recordings: number;
    /** Why the run stopped early, or null when it finished. */
    stopped: string | null;
    ms: number;
}

/** Structural, so the tests never open a socket. */
export interface EnrichBridge {
    list(tag: string, ...groups: string[]): Promise<Reply>;
}

export interface EnrichOptions {
    db: Db;
    bridge: EnrichBridge;
    userAgent: string;
    /** Without one, ListenBrainz's popularity endpoint answers 401 and is skipped. */
    listenBrainzToken?: string | null;
    fetch?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    log?: (level: 'info' | 'warn', message: string) => void;
    intervals?: Readonly<Record<string, number>>;
}

export interface Enrich {
    artist(mbid: string): ArtistInfo | null;
    /** Null for an album with no write-up, as for one never fetched. */
    album(mbid: string): AlbumInfo | null;
    /** Listen counts for whichever of these recordings have one. */
    listens(mbids: readonly string[]): Map<string, number>;
    /** Fetch whatever is missing or stale. One run at a time; a second call joins it. */
    run(): Promise<EnrichResult>;
    /** For Settings → Status: the run in progress, the last one, and coverage. */
    status(): MetadataStatus;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Thrown to end a run: the network or a service is unwell, and that says nothing about the data. */
class Stop extends Error {}

/** The distinct, well-formed MusicBrainz ids a `list <tag>` reply names. */
export function idsOf(reply: Reply, tag: string): string[] {
    const want = tag.toLowerCase();
    const out = new Set<string>();
    for (const [key, value] of reply.pairs) {
        if (key.toLowerCase() === want && isMbid(value)) out.add(value);
    }
    return [...out];
}

/** The article's title from its URL: `.../wiki/AC%2FDC` is `AC/DC`. */
export function titleOfArticle(url: string): string | null {
    const at = url.indexOf('/wiki/');
    if (at === -1) return null;
    try {
        return decodeURIComponent(url.slice(at + 6)).replace(/_/g, ' ');
    } catch {
        return null;
    }
}

/** Wikipedia's plain-text intro, tidied: paragraphs kept, runs of blank lines dropped. */
export function tidyExtract(text: string): string | null {
    const tidy = text.replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();
    if (tidy === '') return null;
    return tidy.length <= MAX_TEXT ? tidy : `${tidy.slice(0, MAX_TEXT).replace(/\s+\S*$/, '')}…`;
}

/** Most-voted first; ties alphabetical so the order is stable. */
export function genresOf(body: unknown): string[] {
    return arr(obj(body).genres)
        .map(obj)
        .filter((g) => str(g.name) !== null)
        .sort((a, b) => Number(b.count ?? 0) - Number(a.count ?? 0) || String(a.name).localeCompare(String(b.name)))
        .slice(0, MAX_GENRES)
        .map((g) => String(g.name));
}

export function similarOf(body: unknown, self: string): SimilarArtist[] {
    const out: SimilarArtist[] = [];
    for (const entry of arr(body).map(obj)) {
        const mbid = entry.artist_mbid;
        const name = str(entry.name);
        if (!isMbid(mbid) || mbid === self || name === null) continue;
        out.push({ mbid, name });
        if (out.length === MAX_SIMILAR) break;
    }
    return out;
}

/**
 * Listens per recording, for the ones the library owns. ListenBrainz splits some
 * counts over several rows — "Nothing Else Matters" is 2,673,155 + 144,725 + 1 —
 * so they are added up; keeping the last row ranked it below the top 100.
 */
export function listensOf(body: unknown, owned: ReadonlySet<string>): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of arr(body).map(obj)) {
        const id = r.recording_mbid;
        const count = Number(r.total_listen_count);
        if (isMbid(id) && owned.has(id) && Number.isFinite(count) && count > 0) {
            out.set(id, (out.get(id) ?? 0) + count);
        }
    }
    return out;
}

export function createEnrich(opts: EnrichOptions): Enrich {
    const { db } = opts;
    const doFetch = opts.fetch ?? fetch;
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const log = opts.log ?? (() => {});
    const intervals = opts.intervals ?? HOST_INTERVAL_MS;
    const token = opts.listenBrainzToken ?? null;
    const last = new Map<string, number>();
    let running: Promise<EnrichResult> | null = null;
    let current: { phase: 'albums' | 'artists'; progress: number; total: number; startedAt: number } | null = null;
    let lastRun: MetadataStatus['lastRun'] = null;
    let library: { artists: number; albums: number } | null = null;

    /** JSON, or null for an answer that means "nothing here". Throws Stop when the service is unwell. */
    const getJson = async (
        url: string,
        init: RequestInit = {},
        { timeoutMs = TIMEOUT_MS, retries = RETRIES } = {},
    ): Promise<unknown> => {
        const host = new URL(url).host;
        for (let attempt = 0; ; attempt += 1) {
            const wait = (last.get(host) ?? 0) + (intervals[host] ?? 1_000) - now();
            if (wait > 0) await sleep(wait);
            last.set(host, now());
            let res: Response;
            try {
                res = await doFetch(url, {
                    ...init,
                    headers: { 'user-agent': opts.userAgent, accept: 'application/json', ...init.headers },
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (res.ok) return await res.json();
            } catch (err) {
                // Slow is normal for these services; unreachable is not.
                if (isTimeout(err) && attempt < retries) {
                    await sleep(TIMEOUT_BACKOFF_MS);
                    continue;
                }
                throw new Stop(`${host}: ${(err as Error).message}`);
            }
            if (res.status === 404) return null;
            // MusicBrainz says "slow down" with a 503, ListenBrainz with a 429.
            if ((res.status === 429 || res.status === 503) && attempt < retries) {
                await sleep(backoffOf(res));
                continue;
            }
            throw new Stop(`${host} answered HTTP ${res.status}`);
        }
    };

    /** English Wikipedia's intro for each id that has an article, via Wikidata. */
    const wikipedia = async (property: 'P434' | 'P436', ids: string[]): Promise<Map<string, AlbumInfo>> => {
        const out = new Map<string, AlbumInfo>();
        if (ids.length === 0) return out;
        // The ids are validated UUIDs, so quoting them into the query is safe.
        const query =
            `SELECT ?id ?article WHERE { VALUES ?id { ${ids.map((id) => `"${id}"`).join(' ')} } ` +
            `?item wdt:${property} ?id . ?article schema:about ?item ; ` +
            'schema:isPartOf <https://en.wikipedia.org/> . }';
        const body = await getJson(
            WIKIDATA_SPARQL,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    accept: 'application/sparql-results+json',
                },
                body: new URLSearchParams({ query }).toString(),
            },
            { timeoutMs: SPARQL_TIMEOUT_MS },
        );
        const articles = new Map<string, { url: string; title: string }>();
        for (const b of arr(obj(obj(body).results).bindings).map(obj)) {
            const id = str(obj(b.id).value);
            const url = str(obj(b.article).value);
            const title = url === null ? null : titleOfArticle(url);
            if (id === null || url === null || title === null || articles.has(id)) continue;
            articles.set(id, { url, title });
        }

        const titles = [...new Set([...articles.values()].map((a) => a.title))];
        const extracts = new Map<string, string>();
        for (let i = 0; i < titles.length; i += EXTRACT_BATCH) {
            const batch = titles.slice(i, i + EXTRACT_BATCH);
            const params = new URLSearchParams({
                action: 'query',
                format: 'json',
                formatversion: '2',
                prop: 'extracts',
                exintro: '1',
                explaintext: '1',
                exlimit: String(EXTRACT_BATCH),
                redirects: '1',
                titles: batch.join('|'),
            });
            const q = obj(obj(await getJson(`${WIKIPEDIA_API}?${params}`)).query);
            const rename = new Map<string, string>();
            for (const r of [...arr(q.normalized), ...arr(q.redirects)].map(obj)) {
                const from = str(r.from);
                const to = str(r.to);
                if (from !== null && to !== null) rename.set(from, to);
            }
            const pages = new Map<string, string>();
            for (const page of arr(q.pages).map(obj)) {
                const title = str(page.title);
                const text = tidyExtract(String(page.extract ?? ''));
                if (title !== null && text !== null) pages.set(title, text);
            }
            for (const title of batch) {
                let final = title;
                // normalized, then redirected: at most two hops.
                for (let hop = 0; hop < 2 && rename.has(final); hop += 1) final = rename.get(final)!;
                const text = pages.get(final);
                if (text !== undefined) extracts.set(title, text);
            }
        }

        for (const [id, article] of articles) {
            const about = extracts.get(article.title);
            if (about !== undefined) out.set(id, { about, aboutUrl: article.url });
        }
        return out;
    };

    const stale = (table: 'artist_info' | 'album_info', ids: string[], ttl: number, needsListens: boolean): string[] => {
        type Row = { mbid: string; fetched_at: number; empty: number; listens_at: number | null; unsure: number };
        const rows = new Map<string, Row>();
        const sql =
            table === 'artist_info'
                ? 'SELECT mbid, fetched_at, listens_at, (similar IS NULL) AS unsure, ' +
                  "(bio IS NULL AND genres = '[]' AND similar = '[]') AS empty FROM artist_info"
                : 'SELECT mbid, fetched_at, NULL AS listens_at, 0 AS unsure, (about IS NULL) AS empty FROM album_info';
        for (const row of db.all<Row>(sql)) rows.set(row.mbid, row);
        const at = now();
        return ids.filter((id) => {
            const row = rows.get(id);
            if (row === undefined || row.unsure) return true;
            if (needsListens && row.listens_at === null) return true;
            return at - row.fetched_at >= (row.empty ? MISS_TTL_MS : ttl);
        });
    };

    const harvest = async (): Promise<EnrichResult> => {
        const began = now();
        const result: EnrichResult = { artists: 0, unsure: 0, albums: 0, recordings: 0, stopped: null, ms: 0 };
        try {
            const artists = idsOf(await opts.bridge.list('MUSICBRAINZ_ALBUMARTISTID'), 'MUSICBRAINZ_ALBUMARTISTID');
            const groups = idsOf(await opts.bridge.list('MUSICBRAINZ_RELEASEGROUPID'), 'MUSICBRAINZ_RELEASEGROUPID');
            library = { artists: artists.length, albums: groups.length };
            const dueArtists = stale('artist_info', artists, ARTIST_TTL_MS, token !== null);
            const dueAlbums = stale('album_info', groups, ALBUM_TTL_MS, false);
            if (dueArtists.length === 0 && dueAlbums.length === 0) {
                result.ms = now() - began;
                return result;
            }
            // Only recordings the library holds are kept: Metallica alone has 2,232.
            const owned =
                token === null || dueArtists.length === 0
                    ? new Set<string>()
                    : new Set(idsOf(await opts.bridge.list('MUSICBRAINZ_TRACKID'), 'MUSICBRAINZ_TRACKID'));

            // Albums first: a few batched queries, where artists wait on a slow labs endpoint.
            current = { phase: 'albums', progress: 0, total: dueAlbums.length, startedAt: began };
            for (let i = 0; i < dueAlbums.length; i += SPARQL_BATCH) {
                const chunk = dueAlbums.slice(i, i + SPARQL_BATCH);
                const found = await wikipedia('P436', chunk);
                const at = now();
                db.transaction(() => {
                    for (const mbid of chunk) {
                        const info = found.get(mbid);
                        db.run(
                            'INSERT INTO album_info (mbid, about, about_url, fetched_at) VALUES (?, ?, ?, ?) ' +
                                'ON CONFLICT(mbid) DO UPDATE SET about = excluded.about, ' +
                                'about_url = excluded.about_url, fetched_at = excluded.fetched_at',
                            mbid,
                            info?.about ?? null,
                            info?.aboutUrl ?? null,
                            at,
                        );
                    }
                });
                result.albums += chunk.length;
                current.progress = result.albums;
            }

            current = { phase: 'artists', progress: 0, total: dueArtists.length, startedAt: began };
            for (let i = 0; i < dueArtists.length; i += ARTIST_CHUNK) {
                const chunk = dueArtists.slice(i, i + ARTIST_CHUNK);
                const bios = await wikipedia('P434', chunk);
                const rows: Array<{
                    mbid: string;
                    info: Omit<ArtistInfo, 'similar'> & { similar: SimilarArtist[] | null };
                    listens: Array<[string, number]> | null;
                }> = [];
                for (const mbid of chunk) {
                    const genres = genresOf(await getJson(`${MUSICBRAINZ}/artist/${mbid}?inc=genres&fmt=json`));
                    // A labs endpoint, and slow: a failure here costs this artist's list, not the run.
                    let similar: SimilarArtist[] | null = null;
                    try {
                        const url = `${LISTENBRAINZ_LABS}/similar-artists/json?artist_mbids=${mbid}&algorithm=${SIMILAR_ALGORITHM}`;
                        similar = similarOf(await getJson(url, {}, { timeoutMs: SIMILAR_TIMEOUT_MS, retries: 0 }), mbid);
                    } catch (err) {
                        if (!(err instanceof Stop)) throw err;
                        result.unsure += 1;
                    }
                    let listens: Array<[string, number]> | null = null;
                    if (token !== null) {
                        const top = await getJson(`${LISTENBRAINZ}/popularity/top-recordings-for-artist/${mbid}`, {
                            headers: { authorization: `Token ${token}` },
                        });
                        listens = [...listensOf(top, owned)];
                    }
                    const bio = bios.get(mbid);
                    current.progress += 1;
                    rows.push({
                        mbid,
                        info: { bio: bio?.about ?? null, bioUrl: bio?.aboutUrl ?? null, genres, similar },
                        listens,
                    });
                }
                const at = now();
                db.transaction(() => {
                    for (const { mbid, info, listens } of rows) {
                        db.run(
                            'INSERT INTO artist_info (mbid, bio, bio_url, genres, similar, fetched_at, listens_at) ' +
                                'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mbid) DO UPDATE SET ' +
                                'bio = excluded.bio, bio_url = excluded.bio_url, genres = excluded.genres, ' +
                                'similar = COALESCE(excluded.similar, artist_info.similar), fetched_at = excluded.fetched_at, ' +
                                'listens_at = COALESCE(excluded.listens_at, artist_info.listens_at)',
                            mbid,
                            info.bio,
                            info.bioUrl,
                            JSON.stringify(info.genres),
                            info.similar === null ? null : JSON.stringify(info.similar),
                            at,
                            listens === null ? null : at,
                        );
                        if (listens === null) continue;
                        db.run('DELETE FROM recording_listens WHERE artist_mbid = ?', mbid);
                        for (const [id, count] of listens) {
                            db.run(
                                'INSERT OR REPLACE INTO recording_listens (mbid, artist_mbid, listens) VALUES (?, ?, ?)',
                                id,
                                mbid,
                                count,
                            );
                        }
                        result.recordings += listens.length;
                    }
                });
                result.artists += rows.length;
            }
        } catch (err) {
            if (!(err instanceof Stop)) throw err;
            result.stopped = err.message;
        }
        result.ms = now() - began;
        log(
            result.stopped === null ? 'info' : 'warn',
            `enrich: ${result.albums} albums, ${result.artists} artists (${result.unsure} without similar), ` +
                `${result.recordings} listen counts` +
                `${token === null ? ' (no ListenBrainz token)' : ''} in ${Math.round(result.ms / 1000)}s` +
                (result.stopped === null ? '' : `, stopped: ${result.stopped}`),
        );
        return result;
    };

    return {
        artist(mbid) {
            const row = db.get<{ bio: string | null; bio_url: string | null; genres: string; similar: string | null }>(
                'SELECT bio, bio_url, genres, similar FROM artist_info WHERE mbid = ?',
                mbid,
            );
            if (row === undefined) return null;
            return {
                bio: row.bio,
                bioUrl: row.bio_url,
                genres: JSON.parse(row.genres) as string[],
                similar: JSON.parse(row.similar ?? '[]') as SimilarArtist[],
            };
        },
        album(mbid) {
            const row = db.get<{ about: string | null; about_url: string | null }>(
                'SELECT about, about_url FROM album_info WHERE mbid = ?',
                mbid,
            );
            return row?.about == null || row.about_url === null ? null : { about: row.about, aboutUrl: row.about_url };
        },
        listens(mbids) {
            const out = new Map<string, number>();
            const ids = [...new Set(mbids)];
            for (let i = 0; i < ids.length; i += 500) {
                const batch = ids.slice(i, i + 500);
                const rows = db.all<{ mbid: string; listens: number }>(
                    `SELECT mbid, listens FROM recording_listens WHERE mbid IN (${batch.map(() => '?').join(',')})`,
                    ...batch,
                );
                for (const row of rows) out.set(row.mbid, row.listens);
            }
            return out;
        },
        run() {
            running ??= harvest()
                .then((r) => {
                    lastRun = { finishedAt: now(), albums: r.albums, artists: r.artists, unsure: r.unsure, stopped: r.stopped };
                    return r;
                })
                .finally(() => {
                    current = null;
                    running = null;
                });
            return running;
        },
        status() {
            const count = (sql: string) => db.get<{ n: number }>(sql)?.n ?? 0;
            return {
                phase: current?.phase ?? null,
                progress: current?.progress ?? null,
                total: current?.total ?? null,
                startedAt: current?.startedAt ?? null,
                lastRun,
                coverage: {
                    artists: count('SELECT COUNT(*) AS n FROM artist_info'),
                    libraryArtists: library?.artists ?? null,
                    bios: count('SELECT COUNT(*) AS n FROM artist_info WHERE bio IS NOT NULL'),
                    similar: count("SELECT COUNT(*) AS n FROM artist_info WHERE similar IS NOT NULL AND similar != '[]'"),
                    listens: count('SELECT COUNT(DISTINCT artist_mbid) AS n FROM recording_listens'),
                    albums: count('SELECT COUNT(*) AS n FROM album_info'),
                    libraryAlbums: library?.albums ?? null,
                    abouts: count('SELECT COUNT(*) AS n FROM album_info WHERE about IS NOT NULL'),
                },
                hasToken: token !== null,
            };
        },
    };
}

function isTimeout(err: unknown): boolean {
    return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** How long a 429 or 503 asks us to wait, within reason. */
function backoffOf(res: Response): number {
    const seconds = Number(res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset-in') ?? 5);
    return Math.min(MAX_BACKOFF_MS, Math.max(1_000, (Number.isFinite(seconds) ? seconds : 5) * 1_000));
}
