import axios from 'axios';
import { getSetting, setSetting } from '../database/index';
import { addMovie, getMovieByTraktId, getMovieByTmdbId, getMovieByImdbId, getAllMovies, deleteMovie } from '../database/services/movies';
import { processingMovies } from './processingState';
import { addLogEntry } from '../database/services/activityLog';
import { getLibraryProvider, getLibraryProviderName } from './libraryProvider';
import { logger } from '../utils/logger';

const PLEX_DISCOVER_API = 'https://discover.provider.plex.tv';
const PLEX_META_API = 'https://metadata.provider.plex.tv';

interface PlexMovie {
  title: string;
  year: number;
  imdbId: string | null;
  tmdbId: number | null;
  plexKey: string;
  mediaType: 'movie' | 'show';
}

/** Neutral catalog item — same shape as traktService's search/trending. */
interface CatalogItem {
  type: 'movie' | 'show';
  title: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: number | null;
}

export class PlexService {
  private getToken(): string {
    return getSetting('plex.token') || '';
  }

  private getHeaders() {
    return {
      'X-Plex-Token': this.getToken(),
      'X-Plex-Client-Identifier': 'dlvault-v1',
      'X-Plex-Product': 'Dlvault',
      'X-Plex-Version': '1.0',
      'Accept': 'application/json',
    };
  }

  isConfigured(): boolean {
    return !!this.getToken();
  }

  async testConnection(): Promise<{ success: boolean; username?: string; movieCount?: number }> {
    if (!this.isConfigured()) return { success: false };

    try {
      // Get user info
      const userRes = await axios.get('https://plex.tv/api/v2/user', {
        headers: this.getHeaders(),
        timeout: 10000,
      });
      const username = userRes.data.username || userRes.data.title;

      // Get watchlist count
      const movies = await this.getWatchlist();

      return { success: true, username, movieCount: movies.length };
    } catch (error: any) {
      logger.error(`Plex connection failed: ${error.message}`);
      return { success: false };
    }
  }

  async getWatchlist(): Promise<PlexMovie[]> {
    if (!this.isConfigured()) return [];

    try {
      const allMovies: PlexMovie[] = [];
      let start = 0;
      const size = 100;

      // Try discover API first (new), fall back to metadata API (old)
      let baseUrl = PLEX_DISCOVER_API;

      while (true) {
        let res;
        try {
          res = await axios.get(`${baseUrl}/library/sections/watchlist/all`, {
            headers: {
              ...this.getHeaders(),
              'X-Plex-Container-Start': String(start),
              'X-Plex-Container-Size': String(size),
            },
            params: { includeGuids: 1 },
            timeout: 15000,
          });
        } catch (e: any) {
          // If discover API fails on first request, try metadata API
          if (start === 0 && baseUrl === PLEX_DISCOVER_API) {
            logger.info('Plex discover API failed, trying metadata API...');
            baseUrl = PLEX_META_API;
            res = await axios.get(`${baseUrl}/library/sections/watchlist/all`, {
              headers: {
                ...this.getHeaders(),
                'X-Plex-Container-Start': String(start),
                'X-Plex-Container-Size': String(size),
              },
              params: { includeGuids: 1 },
              timeout: 15000,
            });
          } else {
            throw e;
          }
        }

        const items = res.data?.MediaContainer?.Metadata || [];
        if (items.length === 0) break;

        for (const item of items) {
          // Plex uses "Guid" (capital) for the array, but some endpoints use "guids" — handle both
          const guids = item.Guid || item.guids || [];
          const imdbGuid = guids.find((g: { id?: string }) => g.id?.startsWith('imdb://'));
          const tmdbGuid = guids.find((g: { id?: string }) => g.id?.startsWith('tmdb://'));

          const imdbId = imdbGuid ? imdbGuid.id.replace('imdb://', '') : null;
          const tmdbId = tmdbGuid ? parseInt(tmdbGuid.id.replace('tmdb://', '')) : null;

          if (!imdbId && !tmdbId) {
            logger.debug(`Plex: "${item.title}" (${item.year}) has no GUIDs — title-only search will be used`);
          }

          allMovies.push({
            title: item.title,
            year: item.year,
            imdbId,
            tmdbId,
            plexKey: item.ratingKey,
            mediaType: item.type === 'show' ? 'show' : 'movie',
          });
        }

        start += items.length;
        const total = res.data?.MediaContainer?.totalSize || items.length;
        if (start >= total) break;
      }

      logger.info(`Plex watchlist: ${allMovies.length} items fetched`);
      return allMovies;
    } catch (error: any) {
      const status = error.response?.status || '';
      const detail = error.response?.data || error.message;
      logger.error(`Failed to fetch Plex watchlist: ${status} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
      return [];
    }
  }

  /**
   * Seed a show's season/episode structure from Trakt.
   *
   * This used to call `syncShowSeasons(id, tmdbId)` — but that endpoint resolves
   * its argument as a *Trakt* id, so a TMDb id silently addressed a completely
   * different series and seeded its seasons. Resolve the real id first:
   * `backfillShowSeasons` does the imdb/tmdb → Trakt lookup and deliberately
   * does not persist the result, which is what a Plex-owned row wants.
   */
  private async syncSeasonsViaTrakt(
    movieId: number,
    traktId: number | null,
    imdbId?: string | null,
    tmdbId?: number | null,
  ): Promise<void> {
    try {
      const { traktService: trakt } = await import('./trakt');
      if (!trakt.isConfigured()) return;
      if (traktId) {
        await trakt.syncShowSeasons(movieId, traktId);
        return;
      }
      const resolved = await trakt.backfillShowSeasons(movieId, imdbId, tmdbId);
      if (!resolved) {
        logger.debug(`Plex: could not resolve a Trakt id for show #${movieId} — season structure stays unseeded`);
      }
    } catch (err: any) {
      logger.debug(`Plex: season sync via Trakt failed for #${movieId}: ${err?.message || err}`);
    }
  }

