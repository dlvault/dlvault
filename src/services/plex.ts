import axios from 'axios';
import { getSetting, setSetting } from '../database/index';
import { addMovie, getMovieByTraktId, getMovieByTmdbId, getMovieByImdbId, getAllMovies, deleteMovie } from '../database/services/movies';
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

  async syncWatchlist(): Promise<number> {
    const watchlist = await this.getWatchlist();
    let newCount = 0;
    let skippedExisting = 0;
    let skippedNoId = 0;
    let skippedInLibrary = 0;
    const minQuality = getSetting('quality.minimum') || '1080p';

    for (const item of watchlist) {
      // Use tmdbId as trakt_id substitute (unique identifier)
      const lookupId = item.tmdbId || 0;
      if (!lookupId) {
        logger.debug(`Plex: skipping "${item.title}" - no TMDb ID`);
        skippedNoId++;
        continue;
      }

      // Check all possible identifiers to prevent duplicates
      const existingByTrakt = getMovieByTraktId(lookupId);
      const existingByTmdb = item.tmdbId ? getMovieByTmdbId(item.tmdbId) : null;
      const existingByImdb = item.imdbId ? getMovieByImdbId(item.imdbId) : null;
      const existing = existingByTrakt || existingByTmdb || existingByImdb;

      if (existing) {
        // For existing shows: re-sync seasons via Trakt if available
        if (existing.media_type === 'show' && existing.trakt_id) {
          try {
            const { traktService: trakt } = await import('./trakt');
            if (trakt.isConfigured()) {
              await trakt.syncShowSeasons(existing.id, existing.trakt_id);
            }
          } catch {}
        }
        skippedExisting++;
        continue;
      }
      {
        // Skip if already in media server library (movies only — shows need per-season tracking)
        const libraryProvider = getLibraryProvider();
        if (item.mediaType === 'movie' && libraryProvider.isConfigured()) {
          const inLibrary = await libraryProvider.hasMovie(item.imdbId, item.tmdbId, item.title, item.year);
          if (inLibrary) {
            addMovie({
              trakt_id: lookupId,
              imdb_id: item.imdbId || '',
              tmdb_id: item.tmdbId,
              title: item.title,
              year: item.year,
              slug: item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
              media_type: item.mediaType,
              status: 'downloaded',
              desired_quality: minQuality,
            });
            const providerName = getLibraryProviderName();
            skippedInLibrary++;
            addLogEntry(null, 'already_in_library', `${item.title} (${item.year}) already in ${providerName} — skipped`);
            logger.info(`Skipping ${item.title} — already in ${providerName} library`);
            continue;
          }
        }
        const newItem = addMovie({
          trakt_id: lookupId,
          imdb_id: item.imdbId || '',
          tmdb_id: item.tmdbId,
          title: item.title,
          year: item.year,
          slug: item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          media_type: item.mediaType,
          status: 'pending',
          desired_quality: minQuality,
        });
        // Auto-sync seasons for shows via Trakt
        if (item.mediaType === 'show') {
          try {
            const { traktService: trakt } = await import('./trakt');
            if (trakt.isConfigured() && lookupId) {
              await trakt.syncShowSeasons(newItem.id, lookupId);
            }
          } catch {}
        }
        const typeLabel = item.mediaType === 'show' ? 'show' : 'movie';
        addLogEntry(null, `${typeLabel}_added`, `New ${typeLabel} from Plex: ${item.title} (${item.year})`);
        logger.info(`New movie added from Plex: ${item.title} (${item.year})`);
        newCount++;
      }
    }

    // Remove movies no longer on Plex watchlist
    const plexTmdbIds = new Set(watchlist.map(m => m.tmdbId).filter(Boolean));
    const allMovies = getAllMovies();
    let removedCount = 0;

    // Only remove if watchlist provider is plex-only (not both)
    // Never remove movies added manually (Telegram, search) — they have trakt_id=NULL
    const provider = getSetting('watchlist.provider') || 'trakt';
    // Guard against a transient Plex fetch failure: getWatchlist() returns [] on
    // ANY error, so without this check a momentary Plex/network outage would make
    // the loop below delete every tracked movie. An empty result is
    // indistinguishable from a genuinely-cleared watchlist, so we never
    // auto-remove on an empty list — losing one sync's removals is far better
    // than nuking the library.
    if (provider === 'plex' && watchlist.length > 0) {
      for (const movie of allMovies) {
        if (!movie.trakt_id) continue; // manually added — keep
        if (!plexTmdbIds.has(movie.tmdb_id) && !['downloading', 'downloaded'].includes(movie.status)) {
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
}

export const plexService = new PlexService();
