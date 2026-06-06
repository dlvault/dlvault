import axios, { AxiosInstance } from 'axios';
import { getSetting } from '../database/index';
import {
  addMovie, getMovieByTmdbId, getMovieByImdbId, getMovieByTvdbId, getAllMovies, deleteMovie,
  setSeasonsExplicit, setMovieTvdbId, setMovieTmdbId,
} from '../database/services/movies';
import { getSeasonsByShowId, addSeason, updateSeasonEpisodeCount } from '../database/services/seasons';
import { addLogEntry } from '../database/services/activityLog';
import { getLibraryProvider, getLibraryProviderName } from './libraryProvider';
import { processingMovies } from './processingState';
import { sendTelegramNotification } from './telegram';
import { logger } from '../utils/logger';

/**
 * Seerr / Overseerr as a watchlist provider.
 *
 * Unlike Trakt and Plex this is not a *watchlist* but a *request queue*, and the
 * difference drives most of the design here:
 *
 *  - Requests are append-only. Nothing silently vanishes, so there is no
 *    "remove everything missing from the remote list" pass — the failure mode
 *    that forced the empty-list guard in the Plex sync cannot occur.
 *  - A request carries no title, year or IMDb id — only `tmdbId`/`tvdbId`.
 *    Metadata is resolved through Seerr's own TMDb proxy, so this provider
 *    needs no TMDb key of its own.
 *  - Season structure ships with the request *and* the metadata endpoint, which
 *    makes this the only provider that can seed a show without Trakt.
 *
 * Auth handling mirrors the Trakt hardening: a credential error latches the
 * integration off instead of re-issuing a doomed request every two minutes.
 */

/** Seerr `MediaRequestStatus`. */
const REQUEST_PENDING = 1;
const REQUEST_APPROVED = 2;
const REQUEST_DECLINED = 3;

/** Seerr `MediaStatus`. */
export const MEDIA_UNKNOWN = 1;
export const MEDIA_PENDING = 2;
export const MEDIA_PROCESSING = 3;
export const MEDIA_PARTIALLY_AVAILABLE = 4;
export const MEDIA_AVAILABLE = 5;

interface SeerrMedia {
  id: number;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  tvdbId: number | null;
  imdbId: string | null;
  status: number;
}

export interface SeerrRequest {
  id: number;
  status: number;
  type: 'movie' | 'tv';
  is4k: boolean;
  media: SeerrMedia;
  seasons: { seasonNumber: number }[];
  requestedBy?: { displayName?: string };
}

/** Shared with traktService/plexService; `posterPath` is Seerr-only and optional. */
export interface CatalogItem {
  type: 'movie' | 'show';
  title: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: number | null;
  posterPath?: string | null;
}

/** A viewer-reported problem. Shape captured from a live Seerr 3.4.1. */
export interface SeerrIssue {
  id: number;
  issueType: number;
  status: number;
  problemSeason: number;
  problemEpisode: number;
  media: { id: number; tmdbId: number; mediaType: 'movie' | 'tv' };
  comments?: { message?: string }[];
  createdBy?: { displayName?: string };
}

interface TitleMeta {
  title: string;
  year: number;
  /** Raw release/first-air date, so callers can tell "unreleased" from "missing". */
  releaseDate: string;
  imdbId: string | null;
  /** Seasons that actually have episodes; specials (season 0) are excluded. */
  seasons: { seasonNumber: number; episodeCount: number }[];
}

/** Page size for the request feed — Seerr caps `take` well above this. */
const PAGE_SIZE = 50;
/** Stop paging defensively; a request feed this long means something is wrong. */
const MAX_PAGES = 40;
/** How long a latched auth failure waits before probing again. */
const AUTH_RETRY_MS = 60 * 60 * 1000;

export class SeerrService {
  private client: AxiosInstance | null = null;
  private clientKey = '';
  private authFailure: { since: number; status: number; detail: string; key: string } | null = null;
  private metaCache = new Map<string, TitleMeta>();

  private getUrl(): string {
    return (getSetting('seerr.url') || '').trim().replace(/\/+$/, '');
  }

  private getApiKey(): string {
    return (getSetting('seerr.api_key') || '').trim();
  }

  isConfigured(): boolean {
    return !!this.getUrl() && !!this.getApiKey();
  }