  async syncWatchlist(): Promise<number> {
    const watchlist = await this.getWatchlist();
    let newCount = 0;
    let skippedExisting = 0;
    let skippedNoId = 0;
    let skippedInLibrary = 0;
    const minQuality = getSetting('quality.minimum') || '1080p';

    for (const item of watchlist) {
      // Identity comes from the real id columns — a Plex entry is identified by
      // its TMDb or IMDb id, never by borrowing the trakt_id column. Titles that
      // carry only an IMDb id (common for fresh Discover entries) used to be
      // dropped entirely here; now either id is enough to track them.
      if (!item.tmdbId && !item.imdbId) {
        logger.debug(`Plex: skipping "${item.title}" — no TMDb or IMDb ID`);
        skippedNoId++;
        continue;
      }

      // Check all possible identifiers to prevent duplicates
      const existingByTmdb = item.tmdbId ? getMovieByTmdbId(item.tmdbId, item.mediaType) : null;
      const existingByImdb = item.imdbId ? getMovieByImdbId(item.imdbId) : null;
      const existing = existingByTmdb || existingByImdb;

      if (existing) {
        // For existing shows: re-sync seasons via Trakt if available
        if (existing.media_type === 'show') {
          await this.syncSeasonsViaTrakt(existing.id, existing.trakt_id, existing.imdb_id, existing.tmdb_id);
        }
        skippedExisting++;
        continue;
      }
      {
        // Skip if already in media server library (movies only — shows need per-season tracking)
        const libraryProvider = getLibraryProvider();
        if (item.mediaType === 'movie' && libraryProvider.isConfigured()) {
          const inLibrary = await libraryProvider.hasMovie(item.imdbId, item.tmdbId, item.title, item.year);
          if (inLibrary === null) {
            // Library state unknown (provider down, cold cache) — defer rather
            // than queue a download for something that may already be on disk.
            logger.debug(`Plex sync: deferring "${item.title}" — library membership unknown`);
            continue;
          }
          if (inLibrary) {
            addMovie({
              trakt_id: 0,
              imdb_id: item.imdbId || '',
              tmdb_id: item.tmdbId,
              title: item.title,
              year: item.year,
              slug: item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
              media_type: item.mediaType,
              status: 'downloaded',
              desired_quality: minQuality,
              watchlist_source: 'plex',
            });
            const providerName = getLibraryProviderName();
            skippedInLibrary++;
            addLogEntry(null, 'already_in_library', `${item.title} (${item.year}) already in ${providerName} — skipped`);
            logger.info(`Skipping ${item.title} — already in ${providerName} library`);
            continue;
          }
        }
        const newItem = addMovie({
          trakt_id: 0,
          imdb_id: item.imdbId || '',
          tmdb_id: item.tmdbId,
          title: item.title,
          year: item.year,
          slug: item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          media_type: item.mediaType,
          status: 'pending',
          desired_quality: minQuality,
          watchlist_source: 'plex',
        });
        // Auto-sync seasons for shows via Trakt
        if (item.mediaType === 'show') {
          await this.syncSeasonsViaTrakt(newItem.id, null, item.imdbId, item.tmdbId);
        }
        const typeLabel = item.mediaType === 'show' ? 'show' : 'movie';
        addLogEntry(null, `${typeLabel}_added`, `New ${typeLabel} from Plex: ${item.title} (${item.year})`);
        logger.info(`New movie added from Plex: ${item.title} (${item.year})`);
        newCount++;
      }
    }

    // Remove movies no longer on Plex watchlist
    const plexTmdbIds = new Set(watchlist.map(m => m.tmdbId).filter(Boolean));
    const plexImdbIds = new Set(watchlist.map(m => m.imdbId).filter(Boolean));
    const allMovies = getAllMovies();
    let removedCount = 0;

    // Only remove if watchlist provider is plex-only (not both)
    const provider = getSetting('watchlist.provider') || 'trakt';
    // Guard against a transient Plex fetch failure: getWatchlist() returns [] on
    // ANY error, so without this check a momentary Plex/network outage would make
    // the loop below delete every tracked movie. An empty result is
    // indistinguishable from a genuinely-cleared watchlist, so we never
    // auto-remove on an empty list — losing one sync's removals is far better
    // than nuking the library.
    if (provider === 'plex' && watchlist.length > 0) {
      for (const movie of allMovies) {
        // Delete only what this sync owns. Manual adds (Telegram, search) and
        // Trakt-owned rows must survive, and a row with no recorded source
        // predates the column — too ambiguous to delete, so it stays. The
        // migration relabels the legacy Plex rows, so this is not a leak.
        if (movie.watchlist_source !== 'plex') continue;
        // Don't delete a movie mid-processMovie() — deleting the row under it
        // makes its status/log writes fail a FOREIGN KEY constraint.
        if (processingMovies.has(movie.id)) continue;
        // Match on either id — an entry tracked by IMDb id alone would otherwise
        // never be found on the watchlist and be deleted on every single sync.
        const onWatchlist = (movie.tmdb_id != null && plexTmdbIds.has(movie.tmdb_id))
          || (!!movie.imdb_id && plexImdbIds.has(movie.imdb_id));
        if (!onWatchlist && !['downloading', 'downloaded'].includes(movie.status)) {
          deleteMovie(movie.id);
          addLogEntry(null, 'movie_removed', `Removed from Plex watchlist: ${movie.title} (${movie.year})`);
          logger.info(`Movie removed (not on Plex watchlist): ${movie.title} (${movie.year})`);
          removedCount++;
        }
      }
    }

    if (newCount > 0 || removedCount > 0) {
      addLogEntry(null, 'watchlist_sync', `Plex: ${newCount} added, ${removedCount} removed`);
    }

    if (watchlist.length > 0) {
      logger.info(`Plex sync: ${newCount} new, ${skippedExisting} existing, ${skippedInLibrary} in library, ${skippedNoId} no ID, ${removedCount} removed`);
    }

    return newCount;
  }

