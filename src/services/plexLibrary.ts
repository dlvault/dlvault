import axios from 'axios';
import { getSetting } from '../database/index';
import { logger } from '../utils/logger';
import type { LibraryProvider, LibraryMovie, LibraryShowEpisodes } from './libraryProvider';
import { episodeKey, toNaiveUtc } from './libraryProvider';

/**
 * Plex Server Library provider — connects to a local Plex Media Server
 * to check which movies/shows are already in the library.
 *
 * This is separate from plex.ts which handles the Plex *watchlist* (cloud API).
 * This service talks to the local Plex server (e.g. http://<server-ip>:32400).
 */

interface PlexLibrarySection {
  key: string;
  title: string;
  type: string; // 'movie' | 'show'
}

interface PlexMetadataItem {
  ratingKey: string;
  title: string;
  year?: number;
  summary?: string;
  type: string;
  thumb?: string;
  Guid?: { id: string }[];
  /** Unix epoch (SECONDS) when the item was added to the Plex library. */
  addedAt?: number;
}

class PlexLibraryService implements LibraryProvider {
  private movieCache: LibraryMovie[] = [];
  private movieCacheMap: Map<string, LibraryMovie> = new Map();
  private lastFetch = 0;
  private lastFullFetch = 0;
  private refreshInProgress: Promise<LibraryMovie[]> | null = null;
  private machineIdentifier: string | null = null;
  private readonly CACHE_TTL = 10 * 60 * 1000;
  private readonly FULL_REFRESH_INTERVAL = 60 * 60 * 1000;

  /** Plex web deep-links need the server's machineIdentifier; fetched once and cached. */
  async getMachineIdentifier(): Promise<string | null> {
    if (this.machineIdentifier) return this.machineIdentifier;
    if (!this.isConfigured()) return null;
    try {
      const res = await axios.get(`${this.getServerUrl()}/identity`, {
        headers: { 'X-Plex-Token': this.getToken(), Accept: 'application/json' },
        timeout: 5000,
      });
      const mid = res.data?.MediaContainer?.machineIdentifier;
      if (typeof mid === 'string' && mid) this.machineIdentifier = mid;
    } catch (error: any) {
      logger.debug(`Plex: machineIdentifier fetch failed: ${error.message}`);
    }
    return this.machineIdentifier;
  }

  private getServerUrl(): string {
    return (getSetting('plex.server_url') || '').replace(/\/+$/, '');
  }

  private getToken(): string {
    return getSetting('plex.token') || '';
  }

  private getHeaders() {
    return {
      'X-Plex-Token': this.getToken(),
      'Accept': 'application/json',
    };
  }

  isConfigured(): boolean {
    return !!(this.getServerUrl() && this.getToken());
  }

  async testConnection(): Promise<{ success: boolean; serverName?: string; movieCount?: number }> {
    if (!this.isConfigured()) return { success: false };

    try {
      const res = await axios.get(`${this.getServerUrl()}/`, {
        headers: this.getHeaders(),
        timeout: 10000,
      });

      const container = res.data?.MediaContainer;
      const serverName = container?.friendlyName || 'Plex';

      const movies = await this.fetchAllLibraryItems();
      return { success: true, serverName, movieCount: movies.length };
    } catch (error: any) {
      logger.error(`Plex server connection failed: ${error.message}`);
      return { success: false };
    }
  }

  private async getLibrarySections(): Promise<PlexLibrarySection[]> {
    const res = await axios.get(`${this.getServerUrl()}/library/sections`, {
      headers: this.getHeaders(),
      timeout: 10000,
    });

    const directories = res.data?.MediaContainer?.Directory || [];
    return directories
      .filter((d: any) => d.type === 'movie' || d.type === 'show')
      .map((d: any) => ({
        key: d.key,
        title: d.title,
        type: d.type,
      }));
  }

  private async fetchSectionItems(sectionKey: string, sectionType: string): Promise<LibraryMovie[]> {
    const items: LibraryMovie[] = [];
    let start = 0;
    const size = 200;

    while (true) {
      const res = await axios.get(
        `${this.getServerUrl()}/library/sections/${sectionKey}/all`,
        {
          headers: {
            ...this.getHeaders(),
            'X-Plex-Container-Start': String(start),
            'X-Plex-Container-Size': String(size),
          },
          params: {
            includeGuids: 1,
          },
          timeout: 30000,
        },
      );

      const metadata: PlexMetadataItem[] = res.data?.MediaContainer?.Metadata || [];
      if (metadata.length === 0) break;

      for (const item of metadata) {
        const guids = item.Guid || [];
        const imdbGuid = guids.find(g => g.id?.startsWith('imdb://'));
        const tmdbGuid = guids.find(g => g.id?.startsWith('tmdb://'));

        items.push({
          id: item.ratingKey,
          name: item.title,
          year: item.year || null,
          imdbId: imdbGuid ? imdbGuid.id.replace('imdb://', '') : null,
          tmdbId: tmdbGuid ? tmdbGuid.id.replace('tmdb://', '') : null,
          overview: item.summary || null,
          mediaType: sectionType === 'show' ? 'show' : 'movie',
          imageTag: item.thumb || null,
          addedAt: toNaiveUtc(item.addedAt),
        });
      }

      start += metadata.length;
      const total = res.data?.MediaContainer?.totalSize ?? metadata.length;
      if (start >= total) break;
    }

    return items;
  }

  private async fetchAllLibraryItems(): Promise<LibraryMovie[]> {
    const sections = await this.getLibrarySections();
    const results: LibraryMovie[] = [];

    for (const section of sections) {
      const items = await this.fetchSectionItems(section.key, section.type);
      results.push(...items);
    }

    return results;
  }

