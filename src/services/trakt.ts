import axios, { AxiosInstance } from 'axios';
import { getSetting, setSetting } from '../database/index';
import { addMovie, getMovieByTraktId, getMovieByImdbId, getMovieByTmdbId, updateMovieTraktId, getAllMovies, deleteMovie, getMovieById } from '../database/services/movies';
import { processingMovies } from './processingState';
import { addLogEntry } from '../database/services/activityLog';
import { getSeasonsByShowId, addSeason, updateSeasonEpisodeCount } from '../database/services/seasons';
import { addEpisodes } from '../database/services/episodes';
import { getLibraryProvider, getLibraryProviderName } from './libraryProvider';
import { requestTitle } from './requests';
import { sendTelegramNotification } from './telegram';
import { logger } from '../utils/logger';

const TRAKT_API_URL = 'https://api.trakt.tv';

interface TraktMovie {
  movie: {
    title: string;
    year: number;
    ids: {
      trakt: number;
      slug: string;
      imdb: string;
      tmdb: number;
    };
  };
  listed_at: string;
}

interface TraktShow {
  show: {
    title: string;
    year: number;
    ids: {
      trakt: number;
      slug: string;
      imdb: string;
      tmdb: number;
    };
  };
  listed_at: string;
}

export class TraktService {
  private client: AxiosInstance;
  private refreshPromise: Promise<boolean> | null = null;
  // Last successful watchlist id-count, to detect a suspicious one-cycle collapse
  // (a truncated fetch) and skip deletion that cycle. See syncWatchlist.
  private lastWatchlistIdCount = 0;