  /**
   * Single gate in front of every network call. A provider the user never set
   * up must be completely inert — no requests, no log noise, no alerts about an
   * integration they do not use.
   */
  private usable(): boolean {
    return this.isConfigured() && !this.authBlocked();
  }

  private authBlocked(): boolean {
    if (!this.authFailure) return false;
    // A new API key is a new chance — lift the block immediately rather than
    // making the user wait out the probe interval after fixing the credential.
    if (this.getApiKey() !== this.authFailure.key) {
      this.clearAuthFailure();
      return false;
    }
    if (Date.now() - this.authFailure.since >= AUTH_RETRY_MS) {
      this.authFailure.since = Date.now();
      return false;
    }
    return true;
  }

  private noteAuthFailure(status: number, detail: string): void {
    if (this.authFailure) return;
    this.authFailure = { since: Date.now(), status, detail, key: this.getApiKey() };
    const msg = `Seerr rejected the API key (HTTP ${status}) — sync paused until it is fixed`;
    logger.error(msg);
    addLogEntry(null, 'seerr_auth_failed', msg);
    sendTelegramNotification(
      'error',
      'Seerr-Verbindung unterbrochen',
      0,
      `Seerr lehnt den API-Key ab (HTTP ${status}). Neue Anfragen werden bis zur Korrektur nicht mehr übernommen.`,
    ).catch(() => { /* notification is best-effort */ });
  }

  private clearAuthFailure(): void {
    if (!this.authFailure) return;
    const downMinutes = Math.round((Date.now() - this.authFailure.since) / 60000);
    this.authFailure = null;
    logger.info(`Seerr authentication recovered after ${downMinutes} min`);
    addLogEntry(null, 'seerr_auth_recovered', 'Seerr reachable again');
  }

  getAuthFailure(): { since: number; status: number; detail: string } | null {
    if (!this.authFailure) return null;
    const { since, status, detail } = this.authFailure;
    return { since, status, detail };
  }

  /** @returns true when the error was a credential problem and has been latched. */
  private recordIfAuthError(error: any): boolean {
    const status = error?.response?.status;
    if (status === 401 || status === 403) {
      const body = error.response?.data;
      this.noteAuthFailure(status, typeof body === 'string' ? body : JSON.stringify(body ?? ''));
      return true;
    }
    return false;
  }

  private getClient(): AxiosInstance {
    const key = `${this.getUrl()}|${this.getApiKey()}`;
    if (!this.client || this.clientKey !== key) {
      this.client = axios.create({
        baseURL: `${this.getUrl()}/api/v1`,
        timeout: 15000,
        headers: { 'X-Api-Key': this.getApiKey(), 'Content-Type': 'application/json' },
      });
      this.clientKey = key;
    }
    return this.client;
  }