  async getMovies(forceRefresh = false): Promise<LibraryMovie[]> {
    if (!this.isConfigured()) return [];

    const now = Date.now();

    if (!forceRefresh && this.movieCache.length > 0 && (now - this.lastFetch) < this.CACHE_TTL) {
      return this.movieCache;
    }

    if (this.refreshInProgress) {
      return this.refreshInProgress;
    }

    this.refreshInProgress = this.doRefresh(now);
    try {
      return await this.refreshInProgress;
    } finally {
      this.refreshInProgress = null;
    }
  }

  private async doRefresh(now: number): Promise<LibraryMovie[]> {
    try {
      // Plex doesn't have incremental sync like Jellyfin, always full fetch
      // but we throttle via CACHE_TTL
      const movies = await this.fetchAllLibraryItems();
      this.movieCacheMap.clear();
      for (const movie of movies) {
        this.movieCacheMap.set(movie.id, movie);
      }
      this.movieCache = Array.from(this.movieCacheMap.values());
      this.lastFetch = now;
      this.lastFullFetch = now;
      logger.info(`Plex library: synced ${this.movieCache.length} items`);
      return this.movieCache;
    } catch (error: any) {
      logger.error(`Plex library fetch error: ${error.message}`);
      return this.movieCache;
    }
  }

  clearCache(): void {
    this.movieCache = [];
    this.movieCacheMap.clear();
    this.lastFetch = 0;
    this.lastFullFetch = 0;
  }

  getCachedMovieCount(): number {
    return this.movieCache.reduce((n, m) => n + (m.mediaType === 'movie' ? 1 : 0), 0);
  }

  async deleteItem(itemId: string): Promise<boolean> {
    if (!this.isConfigured()) return false;

    try {
      await axios.delete(`${this.getServerUrl()}/library/metadata/${itemId}`, {
        headers: this.getHeaders(),
        timeout: 10000,
      });
      this.movieCacheMap.delete(itemId);
      this.movieCache = this.movieCache.filter(m => m.id !== itemId);
      logger.info(`Plex: deleted item ${itemId}`);
      return true;
    } catch (error: any) {
      logger.error(`Plex delete failed: ${error.message}`);
      return false;
    }
  }

  async hasMovie(imdbId?: string | null, tmdbId?: number | null, title?: string, year?: number | null): Promise<boolean> {
    if (!this.isConfigured()) return false;

    const movies = await this.getMovies();

    if (imdbId) {
      const match = movies.find(m => m.imdbId === imdbId);
      if (match) {
        logger.debug(`Plex match by IMDB ${imdbId}: "${match.name}"`);
        return true;
      }
    }

    if (tmdbId) {
      const tmdbStr = String(tmdbId);
      const match = movies.find(m => m.tmdbId === tmdbStr);
      if (match) {
        logger.debug(`Plex match by TMDB ${tmdbId}: "${match.name}"`);
        return true;
      }
    }

    if (title && year) {
      const normalizedTitle = title.toLowerCase().trim();
      const match = movies.find(m => m.name.toLowerCase().trim() === normalizedTitle && m.year === year);
      if (match) {
        logger.debug(`Plex match by title+year "${title}" (${year}): "${match.name}"`);
        return true;
      }
    }

    if (title) {
      const normalizedTitle = title.toLowerCase().trim();
      const match = movies.find(m => m.name.toLowerCase().trim() === normalizedTitle);
      if (match) {
        logger.debug(`Plex match by title "${title}": "${match.name}" (${match.year})`);
        return true;
      }
    }

    return false;
  }

  private findShow(imdbId?: string | null, tmdbId?: number | null, title?: string, year?: number | null): LibraryMovie | null {
    const shows = this.movieCache.filter(m => m.mediaType === 'show');
    if (imdbId) {
      const m = shows.find(s => s.imdbId === imdbId);
      if (m) return m;
    }
    if (tmdbId) {
      const tmdbStr = String(tmdbId);
      const m = shows.find(s => s.tmdbId === tmdbStr);
      if (m) return m;
    }
    if (title) {
      const norm = title.toLowerCase().trim();
      if (year) {
        const m = shows.find(s => s.name.toLowerCase().trim() === norm && s.year === year);
        if (m) return m;
      }
      const m = shows.find(s => s.name.toLowerCase().trim() === norm);
      if (m) return m;
    }
    return null;
  }

  async getShowEpisodes(
    imdbId?: string | null, tmdbId?: number | null, title?: string, year?: number | null,
  ): Promise<LibraryShowEpisodes | null> {
    if (!this.isConfigured()) return null;

    try {
      await this.getMovies();
    } catch {
      return null;
    }

    const show = this.findShow(imdbId, tmdbId, title, year);
    if (!show) {
      logger.debug(`Plex: show "${title}" not in library (imdb=${imdbId}, tmdb=${tmdbId})`);
      return { found: false, episodes: new Set() };
    }

    try {
      const res = await axios.get(
        `${this.getServerUrl()}/library/metadata/${show.id}/allLeaves`,
        { headers: this.getHeaders(), timeout: 30000 },
      );
      const metadata = (res.data?.MediaContainer?.Metadata || []) as { parentIndex?: number; index?: number }[];
      const episodes = new Set<string>();
      for (const item of metadata) {
        if (typeof item.parentIndex === 'number' && typeof item.index === 'number' && item.parentIndex > 0) {
          episodes.add(episodeKey(item.parentIndex, item.index));
        }
      }
      logger.debug(`Plex: "${show.name}" — ${episodes.size} episode file(s) in library`);
      return { found: true, episodes };
    } catch (error: any) {
      logger.warn(`Plex: getShowEpisodes failed for "${show.name}": ${error.message}`);
      return null;
    }
  }
}

export const plexLibraryService = new PlexLibraryService();