  // ── Plex Discover catalog (search + trending) ─────────────────────────────
  // Shared shape with traktService.searchCatalog/getTrending so the unified
  // search route can use whichever provider the user runs.

  /** Flatten Plex's search response (nests differently across API versions). */
  private flattenSearchMetas(mc: any): any[] {
    const out: any[] = [];
    const groups = mc?.SearchResults || mc?.SearchResult || [];
    if (Array.isArray(groups)) {
      for (const g of groups) {
        if (g?.Metadata) out.push(g.Metadata);
        if (Array.isArray(g?.SearchResult)) for (const sr of g.SearchResult) if (sr?.Metadata) out.push(sr.Metadata);
      }
    }
    if (Array.isArray(mc?.Metadata)) out.push(...mc.Metadata);
    return out;
  }

  /** Pull imdb/tmdb ids out of a Plex item's Guid array. */
  private externalIds(m: any): { imdbId: string | null; tmdbId: number | null } {
    const guids = m?.Guid || m?.guids || [];
    let imdbId: string | null = null;
    let tmdbId: number | null = null;
    for (const g of guids) {
      const id: string = g?.id || '';
      if (id.startsWith('imdb://')) imdbId = id.replace('imdb://', '');
      else if (id.startsWith('tmdb://')) { const n = parseInt(id.replace('tmdb://', ''), 10); if (!isNaN(n)) tmdbId = n; }
    }
    return { imdbId, tmdbId };
  }

