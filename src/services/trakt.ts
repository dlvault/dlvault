import axios, { AxiosInstance } from 'axios';
import { getSetting, setSetting } from '../database/index';
import { addMovie, getMovieByTraktId, getMovieByImdbId, getMovieByTmdbId, updateMovieTraktId, getAllMovies, deleteMovie, getMovieById } from '../database/services/movies';
import { addLogEntry } from '../database/services/activityLog';
import { getSeasonsByShowId, addSeason, updateSeasonEpisodeCount } from '../database/services/seasons';
import { addEpisodes } from '../database/services/episodes';
import { getLibraryProvider, getLibraryProviderName } from './libraryProvider';
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

  constructor() {
    this.client = axios.create({
      baseURL: TRAKT_API_URL,
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'User-Agent': 'Dlvault/1.0',
      },
    });
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

    try {
      const response = await this.client.get(
        `/users/${username}/watchlist/movies`,
        { headers: this.getHeaders() }
      );
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 401 && !retried) {
        const refreshed = await this.refreshToken();
        if (refreshed) return this.getMovieWatchlist(true);
      }
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

    try {
      const response = await this.client.get(
        `/users/${username}/watchlist/shows`,
        { headers: this.getHeaders() }
      );
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 401 && !retried) {
        const refreshed = await this.refreshToken();
        if (refreshed) return this.getShowWatchlist(true);
      }
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

    let newSeasons = 0;
    for (const ts of traktSeasons) {
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
      const existingByTmdb = !existingByTrakt && !existingByImdb && item.movie.ids.tmdb ? getMovieByTmdbId(item.movie.ids.tmdb) : null;
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
            });
            const providerName = getLibraryProviderName();
            addLogEntry(null, 'already_in_library', `${item.movie.title} (${item.movie.year}) already in ${providerName} — skipped`);
            logger.info(`Skipping ${item.movie.title} — already in ${providerName} library`);
            continue;
          }
        }
        addMovie({
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
      const existingByTmdb = !existingByTrakt && !existingByImdb && item.show.ids.tmdb ? getMovieByTmdbId(item.show.ids.tmdb) : null;
      const existing = existingByTrakt || existingByImdb || existingByTmdb;
      if (existing && !existingByTrakt) {
        updateMovieTraktId(existing.id, item.show.ids.trakt);
        logger.info(`Backfilled trakt_id for ${existing.title} (was added via search)`);
      }
      if (!existing) {
        const show = addMovie({
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
        // Auto-add seasons and episodes from Trakt metadata
        await this.syncShowSeasons(show.id, item.show.ids.trakt);
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

      for (const movie of allMovies) {
        // Skip manually added movies (trakt_id=NULL or 0) and in-progress/completed downloads
        if (!movie.trakt_id) continue;
        if (!traktIds.has(movie.trakt_id) && !['searching', 'found', 'downloading', 'downloaded'].includes(movie.status)) {
          deleteMovie(movie.id);
          addLogEntry(null, 'movie_removed', `Removed from watchlist: ${movie.title} (${movie.year})`);
          logger.info(`Movie removed (not on watchlist): ${movie.title} (${movie.year})`);
          removedCount++;
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

  async markAsCollected(movie: { imdb_id?: string; tmdb_id?: number; title: string; year: number }): Promise<boolean> {
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
      logger.error(`Trakt: failed to mark ${movie.title} as collected: ${error.message}`);
      return false;
    }
  }

  /**
   * Fetch movie details from Trakt (includes release date).
   */
  async getMovieDetails(traktId: number, retried = false): Promise<{ released: string | null; title: string; year: number } | null> {
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
  async getSeasonEpisodes(traktId: number, seasonNumber: number, retried = false): Promise<{ number: number; title: string; first_aired: string | null }[]> {
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

  isConfigured(): boolean {
    return !!(getSetting('trakt.client_id') && getSetting('trakt.username'));
  }

  isAuthenticated(): boolean {
    return !!getSetting('trakt.access_token');
  }
}

export const traktService = new TraktService();