  /** Verifies URL + key without changing any state. Used by the settings UI. */
  async testConnection(): Promise<{ ok: boolean; version?: string; error?: string }> {
    if (!this.isConfigured()) return { ok: false, error: 'URL oder API-Key fehlt' };
    try {
      const res = await this.getClient().get('/settings/about');
      this.clearAuthFailure();
      return { ok: true, version: res.data?.version };
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 401 || status === 403) return { ok: false, error: 'API-Key wurde abgelehnt' };
      return { ok: false, error: error?.message || 'nicht erreichbar' };
    }
  }

  /**
   * Every request Seerr knows about, oldest first.
   *
   * Declined requests are fetched too — they are what tells us to drop a title
   * again that has not started downloading yet.
   */
  async getRequests(): Promise<SeerrRequest[] | null> {
    if (!this.usable()) return null;
    const all: SeerrRequest[] = [];
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await this.getClient().get('/request', {
          params: { take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE, filter: 'all', sort: 'added' },
        });
        const results: SeerrRequest[] = res.data?.results || [];
        all.push(...results);
        const pages = res.data?.pageInfo?.pages ?? 1;
        if (page >= pages || results.length === 0) break;
        if (page === MAX_PAGES) {
          logger.warn(`Seerr: stopped paging at ${MAX_PAGES} pages (${all.length} requests) — feed longer than expected`);
        }
      }
      this.clearAuthFailure();
      return all;
    } catch (error: any) {
      if (this.recordIfAuthError(error)) return null;
      logger.error(`Seerr: failed to fetch requests: ${error?.message || error}`);
      return null;
    }
  }

  /**
   * Title, year, IMDb id and season structure for a TMDb id.
   *
   * Seerr proxies TMDb, so this is the one call that turns a bare id into
   * something dlvault can search for. Cached per sync run — a request feed
   * commonly repeats the same title across pending/approved entries.
   */
  async getMeta(type: 'movie' | 'tv', tmdbId: number): Promise<TitleMeta | null> {
    if (!this.usable()) return null;
    const cacheKey = `${type}:${tmdbId}`;
    const cached = this.metaCache.get(cacheKey);
    if (cached) return cached;
    try {
      const res = await this.getClient().get(`/${type}/${tmdbId}`);
      const d = res.data || {};
      const title = type === 'movie' ? d.title : d.name;
      const date: string = (type === 'movie' ? d.releaseDate : d.firstAirDate) || '';
      if (!title) return null;
      const meta: TitleMeta = {
        title,
        year: Number(date.slice(0, 4)) || 0,
        releaseDate: date,
        imdbId: d.imdbId || d.externalIds?.imdbId || null,
        seasons: (d.seasons || [])
          // Season 0 is the specials bucket. TMDb parks every extra in it, so it
          // is both huge and not what anyone requesting "season 1" wants.
          .filter((s: any) => s.seasonNumber > 0 && (s.episodeCount || 0) > 0)
          .map((s: any) => ({ seasonNumber: s.seasonNumber, episodeCount: s.episodeCount })),
      };
      this.metaCache.set(cacheKey, meta);
      return meta;
    } catch (error: any) {
      if (this.recordIfAuthError(error)) return null;
      logger.warn(`Seerr: no metadata for ${type} ${tmdbId}: ${error?.message || error}`);
      return null;
    }
  }

  /** Pushes a media status back so Seerr's UI reflects what dlvault is doing. */
  async setMediaStatus(mediaId: number, status: number, is4k = false): Promise<boolean> {
    if (!this.usable()) return false;
    const path = ({
      [MEDIA_AVAILABLE]: 'available',
      [MEDIA_PARTIALLY_AVAILABLE]: 'partial',
      [MEDIA_PROCESSING]: 'processing',
      [MEDIA_PENDING]: 'pending',
      [MEDIA_UNKNOWN]: 'unknown',
    } as Record<number, string>)[status];
    if (!path) return false;
    try {
      await this.getClient().post(`/media/${mediaId}/${path}`, { is4k });
      return true;
    } catch (error: any) {
      if (this.recordIfAuthError(error)) return false;
      logger.debug(`Seerr: could not set media ${mediaId} to ${path}: ${error?.message || error}`);
      return false;
    }
  }

  /**
   * Pulls approved requests into dlvault.
   *
   * @returns how many new titles were added.
   */
  async syncWatchlist(): Promise<number> {
    const requests = await this.getRequests();
    if (requests === null) return 0;

    this.metaCache.clear();
    const minQuality = getSetting('quality.minimum') || '1080p';
    const libraryProvider = getLibraryProvider();
    let newCount = 0;

    for (const req of requests) {
      if (req.status !== REQUEST_APPROVED) continue;
      const tmdbId = req.media?.tmdbId;
      if (!tmdbId) continue;

      const mediaType = req.type === 'tv' ? 'show' : 'movie';
      const meta = await this.getMeta(req.type, tmdbId);
      if (!meta) continue;

      // 4K requests are tracked as a separate quality target; everything else
      // follows the configured floor.
      const quality = req.is4k ? '2160p' : minQuality;

      // A show may already exist because the Radarr/Sonarr endpoint added it
      // first — and that path stores only the tvdbId, because the Sonarr payload
      // carries nothing else. Looking it up by tmdbId alone therefore missed it
      // and created a SECOND row for the same series, one of them without the
      // season limit. Check every id both paths can write.
      const existing = getMovieByTmdbId(tmdbId, mediaType)
        || (mediaType === 'show' && req.media?.tvdbId ? getMovieByTvdbId(req.media.tvdbId) : undefined)
        || (meta.imdbId ? getMovieByImdbId(meta.imdbId) : null);

      if (existing) {
        // Fill in whichever id the other path could not supply, so the next
        // lookup finds it from either direction.
        //
        // The tmdbId matters as much as the tvdbId: the Sonarr endpoint stores
        // null for it (Seerr's payload has none), and pushStatuses looks a title
        // up by tmdbId — so a show that arrived purely through the push would
        // never have its progress reported back, ever.
        if (mediaType === 'show' && req.media?.tvdbId && !existing.tvdb_id) {
          setMovieTvdbId(existing.id, req.media.tvdbId);
        }
        if (existing.tmdb_id == null) setMovieTmdbId(existing.id, tmdbId);
        // A follow-up request for further seasons of a show we already track
        // must widen the season set rather than be ignored.
        if (mediaType === 'show') this.seedSeasons(existing.id, req, meta, quality);
        continue;
      }

      if (mediaType === 'movie' && libraryProvider.isConfigured()) {
        const inLibrary = await libraryProvider.hasMovie(meta.imdbId, tmdbId, meta.title, meta.year);
        if (inLibrary === null) {
          // Library state unknown (provider down, cold cache) — defer instead of
          // queueing a download for something that may already be on disk.
          logger.debug(`Seerr: deferring "${meta.title}" — library membership unknown`);
          continue;
        }
        if (inLibrary) {
          addMovie({
            trakt_id: 0, imdb_id: meta.imdbId || '', tmdb_id: tmdbId,
            title: meta.title, year: meta.year,
            slug: meta.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            media_type: 'movie', status: 'downloaded', desired_quality: quality,
            watchlist_source: 'seerr',
          });
          addLogEntry(null, 'already_in_library', `${meta.title} (${meta.year}) already in ${getLibraryProviderName()} — skipped`);
          logger.info(`Seerr: ${meta.title} (${meta.year}) already in library — marked available`);
          // Tell Seerr right away; otherwise the request sits at
          // "processing" forever for something that is already watchable.
          await this.setMediaStatus(req.media.id, MEDIA_AVAILABLE, req.is4k);
          continue;
        }
      }

      const added = addMovie({
        trakt_id: 0, imdb_id: meta.imdbId || '', tmdb_id: tmdbId,
        // Carry it from the start so the Sonarr endpoint recognises the same
        // series instead of adding its own copy.
        tvdb_id: mediaType === 'show' ? (req.media?.tvdbId ?? null) : null,
        title: meta.title, year: meta.year,
        slug: meta.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        media_type: mediaType, status: 'pending', desired_quality: quality,
        watchlist_source: 'seerr',
      });
      if (mediaType === 'show') this.seedSeasons(added.id, req, meta, quality);

      const who = req.requestedBy?.displayName;
      addLogEntry(null, `${mediaType}_added`,
        `New ${mediaType} from Seerr: ${meta.title} (${meta.year})${who ? ` — requested by ${who}` : ''}`);
      logger.info(`New ${mediaType} from Seerr: ${meta.title} (${meta.year})`);
      newCount++;
    }

    await this.dropDeclined(requests);
    // Reuse the feed we already hold instead of fetching it a second time —
    // pull and push always see exactly the same snapshot this way.
    await this.pushStatuses(requests);
    return newCount;
  }

  /**
   * Creates exactly the seasons that were requested — Seerr is season-
   * granular, so requesting season 2 must not drag in the whole show.
   */
  private seedSeasons(movieId: number, req: SeerrRequest, meta: TitleMeta, quality: string): void {
    const wanted = (req.seasons || []).map(s => s.seasonNumber).filter(n => n > 0);
    // An empty season list on a TV request means "all seasons".
    const numbers = wanted.length > 0 ? wanted : meta.seasons.map(s => s.seasonNumber);
    // Named seasons are a closed set — the pipeline must not widen them to the
    // whole run when it finds further seasons at the source.
    //
    // Only ever tightened, never loosened: this runs for every tracked show on
    // every two-minute pass, so writing `false` here would let a second request
    // for the same series with an open season list silently lift the limit set
    // by the first — and with two such requests the outcome would depend on
    // which one the loop reached last. A brand-new show defaults to open
    // anyway, so "all seasons" needs no write at all.
    if (wanted.length > 0) setSeasonsExplicit(movieId, true);
    const existing = new Set(getSeasonsByShowId(movieId).map(s => s.season_number));

    for (const n of numbers) {
      if (existing.has(n)) continue;
      const season = addSeason(movieId, n, quality);
      const episodeCount = meta.seasons.find(s => s.seasonNumber === n)?.episodeCount;
      if (episodeCount) updateSeasonEpisodeCount(season.id, episodeCount);
    }
  }

  /**
   * Removes titles whose request was declined or deleted.
   *
   * Deliberately narrow: only rows this provider owns, only while they have not
   * started downloading, and never while processMovie() holds them — deleting a
   * row mid-flight makes its own status writes fail a FOREIGN KEY constraint.
   */
  private async dropDeclined(requests: SeerrRequest[]): Promise<void> {
    const provider = getSetting('watchlist.provider') || 'trakt';
    if (provider !== 'seerr') return;

    // Only an explicit decline means "no longer wanted". Everything else stays:
    // a FAILED request just means the fulfilment server refused it once — which
    // was, in the case that exposed this, dlvault's own duplicate response. The
    // request is still there and the requester still wants the title, so
    // deleting it here silently threw away work the user had asked for.
    const live = new Set<number>();
    for (const r of requests) {
      if (r.status === REQUEST_DECLINED) continue;
      if (r.media?.tmdbId) live.add(r.media.tmdbId);
    }

    for (const movie of getAllMovies()) {
      if (movie.watchlist_source !== 'seerr') continue;
      if (processingMovies.has(movie.id)) continue;
      if (movie.tmdb_id == null || live.has(movie.tmdb_id)) continue;
      // Anything already downloading or on disk stays — a declined request is
      // not a reason to throw away work that is done or nearly done.
      if (['downloading', 'downloaded'].includes(movie.status)) continue;
      deleteMovie(movie.id);
      addLogEntry(null, 'movie_removed', `Request withdrawn in Seerr: ${movie.title} (${movie.year})`);
      logger.info(`Removed (request withdrawn in Seerr): ${movie.title} (${movie.year})`);
    }
  }

  /**
   * Mirrors dlvault's progress back into Seerr.
   *
   * Runs as a reconcile pass rather than on every status transition: one pass
   * cannot drift out of sync the way a scattered set of hooks would, and a
   * missed push heals on the next cycle.
   */
  async pushStatusUpdates(): Promise<number> {
    const requests = await this.getRequests();
    if (requests === null) return 0;
    return this.pushStatuses(requests);
  }

  private async pushStatuses(requests: SeerrRequest[]): Promise<number> {
    let pushed = 0;
    let completed = false;
    for (const req of requests) {
      if (req.status !== REQUEST_APPROVED) continue;
      const tmdbId = req.media?.tmdbId;
      if (!tmdbId) continue;

      const mediaType = req.type === 'tv' ? 'show' : 'movie';
      // Same identity chain as the pull pass: a show may carry only the tvdbId.
      const movie = getMovieByTmdbId(tmdbId, mediaType)
        || (mediaType === 'show' && req.media?.tvdbId ? getMovieByTvdbId(req.media.tvdbId) : undefined);
      // Report on anything Seerr asked about, whoever put it in the database.
      // Requiring dlvault to *own* the row left titles it already tracked from
      // another source stuck at "processing" in Seerr forever — the request was
      // accepted, so its progress is owed regardless of provenance.
      //
      // Ownership still governs DELETION (see dropDeclined): reporting on a
      // Trakt-owned row is right, deleting one because a Seerr request was
      // declined is not.
      if (!movie) continue;

      const desired = mediaType === 'show'
        ? this.showStatus(movie.id, req)
        : this.movieStatus(movie.status);

      if (desired === null || desired === req.media.status) continue;
      if (await this.setMediaStatus(req.media.id, desired, req.is4k)) {
        pushed++;
        // A title that just became available is exactly the case that leaves a
        // stale progress bar behind.
        if (desired === MEDIA_AVAILABLE) completed = true;
      }
    }
    if (completed) await this.resetDownloadTracker();
    return pushed;
  }

  // ── Katalog: Suche + Discover ─────────────────────────────────────────────
  // Same shape as traktService/plexService so the unified search route can use
  // whichever provider is configured. Seerr proxies TMDb, which means this works
  // with no key of its own and returns titles in the user's configured language
  // — the German titles matter, because that is what the sources index.

  /**
   * Maps a Seerr/TMDb search or discover row onto the shared catalog shape.
   *
   * `imdbId` is deliberately left null: the search endpoint does not carry it,
   * and resolving one per row would mean an extra request per result. Posters
   * ride on `posterPath` instead, which every row does carry.
   */
  private toCatalogItem(r: any, want: ('movie' | 'show')[]): CatalogItem | null {
    const type: 'movie' | 'show' | null =
      r?.mediaType === 'movie' ? 'movie' : r?.mediaType === 'tv' ? 'show' : null;
    if (!type || !want.includes(type)) return null;
    const title = type === 'movie' ? r.title : r.name;
    if (!title) return null;
    const date: string = (type === 'movie' ? r.releaseDate : r.firstAirDate) || '';
    return {
      type,
      title,
      year: Number(date.slice(0, 4)) || null,
      imdbId: null,
      tmdbId: typeof r.id === 'number' ? r.id : null,
      posterPath: typeof r.posterPath === 'string' ? r.posterPath : null,
    };
  }

  async searchCatalog(
    query: string,
    opts: { types: ('movie' | 'show')[]; limit?: number },
  ): Promise<CatalogItem[]> {
    if (!this.usable() || opts.types.length === 0 || !query.trim()) return [];
    try {
      // Seerr refuses a '+' for a space ("Parameter 'query' must be url
      // encoded"), and axios's default serializer produces exactly that. Encode
      // into the path instead of handing axios a params object.
      const res = await this.getClient().get(
        `/search?query=${encodeURIComponent(query.trim())}&page=1`,
      );
      const out: CatalogItem[] = [];
      for (const r of res.data?.results || []) {
        const item = this.toCatalogItem(r, opts.types);
        if (item) out.push(item);
        if (out.length >= (opts.limit ?? 30)) break;
      }
      this.clearAuthFailure();
      return out;
    } catch (error: any) {
      if (this.recordIfAuthError(error)) return [];
      logger.warn(`Seerr search failed for "${query}": ${error?.message || error}`);
      return [];
    }
  }

  /**
   * Trending across both types.
   *
   * `/discover/trending` mixes movies, shows AND people in one list, so the
   * person rows have to be dropped — toCatalogItem does that by returning null
   * for anything without a usable mediaType.
   */
  async getTrending(opts: { types: ('movie' | 'show')[]; limit?: number }): Promise<CatalogItem[]> {
    if (!this.usable() || opts.types.length === 0) return [];
    try {
      const res = await this.getClient().get('/discover/trending', { params: { page: 1 } });
      const out: CatalogItem[] = [];
      for (const r of res.data?.results || []) {
        const item = this.toCatalogItem(r, opts.types);
        if (item) out.push(item);
        if (out.length >= (opts.limit ?? 20)) break;
      }
      this.clearAuthFailure();
      return out;
    } catch (error: any) {
      if (this.recordIfAuthError(error)) return [];
      logger.warn(`Seerr trending failed: ${error?.message || error}`);
      return [];
    }
  }

  /**
   * Registers dlvault in Seerr as its Radarr and Sonarr server.
   *
   * Doing it from this side means the user never types a URL, port, API key,
   * quality profile or root folder — the four things most likely to be entered
   * wrong. Existing dlvault entries are replaced rather than duplicated, so
   * running this twice is safe.
   *
   * @param baseUrl how Seerr can reach dlvault, e.g. http://192.168.x.x:3000
   */
  async registerAsArrServer(baseUrl: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
    /** Default profile follows the configured floor, not a hardcoded 1080p. */
    const defaultProfile = () => {
      const q = getSetting('quality.minimum') || '1080p';
      const byQuality: Record<string, { id: number; name: string }> = {
        '2160p': { id: 4, name: '2160p (4K)' },
        '1080p': { id: 3, name: '1080p' },
        '720p': { id: 2, name: '720p' },
        '480p': { id: 1, name: '480p' },
      };
      const p = byQuality[q] || byQuality['1080p'];
      return { activeProfileId: p.id, activeProfileName: p.name };
    };

    if (!this.usable()) return { ok: false, error: 'Seerr nicht verbunden' };

    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return { ok: false, error: 'Ungültige dlvault-URL' };
    }
    const useSsl = url.protocol === 'https:';
    const port = Number(url.port) || (useSsl ? 443 : 80);

    for (const flavour of ['radarr', 'sonarr'] as const) {
      const isTv = flavour === 'sonarr';
      const body: Record<string, unknown> = {
        name: `dlvault (${isTv ? 'Serien' : 'Filme'})`,
        hostname: url.hostname,
        port,
        apiKey,
        useSsl,
        baseUrl: `/${flavour}`,
        ...defaultProfile(),
        activeDirectory: getSetting(isTv ? 'paths.series' : 'paths.movies') || (isTv ? '/series' : '/movies'),
        is4k: false,
        isDefault: true,
        externalUrl: '',
        // MUST be true. It reads like "let Seerr scan this server's library",
        // and it does that — but it ALSO gates Seerr's download tracker: with it
        // off, Seerr never issues a single request to the server and no progress
        // is ever shown, while the media status underneath stays correct. That
        // combination is very hard to read from the outside, and it cost hours.
        // What it additionally enables is harmless here: the daily radarr-scan
        // reads dlvault's own /movie list, which reports hasFile from the same
        // status the direct push uses, so the two cannot disagree.
        syncEnabled: true,
        preventSearch: false,
        tagRequests: false,
        ...(isTv
          ? { activeLanguageProfileId: 1, activeAnimeProfileId: null, enableSeasonFolders: true }
          : { minimumAvailability: 'released' }),
      };

      try {
        const existing = await this.getClient().get(`/settings/${flavour}`);
        for (const srv of existing.data || []) {
          if (typeof srv?.name === 'string' && srv.name.startsWith('dlvault')) {
            await this.getClient().delete(`/settings/${flavour}/${srv.id}`);
          }
        }
        await this.getClient().post(`/settings/${flavour}`, body);
        logger.info(`Registered dlvault in Seerr as ${flavour}`);
      } catch (error: any) {
        if (this.recordIfAuthError(error)) return { ok: false, error: 'API-Key wurde abgelehnt' };
        const detail = error?.response?.data?.message || error?.message || 'unbekannt';
        logger.error(`Could not register dlvault as ${flavour}: ${detail}`);
        return { ok: false, error: `${flavour}: ${detail}` };
      }
    }
    addLogEntry(null, 'seerr_registered', 'dlvault in Seerr als Radarr/Sonarr eingetragen');
    return { ok: true };
  }

  /**
   * Points Seerr's webhook agent at dlvault so an approval arrives immediately
   * instead of on the next two-minute poll.
   *
   * The payload template is defined here rather than left at Seerr's default:
   * the default nests media/request under `{{media}}`/`{{request}}` keys that
   * expand to empty strings for irrelevant events, producing JSON dlvault would
   * have to defend against. A flat, fixed shape is simpler and stable.
   *
   * Shapes verified against Seerr 3.4.1 — both are easy to get wrong:
   *   - `customHeaders` must be an ARRAY of {key, value}; a JSON-string object
   *     makes Seerr throw "customHeaders.forEach is not a function", and an
   *     array of [key, value] pairs is accepted but silently drops the header
   *   - `jsonPayload` goes in as a plain string and comes back base64-encoded
   */
  async registerWebhook(baseUrl: string, token: string, types: number): Promise<{ ok: boolean; error?: string }> {
    if (!this.usable()) return { ok: false, error: 'Seerr nicht verbunden' };

    const payload = {
      notification_type: '{{notification_type}}',
      subject: '{{subject}}',
      media_type: '{{media_type}}',
      tmdbId: '{{media_tmdbid}}',
      tvdbId: '{{media_tvdbid}}',
      request_id: '{{request_id}}',
      requestedBy: '{{requestedBy_username}}',
    };
    const body = {
      enabled: true,
      types,
      options: {
        webhookUrl: `${baseUrl.replace(/\/+$/, '')}/seerr/webhook`,
        jsonPayload: JSON.stringify(payload, null, 2),
        customHeaders: [{ key: 'X-Dlvault-Token', value: token }],
      },
    };

    try {
      await this.getClient().post('/settings/notifications/webhook', body);
      logger.info('Registered dlvault as Seerr webhook target');
      addLogEntry(null, 'seerr_webhook_registered', 'Seerr meldet Freigaben jetzt sofort an dlvault');
      return { ok: true };
    } catch (error: any) {
      if (this.recordIfAuthError(error)) return { ok: false, error: 'API-Key wurde abgelehnt' };
      const detail = error?.response?.data?.message || error?.message || 'unbekannt';
      logger.error(`Could not register the Seerr webhook: ${detail}`);
      return { ok: false, error: detail };
    }
  }

  // ── Meldungen (Issues) ────────────────────────────────────────────────────

  /** Every issue Seerr knows about, newest first. */
  async getIssues(): Promise<SeerrIssue[] | null> {
    if (!this.usable()) return null;
    try {
      const res = await this.getClient().get('/issue', { params: { take: 100, filter: 'all' } });
      this.clearAuthFailure();
      return res.data?.results || [];
    } catch (error: any) {
      if (this.recordIfAuthError(error)) return null;
      logger.error(`Seerr: failed to fetch issues: ${error?.message || error}`);
      return null;
    }
  }

  /**
   * Comments on an issue.
   *
   * dlvault uses its own comments as the record of what it has already done, so
   * a failure here matters more than it looks: without the comment the next
   * sweep would act on the same report a second time.
   */
  async commentOnIssue(issueId: number, message: string): Promise<boolean> {
    if (!this.usable()) return false;
    try {
      await this.getClient().post(`/issue/${issueId}/comment`, { message });
      return true;
    } catch (error: any) {
      if (this.recordIfAuthError(error)) return false;
      logger.warn(`Seerr: could not comment on issue #${issueId}: ${error?.message || error}`);
      return false;
    }
  }

  /** Opens an issue from dlvault's side — used to report that it gave up. */
  async createIssue(mediaId: number, issueType: number, message: string): Promise<boolean> {
    if (!this.usable()) return false;
    try {
      await this.getClient().post('/issue', { issueType, message, mediaId });
      return true;
    } catch (error: any) {
      if (this.recordIfAuthError(error)) return false;
      logger.warn(`Seerr: could not open an issue for media ${mediaId}: ${error?.message || error}`);
      return false;
    }
  }

  async setIssueStatus(issueId: number, status: 'resolved' | 'open'): Promise<boolean> {
    if (!this.usable()) return false;
    try {
      await this.getClient().post(`/issue/${issueId}/${status}`);
      return true;
    } catch (error: any) {
      if (this.recordIfAuthError(error)) return false;
      logger.warn(`Seerr: could not set issue #${issueId} to ${status}: ${error?.message || error}`);
      return false;
    }
  }

  /**
   * Clears Seerr's cached download progress.
   *
   * Kept as a belt-and-braces clear once a title completes.
   *
   * Note on why this exists: it was originally added to explain stale progress
   * bars that survived for hours. That diagnosis was wrong — the entries were
   * frozen because `syncEnabled` was false and the tracker had stopped polling
   * altogether, not because its cache only grows. With the tracker running, a
   * finished title drops out of the queue and clears on its own.
   *
   * It stays because it is cheap and makes the clear immediate: the cost is that
   * other in-flight titles lose their bar for at most one poll interval.
   */
  async resetDownloadTracker(): Promise<boolean> {
    if (!this.usable()) return false;
    try {
      await this.getClient().post('/settings/jobs/download-sync-reset/run');
      logger.debug('Seerr: cleared the stale download-progress cache');
      return true;
    } catch (error: any) {
      if (this.recordIfAuthError(error)) return false;
      logger.debug(`Seerr: could not clear the download cache: ${error?.message || error}`);
      return false;
    }
  }

  private movieStatus(status: string): number | null {
    if (status === 'downloaded') return MEDIA_AVAILABLE;
    if (status === 'not_found') return MEDIA_PENDING;
    return MEDIA_PROCESSING;
  }

  /** A show is only "available" once every requested season is on disk. */
  private showStatus(movieId: number, req: SeerrRequest): number | null {
    const requested = new Set((req.seasons || []).map(s => s.seasonNumber).filter(n => n > 0));
    const seasons = getSeasonsByShowId(movieId)
      .filter(s => requested.size === 0 || requested.has(s.season_number));
    if (seasons.length === 0) return MEDIA_PROCESSING;

    const done = seasons.filter(s => s.status === 'downloaded').length;
    if (done === seasons.length) return MEDIA_AVAILABLE;
    if (done > 0) return MEDIA_PARTIALLY_AVAILABLE;
    return MEDIA_PROCESSING;
  }
}

export const seerrService = new SeerrService();