  /**
   * Search Plex's Discover catalog for movies/shows — clean metadata (title,
   * year, ids). Lets a Plex-only instance (no Trakt) power the unified search.
   */
  async searchCatalog(
    query: string,
    opts: { types: ('movie' | 'show')[]; limit?: number },
  ): Promise<CatalogItem[]> {
    if (!this.isConfigured() || opts.types.length === 0) return [];
    try {
      const searchTypes = Array.from(new Set(opts.types.map(t => (t === 'show' ? 'tv' : 'movies')))).join(',');
      const res = await axios.get(`${PLEX_DISCOVER_API}/library/search`, {
        headers: this.getHeaders(),
        // includeGuids: without it Plex returns no Guid array, so every result
        // came back with imdbId/tmdbId null — no poster, no metadata enrichment
        // (which requires an imdb_id), and nothing to dedupe against the library.
        params: { query, limit: opts.limit ?? 30, searchTypes, includeMetadata: 1, includeGuids: 1 },
        timeout: 15000,
      });
      const out: CatalogItem[] = [];
      for (const m of this.flattenSearchMetas(res.data?.MediaContainer || {})) {
        const type: 'movie' | 'show' | null = m.type === 'show' ? 'show' : m.type === 'movie' ? 'movie' : null;
        if (!type || !opts.types.includes(type) || !m.title) continue;
        const { imdbId, tmdbId } = this.externalIds(m);
        out.push({ type, title: m.title, year: typeof m.year === 'number' ? m.year : null, imdbId, tmdbId });
      }
      return out;
    } catch (err: any) {
      logger.warn(`Plex catalog search "${query}" failed: ${err?.message || err}`);
      return [];
    }
  }