  constructor() {
    this.client = axios.create({
      baseURL: TRAKT_API_URL,
      // Bound every Trakt call. Without this, axios waits forever on a half-open
      // socket, which freezes the whole sync cycle (isRunning stays true and blocks
      // all future syncs). On timeout the call rejects → callers return null, which
      // is already treated as "API error" (watchlist deletion is skipped), so a
      // timeout degrades safely instead of hanging.
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'User-Agent': 'Dlvault/1.0',
      },
    });
  }

  /**
   * A *persistent* authentication failure — the credentials themselves are
   * rejected, so retrying with the same ones cannot help.
   *
   * This exists because a 403 has no recovery path. `401` means "token expired"
   * and triggers a refresh; `403` means Trakt does not accept this client_id at
   * all — the OAuth application was deleted or revoked. The old code treated it
   * as an ordinary error, so the 2-minute watchlist monitor kept hammering a
   * dead endpoint: an outage ran for two and a half days and 3000+ log lines
   * before anyone noticed, because nothing above the log ever heard about it.
   *
   * `token` records which credentials failed, so reconnecting (which writes a
   * new token) clears the state automatically.
   */
  private authFailure: { since: number; status: number; detail: string; token: string } | null = null;
  private lastAuthProbeAt = 0;

  /** How long to wait before testing broken credentials again. */
  private static readonly AUTH_RETRY_INTERVAL_MS = 60 * 60 * 1000;

  /**
   * True when we should skip the call outright. Credentials that were rejected
   * get one probe per hour instead of one per monitor tick — enough to notice a
   * fix on Trakt's side, little enough to stop pounding their API.
   */
  private authBlocked(): boolean {
    if (!this.authFailure) return false;
    // Reconnected? Different credentials deserve a fresh attempt.
    if (getSetting('trakt.access_token') !== this.authFailure.token) {
      this.clearAuthFailure();
      return false;
    }
    if (Date.now() - this.lastAuthProbeAt >= TraktService.AUTH_RETRY_INTERVAL_MS) {
      this.lastAuthProbeAt = Date.now();
      logger.info('Trakt: retrying after an authentication failure (hourly probe)');
      return false;
    }
    return true;
  }

  private noteAuthFailure(status: number, detail: string): void {
    if (this.authFailure) return; // already known — don't reset the clock
    this.authFailure = { since: Date.now(), status, detail, token: getSetting('trakt.access_token') };
    this.lastAuthProbeAt = Date.now();
    logger.error(
      `Trakt authentication is broken (HTTP ${status}). Every Trakt feature — watchlist sync, `
      + 'marking titles collected, and the movie/show search catalog — stays unavailable until this is fixed. '
      + 'A 403 usually means the OAuth application no longer exists on your Trakt account; reconnect under '
      + 'Settings → Watchlist. Further attempts are throttled to one per hour.',
    );
    addLogEntry(null, 'trakt_auth_failed', `Trakt lehnt die Zugangsdaten ab (HTTP ${status}) — bitte neu verbinden`);
    sendTelegramNotification(
      'error',
      'Trakt-Verbindung unterbrochen',
      0,
      `Trakt antwortet mit HTTP ${status}. Watchlist-Sync, "als gesehen markieren" und die Film-/Seriensuche sind bis zur Neuverbindung außer Betrieb.`,
    ).catch(() => { /* notification is best-effort */ });
  }

  private clearAuthFailure(): void {
    if (!this.authFailure) return;
    const downMinutes = Math.round((Date.now() - this.authFailure.since) / 60000);
    this.authFailure = null;
    logger.info(`Trakt authentication works again (was failing for ~${downMinutes} min)`);
    addLogEntry(null, 'trakt_auth_ok', 'Trakt-Verbindung wiederhergestellt');
  }

  /** Current auth state, for the health check and the settings UI. */
  getAuthFailure(): { since: number; status: number; detail: string } | null {
    if (!this.authFailure) return null;
    const { since, status, detail } = this.authFailure;
    return { since, status, detail };
  }

  /**
   * Classify an axios error and remember a persistent auth failure.
   * Returns true when the caller should give up rather than retry.
   */
  private recordIfAuthError(error: any): boolean {
    const status = error?.response?.status;
    // 403 = credentials rejected outright. 426 = Trakt's "VIP required" code.
    if (status === 403 || status === 426) {
      const body = error.response?.data;
      this.noteAuthFailure(status, typeof body === 'string' ? body : JSON.stringify(body ?? ''));
      return true;
    }
    return false;
  }

  /**
   * Is Trakt set up at all?
   *
   * Guard for every method that talks to the network. Without it an instance
   * that never configured Trakt still issued requests and logged failures —
   * a provider nobody connected must be completely inert, not a source of
   * recurring errors in someone else's log.
   */
  private usable(): boolean {
    return !!this.getClientId();
  }

  private getClientId(): string {
    return getSetting('trakt.client_id');
  }

  private getHeaders() {
    const token = getSetting('trakt.access_token');
    return {
      'trakt-api-key': this.getClientId(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  getAuthUrl(): string {
    const clientId = this.getClientId();
    const redirectUri = 'urn:ietf:wg:oauth:2.0:oob';
    return `${TRAKT_API_URL}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  async exchangeCode(code: string): Promise<boolean> {
    try {
      const response = await this.client.post('/oauth/token', {
        code,
        client_id: getSetting('trakt.client_id'),
        client_secret: getSetting('trakt.client_secret'),
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        grant_type: 'authorization_code',
      });

      setSetting('trakt.access_token', response.data.access_token);
      setSetting('trakt.refresh_token', response.data.refresh_token);

      // Automatically fetch and store username
      await this.fetchAndStoreUsername();

      logger.info('Trakt OAuth token obtained successfully');
      return true;
    } catch (error: any) {
      logger.error('Trakt OAuth exchange failed:', error.message);
      return false;
    }
  }

  async refreshToken(): Promise<boolean> {
    // Coalesce concurrent refresh attempts into one request
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefreshToken();
    try {
      const result = await this.refreshPromise;
      return result;
    } catch (err) {
      // Clear failed promise so next caller retries fresh
      logger.warn('Trakt token refresh failed, next API call will retry');
      throw err;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefreshToken(): Promise<boolean> {
    try {
      const response = await this.client.post('/oauth/token', {
        refresh_token: getSetting('trakt.refresh_token'),
        client_id: getSetting('trakt.client_id'),
        client_secret: getSetting('trakt.client_secret'),
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        grant_type: 'refresh_token',
      });

      setSetting('trakt.access_token', response.data.access_token);
      setSetting('trakt.refresh_token', response.data.refresh_token);
      logger.info('Trakt token refreshed');
      return true;
    } catch (error: any) {
      logger.error('Trakt token refresh failed:', error.message);
      return false;
    }
  }

  async getMovieWatchlist(retried = false): Promise<TraktMovie[] | null> {
    const username = getSetting('trakt.username');
    if (!username || !this.getClientId()) return null;
    // Credentials are known-bad — don't spend a request (and a log line) on it.
    if (this.authBlocked()) return null;

    try {
      // Trakt paginates the watchlist (100/page since 2026-04). Follow
      // X-Pagination-Page-Count so a watchlist larger than one page is fetched in
      // full — an unfetched page would make syncWatchlist delete tracked items as
      // "no longer on watchlist". An unpaginated response reports page-count 1 (or
      // omits the header), so this stays a single request; the page ceiling guards
      // against a malformed header.
      const all: TraktMovie[] = [];
      let page = 1;
      let pageCount = 1;
      do {
        const response = await this.client.get(
          `/users/${username}/watchlist/movies`,
          { headers: this.getHeaders(), params: { page, limit: 100 } }
        );
        if (Array.isArray(response.data)) all.push(...response.data);
        pageCount = parseInt(response.headers?.['x-pagination-page-count'] ?? '1', 10) || 1;
        page++;
      } while (page <= pageCount && page <= 50);
      this.clearAuthFailure();
      return all;
    } catch (error: any) {
      if (error.response?.status === 401 && !retried) {
        const refreshed = await this.refreshToken();
        if (refreshed) return this.getMovieWatchlist(true);
      }
      // A rejected credential is permanent until the user reconnects — record it
      // once and stop retrying, instead of logging the same error every 2 min.
      if (this.recordIfAuthError(error)) return null;
      const detail = error.response
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message || error.code || String(error);
      logger.error(`Failed to fetch Trakt movie watchlist: ${detail}`);
      return null; // null = API error (distinct from empty watchlist)
    }
  }

  async getShowWatchlist(retried = false): Promise<TraktShow[] | null> {
    const username = getSetting('trakt.username');
    if (!username || !this.getClientId()) return null;
    // Credentials are known-bad — don't spend a request (and a log line) on it.
    if (this.authBlocked()) return null;

    try {
      // See getMovieWatchlist — paginate in full so a multi-page show watchlist
      // isn't silently truncated (which would mass-delete tracked shows).
      const all: TraktShow[] = [];
      let page = 1;
      let pageCount = 1;
      do {
        const response = await this.client.get(
          `/users/${username}/watchlist/shows`,
          { headers: this.getHeaders(), params: { page, limit: 100 } }
        );
        if (Array.isArray(response.data)) all.push(...response.data);
        pageCount = parseInt(response.headers?.['x-pagination-page-count'] ?? '1', 10) || 1;
        page++;
      } while (page <= pageCount && page <= 50);
      this.clearAuthFailure();
      return all;
    } catch (error: any) {
      if (error.response?.status === 401 && !retried) {
        const refreshed = await this.refreshToken();
        if (refreshed) return this.getShowWatchlist(true);
      }
      if (this.recordIfAuthError(error)) return null;
      const detail = error.response
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message || error.code || String(error);
      logger.error(`Failed to fetch Trakt show watchlist: ${detail}`);
      return null; // null = API error (distinct from empty watchlist)
    }
  }

  /**
   * Fetch season metadata from Trakt for a show.
   * Returns aired seasons (excluding specials/season 0).
   */
  async getShowSeasons(traktId: number, retried = false): Promise<{ number: number; episode_count: number; aired_episodes: number }[]> {
    if (!this.usable()) return [];
    try {
      const response = await this.client.get(
        `/shows/${traktId}/seasons`,
        { headers: this.getHeaders(), params: { extended: 'full' } }
      );
      // Filter out specials (season 0) and unaired seasons
      return (response.data || [])
        .filter((s: any) => s.number > 0 && s.aired_episodes > 0)
        .map((s: any) => ({
          number: s.number,
          episode_count: s.episode_count || 0,
          aired_episodes: s.aired_episodes || 0,
        }));
    } catch (error: any) {
      if (error.response?.status === 401 && !retried) {
        const refreshed = await this.refreshToken();
        if (refreshed) return this.getShowSeasons(traktId, true);
      }
      logger.error(`Trakt: failed to fetch seasons for show ${traktId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Sync seasons and episodes for a show from Trakt metadata.
   * Auto-adds new seasons/episodes as pending. Does NOT remove existing ones.
   */
  async syncShowSeasons(movieId: number, traktId: number): Promise<void> {
    const traktSeasons = await this.getShowSeasons(traktId);
    if (traktSeasons.length === 0) return;

    const existingSeasons = getSeasonsByShowId(movieId);
    const existingNumbers = new Set(existingSeasons.map(s => s.season_number));
    const movie = getMovieById(movieId);
    const quality = movie?.desired_quality || getSetting('quality.minimum') || '1080p';
    // Honour the show's season cutoff: don't (re-)seed seasons below it, else
    // every sync would recreate the back-catalogue the user chose to skip.
    const cutoff = movie?.season_cutoff ?? null;

    let newSeasons = 0;
    for (const ts of traktSeasons) {
      if (cutoff != null && ts.number < cutoff) continue;
      if (!existingNumbers.has(ts.number)) {
        // New season from Trakt — add with pending status
        const season = addSeason(movieId, ts.number, quality);
        updateSeasonEpisodeCount(season.id, ts.episode_count, ts.aired_episodes);
        // Create episode rows for all aired episodes
        if (ts.aired_episodes > 0) {
          const episodeNumbers = Array.from({ length: ts.aired_episodes }, (_, i) => i + 1);
          addEpisodes(season.id, episodeNumbers);
        }
        newSeasons++;
      } else {
        // Existing season — update episode count if changed (new episodes aired)
        const existing = existingSeasons.find(s => s.season_number === ts.number)!;
        if (existing.aired_episodes !== ts.aired_episodes) {
          updateSeasonEpisodeCount(existing.id, ts.episode_count, ts.aired_episodes);
          // Add any new episode rows
          if (ts.aired_episodes > 0) {
            const episodeNumbers = Array.from({ length: ts.aired_episodes }, (_, i) => i + 1);
            addEpisodes(existing.id, episodeNumbers); // INSERT OR IGNORE — won't duplicate
          }
        }
      }
    }

    if (newSeasons > 0) {
      addLogEntry(movieId, 'seasons_synced', `Trakt: ${newSeasons} new season(s) detected`);
      logger.info(`Trakt: synced ${newSeasons} new season(s) for show ID ${movieId}`);
    }
  }

  /**
   * Resolve a Trakt show id from an external id (IMDb or TMDB) via Trakt's
   * id-lookup. Tries IMDb first, then TMDB. Returns the first show match's
   * Trakt id, or null. PUBLIC endpoint — needs only the api key (client id),
   * so it works even before the user authenticates via OAuth.
   */
  async lookupShowTraktId(imdbId?: string | null, tmdbId?: number | null, retried = false): Promise<number | null> {
    if (!this.getClientId()) return null;
    const lookups: Array<{ type: 'imdb' | 'tmdb'; id: string | number }> = [];
    if (imdbId) lookups.push({ type: 'imdb', id: imdbId });
    if (tmdbId) lookups.push({ type: 'tmdb', id: tmdbId });
    for (const { type, id } of lookups) {
      try {
        const response = await this.client.get(`/search/${type}/${id}`, {
          headers: this.getHeaders(),
          params: { type: 'show' },
        });
        const rows: any[] = Array.isArray(response.data) ? response.data : [];
        const hit = rows.find(r => r.show?.ids?.trakt);
        if (hit) return hit.show.ids.trakt as number;
      } catch (error: any) {
        if (error.response?.status === 401 && !retried) {
          const refreshed = await this.refreshToken();
          if (refreshed) return this.lookupShowTraktId(imdbId, tmdbId, true);
        }
        logger.debug(`Trakt: id-lookup ${type}/${id} failed: ${error.message}`);
      }
    }
    return null;
  }

  /**
   * Seed a show's full aired season/episode list ("Soll") for a show that was
   * added WITHOUT a trakt_id (e.g. Telegram free-text / source-by-title) but
   * carries an imdb/tmdb id. Resolves the Trakt id from that external id and
   * runs the normal season sync, giving missing-episode detection a baseline.
   *
   * Deliberately does NOT persist the resolved trakt_id onto the movie row: a
   * manually added show (trakt_id=NULL) is protected from watchlist-driven
   * deletion (syncWatchlist skips trakt_id=NULL rows), and writing a trakt_id
   * here would make a non-watchlist show deletable. The id is only needed
   * transiently to fetch the season structure.
   *
   * Returns the resolved Trakt id, or null when no id could be resolved.
   */
  async backfillShowSeasons(movieId: number, imdbId?: string | null, tmdbId?: number | null): Promise<number | null> {
    const traktId = await this.lookupShowTraktId(imdbId, tmdbId);
    if (!traktId) return null;
    logger.info(`Trakt: resolved trakt id ${traktId} for show ${movieId} via id-lookup — seeding season structure`);
    await this.syncShowSeasons(movieId, traktId);
    return traktId;
  }

  async syncWatchlist(): Promise<number> {
    const [movieWatchlist, showWatchlist] = await Promise.all([
      this.getMovieWatchlist(),
      this.getShowWatchlist(),
    ]);

    // If either API call failed, skip the deletion step entirely.
    // Processing an empty traktIds set would incorrectly delete all tracked movies.
    const fetchFailed = movieWatchlist === null || showWatchlist === null;
    const safeMovieWatchlist = movieWatchlist ?? [];
    const safeShowWatchlist = showWatchlist ?? [];

    let newCount = 0;
    const minQuality = getSetting('quality.minimum') || '1080p';

    // Sync movies
    for (const item of safeMovieWatchlist) {
      const existingByTrakt = getMovieByTraktId(item.movie.ids.trakt);
      const existingByImdb = !existingByTrakt && item.movie.ids.imdb ? getMovieByImdbId(item.movie.ids.imdb) : null;
      const existingByTmdb = !existingByTrakt && !existingByImdb && item.movie.ids.tmdb ? getMovieByTmdbId(item.movie.ids.tmdb, 'movie') : null;
      const existing = existingByTrakt || existingByImdb || existingByTmdb;
      if (existing && !existingByTrakt) {
        // Backfill trakt_id so future syncs find it directly
        updateMovieTraktId(existing.id, item.movie.ids.trakt);
        logger.info(`Backfilled trakt_id for ${existing.title} (was added via search)`);
      }
      if (!existing) {
        // Skip if already in media server library
        const libraryProvider = getLibraryProvider();
        if (libraryProvider.isConfigured()) {
          const inLibrary = await libraryProvider.hasMovie(item.movie.ids.imdb, item.movie.ids.tmdb, item.movie.title, item.movie.year);
          if (inLibrary === null) {
            // Library state unknown (provider down, cold cache). Adding now would
            // queue a download for something that may already be on disk — leave
            // the item for the next sync instead.
            logger.debug(`Trakt sync: deferring "${item.movie.title}" — library membership unknown`);
            continue;
          }
          if (inLibrary) {
            addMovie({
              trakt_id: item.movie.ids.trakt,
              imdb_id: item.movie.ids.imdb,
              tmdb_id: item.movie.ids.tmdb,
              title: item.movie.title,
              year: item.movie.year,
              slug: item.movie.ids.slug,
              media_type: 'movie',
              status: 'downloaded',
              desired_quality: minQuality,
              watchlist_source: 'trakt',
            });
            const providerName = getLibraryProviderName();
            addLogEntry(null, 'already_in_library', `${item.movie.title} (${item.movie.year}) already in ${providerName} — skipped`);
            logger.info(`Skipping ${item.movie.title} — already in ${providerName} library`);
            continue;
          }
        }
        await requestTitle({
          trakt_id: item.movie.ids.trakt,
          imdb_id: item.movie.ids.imdb,
          tmdb_id: item.movie.ids.tmdb,
          title: item.movie.title,
          year: item.movie.year,
          slug: item.movie.ids.slug,
          media_type: 'movie',
          status: 'pending',
          desired_quality: minQuality,
        });
        addLogEntry(null, 'movie_added', `New movie from Trakt: ${item.movie.title} (${item.movie.year})`);
        logger.info(`New movie added: ${item.movie.title} (${item.movie.year})`);
        newCount++;
      }
    }

    // Sync shows
    for (const item of safeShowWatchlist) {
      const existingByTrakt = getMovieByTraktId(item.show.ids.trakt);
      const existingByImdb = !existingByTrakt && item.show.ids.imdb ? getMovieByImdbId(item.show.ids.imdb) : null;
      const existingByTmdb = !existingByTrakt && !existingByImdb && item.show.ids.tmdb ? getMovieByTmdbId(item.show.ids.tmdb, 'show') : null;
      const existing = existingByTrakt || existingByImdb || existingByTmdb;
      if (existing && !existingByTrakt) {
        updateMovieTraktId(existing.id, item.show.ids.trakt);
        logger.info(`Backfilled trakt_id for ${existing.title} (was added via search)`);
      }
      if (!existing) {
        // requestTitle syncs seasons/episodes from Trakt internally (trakt_id present)
        await requestTitle({
          trakt_id: item.show.ids.trakt,
          imdb_id: item.show.ids.imdb,
          tmdb_id: item.show.ids.tmdb,
          title: item.show.title,
          year: item.show.year,
          slug: item.show.ids.slug,
          media_type: 'show',
          status: 'pending',
          desired_quality: minQuality,
        });
        addLogEntry(null, 'show_added', `New show from Trakt: ${item.show.title} (${item.show.year})`);
        logger.info(`New show added: ${item.show.title} (${item.show.year})`);
        newCount++;
      } else {
        // Existing show — re-sync seasons to detect new ones
        await this.syncShowSeasons(existing.id, item.show.ids.trakt);
      }
    }

    // Remove items no longer on the Trakt watchlist
    // Skip deletion entirely if either API call failed — an empty traktIds would incorrectly delete everything
    let removedCount = 0;
    if (!fetchFailed) {
      const traktIds = new Set([
        ...safeMovieWatchlist.map(item => item.movie.ids.trakt),
        ...safeShowWatchlist.map(item => item.show.ids.trakt),
      ]);
      const allMovies = getAllMovies();

      // Defence against a silently-truncated watchlist fetch (e.g. a future Trakt
      // change the pagination loop doesn't cover): if the fetched id-set collapses
      // to under half of the previous sync's, skip deletion THIS cycle so a partial
      // fetch can't mass-delete real entries. Transient-safe — we always record the
      // new count, so a genuine bulk-removal is deferred at most one cycle and then
      // proceeds; it never strands.
      const prevCount = this.lastWatchlistIdCount;
      this.lastWatchlistIdCount = traktIds.size;
      if (prevCount >= 20 && traktIds.size < prevCount * 0.5) {
        logger.warn(`Trakt watchlist id-count fell from ${prevCount} to ${traktIds.size} in one sync — skipping deletion this cycle (possible truncated fetch)`);
      } else {
        for (const movie of allMovies) {
          // Skip manually added movies (trakt_id=NULL or 0) and in-progress/completed downloads
          if (!movie.trakt_id) continue;
          // Never touch an entry another watchlist owns. In `both` mode the Plex
          // sync runs right after this one, so deleting its entries here made the
          // two syncs fight: Trakt removed them, Plex re-added them as "new", and
          // every 2-minute cycle re-searched the whole Plex watchlist against the
          // sources with the retry counters reset each round.
          if (movie.watchlist_source && movie.watchlist_source !== 'trakt') continue;
          // Never delete a movie mid-processMovie(): it holds the row and does
          // async searches, then writes status/log rows — deleting it under it
          // makes those writes fail a FOREIGN KEY constraint. (processMovie can
          // sit in 'pending'/'not_found' across its awaits, outside the status
          // allow-list below.)
          if (processingMovies.has(movie.id)) continue;
          if (!traktIds.has(movie.trakt_id) && !['searching', 'found', 'downloading', 'downloaded'].includes(movie.status)) {
            deleteMovie(movie.id);
            addLogEntry(null, 'movie_removed', `Removed from watchlist: ${movie.title} (${movie.year})`);
            logger.info(`Movie removed (not on watchlist): ${movie.title} (${movie.year})`);
            removedCount++;
          }
        }
      }
    } else {
      logger.warn('Trakt watchlist fetch had errors — skipping deletion to protect in-progress entries');
    }

    if (newCount > 0 || removedCount > 0) {
      addLogEntry(null, 'watchlist_sync', `Synced: ${newCount} added, ${removedCount} removed`);
    }

    return newCount;
  }

  private async fetchAndStoreUsername(): Promise<void> {
    try {
      const response = await this.client.get('/users/me', { headers: this.getHeaders() });
      const username = response.data.username;
      if (username) {
        setSetting('trakt.username', username);
        logger.info(`Trakt username detected: ${username}`);
      }
    } catch (error: any) {
      logger.warn('Could not fetch Trakt username:', error.message);
    }
  }

  async markAsCollected(movie: { imdb_id?: string; tmdb_id?: number; title: string; year: number }, retried = false): Promise<boolean> {
    if (!this.isAuthenticated()) {
      logger.debug('Trakt: skipping collection sync — not authenticated');
      return false;
    }

    try {
      const movieObj: Record<string, unknown> = {
        title: movie.title,
        year: movie.year,
        ids: {} as Record<string, unknown>,
      };
      if (movie.imdb_id) (movieObj.ids as Record<string, unknown>).imdb = movie.imdb_id;
      if (movie.tmdb_id) (movieObj.ids as Record<string, unknown>).tmdb = movie.tmdb_id;

      await this.client.post(
        '/sync/collection',
        { movies: [movieObj] },
        { headers: this.getHeaders() },
      );

      logger.info(`Trakt: marked ${movie.title} (${movie.year}) as collected`);
      return true;
    } catch (error: any) {
      if (error.response?.status === 401 && !retried) {
        const refreshed = await this.refreshToken();
        if (refreshed) return this.markAsCollected(movie, true);
      }
      logger.error(`Trakt: failed to mark ${movie.title} as collected: ${error.message}`);
      return false;
    }
  }

  /**
   * Add a movie or show to the user's Trakt watchlist. Requires ids (imdb/tmdb)
   * — Trakt can't reliably match a bare title. Used when a title is manually
   * added via dlvault so the watchlist stays in sync across apps.
   */
  async addToWatchlist(
    item: { imdb_id?: string; tmdb_id?: number; title: string; year?: number; mediaType?: 'movie' | 'show' },
    retried = false,
  ): Promise<boolean> {
    if (!this.isAuthenticated()) {
      logger.debug('Trakt: skipping watchlist add — not authenticated');
      return false;
    }
    if (!item.imdb_id && !item.tmdb_id) {
      logger.debug(`Trakt: skipping watchlist add for "${item.title}" — no imdb/tmdb id`);
      return false;
    }
    try {
      const ids: Record<string, unknown> = {};
      if (item.imdb_id) ids.imdb = item.imdb_id;
      if (item.tmdb_id) ids.tmdb = item.tmdb_id;
      const entry = { title: item.title, year: item.year, ids };
      const bucket = item.mediaType === 'show' ? 'shows' : 'movies';

      await this.client.post(
        '/sync/watchlist',
        { [bucket]: [entry] },
        { headers: this.getHeaders() },
      );
      logger.info(`Trakt: added ${item.title} to watchlist`);
      return true;
    } catch (error: any) {
      if (error.response?.status === 401 && !retried) {
        const refreshed = await this.refreshToken();
        if (refreshed) return this.addToWatchlist(item, true);
      }
      logger.error(`Trakt: failed to add ${item.title} to watchlist: ${error.message}`);
      return false;
    }
  }

  /**
   * Search Trakt's catalog for movies or shows — clean metadata (title, year,
   * ids). Used by the app's unified search so the HOST surfaces legitimate
   * catalog data, never release-source (plugin) results. Needs only the client
   * id (no user auth), so it works before login too.
   */
  async searchCatalog(
    query: string,
    opts: { types: ('movie' | 'show')[]; limit?: number },
  ): Promise<{ type: 'movie' | 'show'; title: string; year: number | null; imdbId: string | null; tmdbId: number | null }[]> {
    if (!this.getClientId() || opts.types.length === 0) return [];
    try {
      // One combined call (e.g. /search/movie,show) instead of one per type —
      // halves Trakt requests so heavy searching doesn't hit Trakt's own limit.
      const res = await this.client.get(`/search/${opts.types.join(',')}`, {
        headers: this.getHeaders(),
        params: { query, limit: opts.limit ?? 24 },
      });
      return (res.data || [])
        .map((r: any) => {
          const type = r.type as 'movie' | 'show';
          const item = r[type];
          return {
            type,
            title: item?.title || '',
            year: item?.year ?? null,
            imdbId: item?.ids?.imdb ?? null,
            tmdbId: item?.ids?.tmdb ?? null,
          };
        })
        .filter((x: { type: string; title: string }) => x.title && (x.type === 'movie' || x.type === 'show'));
    } catch (err: any) {
      logger.warn(`Trakt search "${query}" (${opts.types.join(',')}) failed: ${err?.message || err}`);
      return [];
    }
  }

  /**
   * Trending movies/shows from Trakt ("Beliebt diese Woche"). Clean catalog
   * metadata (title, year, ids) — feeds the search page's discovery shelf.
   * Needs only the client id.
   */
  async getTrending(
    opts: { types: ('movie' | 'show')[]; limit?: number },
  ): Promise<{ type: 'movie' | 'show'; title: string; year: number | null; imdbId: string | null; tmdbId: number | null }[]> {
    if (!this.getClientId() || opts.types.length === 0) return [];
    const limit = opts.limit ?? 12;
    const perType = await Promise.all(opts.types.map(async (type) => {
      try {
        const res = await this.client.get(`/${type}s/trending`, {
          headers: this.getHeaders(),
          params: { limit },
        });
        return (res.data || []).map((r: any) => {
          const item = r[type];
          return {
            type,
            title: item?.title || '',
            year: item?.year ?? null,
            imdbId: item?.ids?.imdb ?? null,
            tmdbId: item?.ids?.tmdb ?? null,
          };
        });
      } catch (err: any) {
        logger.warn(`Trakt trending (${type}) failed: ${err?.message || err}`);
        return [];
      }
    }));
    return perType.flat().filter((x: { title: string }) => x.title);
  }

  /**
   * Fetch movie details from Trakt (includes release date).
   */
  async getMovieDetails(traktId: number, retried = false): Promise<{
 released: string | null; title: string; year: number } | null> {
    if (!this.usable()) return null;
    try {
      const response = await this.client.get(`/movies/${traktId}`, {
        headers: this.getHeaders(),
        params: { extended: 'full' },
      });
      return {
        released: response.data.released || null,
        title: response.data.title,
        year: response.data.year,
      };
    } catch (error: any) {
      if (error.response?.status === 401 && !retried) {
        const refreshed = await this.refreshToken();
        if (refreshed) return this.getMovieDetails(traktId, true);
      }
      logger.debug(`Trakt: failed to fetch movie ${traktId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch season episodes with air dates from Trakt.
   */
  async getSeasonEpisodes(traktId: number, seasonNumber: number, retried = false): Promise<{
 number: number; title: string; first_aired: string | null }[]> {
    if (!this.usable()) return [];
    try {
      const response = await this.client.get(`/shows/${traktId}/seasons/${seasonNumber}`, {
        headers: this.getHeaders(),
        params: { extended: 'full' },
      });
      return (response.data || []).map((ep: any) => ({
        number: ep.number,
        title: ep.title || `Episode ${ep.number}`,
        first_aired: ep.first_aired || null,
      }));
    } catch (error: any) {
      if (error.response?.status === 401 && !retried) {
        const refreshed = await this.refreshToken();
        if (refreshed) return this.getSeasonEpisodes(traktId, seasonNumber, true);
      }
      logger.debug(`Trakt: failed to fetch S${seasonNumber} for show ${traktId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Localized title/overview/tagline from Trakt. This is a PUBLIC endpoint —
   * it only needs the api key (client id), no OAuth — so it works even before
   * the user authenticates. Used to show German plots instead of OMDb's
   * English-only ones. `id` may be a Trakt id, slug, or IMDb id. When several
   * regional variants of a language exist (de-DE/de-AT/de-CH) we prefer the one
   * whose country matches the language code (de-DE), which is usually the
   * fullest text; otherwise the first non-empty overview.
   */
  async getTranslation(
    id: string | number,
    mediaType: 'movie' | 'show',
    language = 'de',
  ): Promise<{ title: string | null; overview: string | null; tagline: string | null } | null> {
    if (!this.getClientId()) return null;
    const path = mediaType === 'show' ? 'shows' : 'movies';
    try {
      const response = await this.client.get(`/${path}/${id}/translations/${language}`, {
        headers: this.getHeaders(),
      });
      const rows: any[] = Array.isArray(response.data) ? response.data : [];
      const withOverview = rows.filter(r => r.overview && String(r.overview).trim());
      if (withOverview.length === 0) return null;
      const best = withOverview.find(r => r.country === language) ?? withOverview[0];
      return {
        title: best.title || null,
        overview: best.overview || null,
        tagline: best.tagline || null,
      };
    } catch (error: any) {
      logger.debug(`Trakt: failed to fetch ${language} translation for ${path}/${id}: ${error.message}`);
      return null;
    }
  }

  isConfigured(): boolean {
    return !!(getSetting('trakt.client_id') && getSetting('trakt.username'));
  }

  isAuthenticated(): boolean {
    return !!getSetting('trakt.access_token');
  }
}

export const traktService = new TraktService();