  /**
   * Trending movies/shows from Plex Discover's promoted hubs — feeds the search
   * page's discovery shelf for Plex-only users. Best-effort: Plex's hub shape
   * varies, so this degrades to [] (empty shelf) rather than erroring.
   */
  async getTrending(opts: { types: ('movie' | 'show')[]; limit?: number }): Promise<CatalogItem[]> {
    if (!this.isConfigured() || opts.types.length === 0) return [];
    const limit = opts.limit ?? 12;
    try {
      const res = await axios.get(`${PLEX_DISCOVER_API}/hubs/promoted`, {
        headers: this.getHeaders(),
        params: { contentDirectoryID: 'movies,tv', excludeContinueWatching: 1, count: 30, includeGuids: 1 },
        timeout: 15000,
      });
      const hubs = res.data?.MediaContainer?.Hub || res.data?.MediaContainer?.Metadata || [];
      const items: any[] = [];
      if (Array.isArray(hubs)) for (const h of hubs) {
        if (Array.isArray(h?.Metadata)) items.push(...h.Metadata);
        else if (h?.ratingKey) items.push(h);
      }
      const out: CatalogItem[] = [];
      const seen = new Set<string>();
      for (const m of items) {
        const type: 'movie' | 'show' | null = m.type === 'show' ? 'show' : m.type === 'movie' ? 'movie' : null;
        if (!type || !opts.types.includes(type) || !m.title) continue;
        const key = `${type}:${m.title}:${m.year ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { imdbId, tmdbId } = this.externalIds(m);
        out.push({ type, title: m.title, year: typeof m.year === 'number' ? m.year : null, imdbId, tmdbId });
        if (out.length >= limit) break;
      }
      return out;
    } catch (err: any) {
      logger.warn(`Plex trending failed: ${err?.message || err}`);
      return [];
    }
  }

  /**
   * Resolve a title to its Plex Discover ratingKey (needed to add it to the
   * watchlist). Matches by external GUID (imdb/tmdb) first, title+year as fallback.
   */
  private async findWatchlistRatingKey(
    item: { imdbId?: string; tmdbId?: number; title: string; year?: number; mediaType: 'movie' | 'show' },
  ): Promise<string | null> {
    const res = await axios.get(`${PLEX_DISCOVER_API}/library/search`, {
      headers: this.getHeaders(),
      params: {
        query: item.title,
        limit: 15,
        searchTypes: item.mediaType === 'show' ? 'tv' : 'movies',
        includeMetadata: 1,
        // Without this Plex omits the Guid array entirely, so the GUID match
        // below could never hit and every add fell through to fuzzy matching.
        includeGuids: 1,
      },
      timeout: 15000,
    });

    const wantType = item.mediaType === 'show' ? 'show' : 'movie';
    const candidates = this.flattenSearchMetas(res.data?.MediaContainer || {}).filter(m => !m.type || m.type === wantType);

    const guidHit = candidates.find(m => {
      const guids = m.Guid || m.guids || [];
      return guids.some((g: { id?: string }) =>
        (item.imdbId && g.id === `imdb://${item.imdbId}`) ||
        (item.tmdbId && g.id === `tmdb://${item.tmdbId}`));
    });
    if (guidHit?.ratingKey) return String(guidHit.ratingKey);

    const titleHit = candidates.find(m =>
      typeof m.title === 'string' &&
      m.title.toLowerCase() === item.title.toLowerCase() &&
      (!item.year || m.year === item.year));
    if (titleHit?.ratingKey) return String(titleHit.ratingKey);

    // No confident match. Deliberately NOT falling back to candidates[0]: this
    // ratingKey is about to be written to the user's own Plex watchlist, and
    // Discover's top hit for "Alien: Romulus" is "Alien" (1979). Adding the wrong
    // film there is silent and self-propagating — the next sync downloads it.
    logger.debug(
      `Plex: no confident Discover match for "${item.title}"${item.year ? ` (${item.year})` : ''} ` +
      `among ${candidates.length} candidate(s) — not adding to the watchlist`,
    );
    return null;
  }

  /**
   * Add a movie/show to the user's Plex watchlist. Best-effort: resolves the
   * Discover ratingKey then PUTs the addToWatchlist action. Used when a title is
   * manually added via dlvault so a Plex-only user's watchlist stays in sync.
   */
  async addToWatchlist(
    item: { imdbId?: string; tmdbId?: number; title: string; year?: number; mediaType?: 'movie' | 'show' },
  ): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.debug('Plex: skipping watchlist add — no token');
      return false;
    }
    const mediaType = item.mediaType === 'show' ? 'show' : 'movie';
    try {
      const ratingKey = await this.findWatchlistRatingKey({ ...item, mediaType });
      if (!ratingKey) {
        logger.warn(`Plex: no Discover match for "${item.title}" (${item.year ?? '?'}) — can't add to watchlist`);
        return false;
      }
      await axios.put(`${PLEX_DISCOVER_API}/actions/addToWatchlist`, null, {
        headers: this.getHeaders(),
        params: { ratingKey },
        timeout: 15000,
      });
      logger.info(`Plex: added ${item.title} to watchlist (ratingKey ${ratingKey})`);
      return true;
    } catch (error: any) {
      const status = error.response?.status || '';
      logger.error(`Plex: failed to add ${item.title} to watchlist: ${status} ${error.message}`);
      return false;
    }
  }
}

export const plexService = new PlexService();
