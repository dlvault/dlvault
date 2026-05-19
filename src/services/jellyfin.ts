import axios from 'axios';
import { getSetting } from '../database/index';
import { logger } from '../utils/logger';
import type { LibraryProvider, LibraryMovie, LibraryShowEpisodes } from './libraryProvider';
import { episodeKey } from './libraryProvider';

export type JellyfinMovie = LibraryMovie;

interface JellyfinItem {
  Id: string;
  Name: string;
  ProductionYear?: number;
  ProviderIds?: { Imdb?: string; Tmdb?: string };
  Overview?: string;
  Type?: string;
  ImageTags?: { Primary?: string };
}

export class JellyfinService implements LibraryProvider {
  private movieCache: JellyfinMovie[] = [];
  private movieCacheMap: Map<string, JellyfinMovie> = new Map();
  private lastFetch = 0;
  private lastFullFetch = 0;
  private userId: string | null = null;
  private refreshInProgress: Promise<JellyfinMovie[]> | null = null;
  private readonly CACHE_TTL = 10 * 60 * 1000; // 10 minutes (incremental check interval)
  private readonly FULL_REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour (full refresh to catch deletions)

  private getUrl(): string {
    return (getSetting('jellyfin.url') || '').replace(/\/+$/, '');
  }

  private getApiKey(): string {
    return getSetting('jellyfin.api_key') || '';
  }

  private async getUserId(): Promise<string | null> {
    if (this.userId) return this.userId;
    try {
      const res = await axios.get(`${this.getUrl()}/Users`, {
        headers: { 'X-Emby-Token': this.getApiKey() },
        timeout: 10000,
      });
      const users = res.data || [];
      if (users.length > 0) {
        // Prefer admin user, fallback to first user
        const admin = users.find((u: any) => u.Policy?.IsAdministrator) || users[0];
        this.userId = admin.Id;
        logger.info(`Jellyfin: using user "${admin.Name}" (${this.userId})`);
      }
    } catch (error: any) {
      logger.debug(`Jellyfin: could not get user ID: ${error.message}`);
    }
    return this.userId;
  }

  isConfigured(): boolean {
    return !!(this.getUrl() && this.getApiKey());
  }

  async testConnection(): Promise<{ success: boolean; serverName?: string; movieCount?: number }> {
    if (!this.isConfigured()) return { success: false };

    try {
      const res = await axios.get(`${this.getUrl()}/System/Info`, {
        headers: { 'X-Emby-Token': this.getApiKey() },
        timeout: 10000,
      });
      const movies = await this.fetchMovies();
      return {
        success: true,
        serverName: res.data.ServerName,
        movieCount: movies.length,
      };
    } catch (error: any) {
      logger.error(`Jellyfin connection failed: ${error.message}`);
      return { success: false };
    }
  }

  private mapItems(items: JellyfinItem[]): JellyfinMovie[] {
    return items.map((item) => ({
      id: item.Id,
      name: item.Name,
      year: item.ProductionYear || null,
      imdbId: item.ProviderIds?.Imdb || null,
      tmdbId: item.ProviderIds?.Tmdb || null,
      overview: item.Overview || null,
      mediaType: item.Type === 'Series' ? 'show' : 'movie',
      imageTag: item.ImageTags?.Primary || null,
    }));
  }

  private async fetchMovies(since?: Date): Promise<JellyfinMovie[]> {
    const userId = await this.getUserId();

    const params: Record<string, string | boolean> = {
      IncludeItemTypes: 'Movie,Series',
      Fields: 'ProviderIds,ProductionYear,Overview',
      Recursive: true,
    };

    if (since) {
      params.MinDateLastSaved = since.toISOString();
    }

    // Use user-scoped endpoint if we have a userId (ensures all libraries are visible)
    const endpoint = userId
      ? `${this.getUrl()}/Users/${userId}/Items`
      : `${this.getUrl()}/Items`;

    const res = await axios.get(endpoint, {
      headers: { 'X-Emby-Token': this.getApiKey() },
      params,
      timeout: 30000,
    });

    return this.mapItems(res.data.Items || []);
  }

  private rebuildCacheFromMap(): void {
    this.movieCache = Array.from(this.movieCacheMap.values());
  }

  private setFullCache(movies: JellyfinMovie[]): void {
    this.movieCacheMap.clear();
    for (const movie of movies) {
      this.movieCacheMap.set(movie.id, movie);
    }
    this.rebuildCacheFromMap();
  }

  private mergeIntoCache(movies: JellyfinMovie[]): void {
    for (const movie of movies) {
      this.movieCacheMap.set(movie.id, movie);
    }
    this.rebuildCacheFromMap();
  }

  async getMovies(forceRefresh = false): Promise<JellyfinMovie[]> {
    if (!this.isConfigured()) return [];

    const now = Date.now();

    // Return cached data if within incremental TTL and not forced
    if (!forceRefresh && this.movieCache.length > 0 && (now - this.lastFetch) < this.CACHE_TTL) {
      return this.movieCache;
    }

    // Prevent concurrent refreshes — coalesce into one request
    if (this.refreshInProgress) {
      return this.refreshInProgress;
    }

    this.refreshInProgress = this.doRefresh(forceRefresh, now);
    try {
      return await this.refreshInProgress;
    } finally {
      this.refreshInProgress = null;
    }
  }

  private async doRefresh(forceRefresh: boolean, now: number): Promise<JellyfinMovie[]> {
    const needsFullRefresh = forceRefresh
      || this.lastFullFetch === 0
      || (now - this.lastFullFetch) >= this.FULL_REFRESH_INTERVAL;

    try {
      if (needsFullRefresh) {
        const movies = await this.fetchMovies();
        this.setFullCache(movies);
        this.lastFullFetch = now;
        this.lastFetch = now;
        logger.info(`Jellyfin: full sync - ${this.movieCache.length} items in library`);
      } else {
        const since = new Date(this.lastFetch);
        const updated = await this.fetchMovies(since);
        if (updated.length > 0) {
          this.mergeIntoCache(updated);
          logger.info(`Jellyfin: incremental sync - ${updated.length} updated, ${this.movieCache.length} total`);
        } else {
          logger.debug?.(`Jellyfin: incremental sync - no changes`);
        }
        this.lastFetch = now;
      }
      return this.movieCache;
    } catch (error: any) {
      logger.error(`Jellyfin fetch error: ${error.message}`);
      return this.movieCache;
    }
  }

  clearCache(): void {
    this.movieCache = [];
    this.movieCacheMap.clear();
    this.lastFetch = 0;
    this.lastFullFetch = 0;
    this.userId = null;
  }

  getCachedMovieCount(): number {
    return this.movieCache.reduce((n, m) => n + (m.mediaType === 'movie' ? 1 : 0), 0);
  }

  async deleteItem(itemId: string): Promise<boolean> {
    if (!this.isConfigured()) return false;

    try {
      await axios.delete(`${this.getUrl()}/Items/${itemId}`, {
        headers: { 'X-Emby-Token': this.getApiKey() },
        timeout: 10000,
      });
      // Remove from cache
      this.movieCacheMap.delete(itemId);
      this.movieCache = this.movieCache.filter(m => m.id !== itemId);
      logger.info(`Jellyfin: deleted item ${itemId}`);
      return true;
    } catch (error: any) {
      logger.error(`Jellyfin delete failed: ${error.message}`);
      return false;
    }
  }

  async hasMovie(imdbId?: string | null, tmdbId?: number | null, title?: string, year?: number | null): Promise<boolean> {
    if (!this.isConfigured()) return false;

    const movies = await this.getMovies();

    // Check by IMDb ID (most reliable)
    if (imdbId) {
      const match = movies.find(m => m.imdbId === imdbId);
      if (match) {
        logger.debug(`Jellyfin match by IMDB ${imdbId}: "${match.name}"`);
        return true;
      }
    }

    // Check by TMDb ID
    if (tmdbId) {
      const tmdbStr = String(tmdbId);
      const match = movies.find(m => m.tmdbId === tmdbStr);
      if (match) {
        logger.debug(`Jellyfin match by TMDB ${tmdbId}: "${match.name}"`);
        return true;
      }
    }

    // Fallback: check by title + year
    if (title && year) {
      const normalizedTitle = title.toLowerCase().trim();
      const match = movies.find(m => m.name.toLowerCase().trim() === normalizedTitle && m.year === year);
      if (match) {
        logger.debug(`Jellyfin match by title+year "${title}" (${year}): "${match.name}"`);
        return true;
      }
    }

    // Last resort: title only
    if (title) {
      const normalizedTitle = title.toLowerCase().trim();
      const match = movies.find(m => m.name.toLowerCase().trim() === normalizedTitle);
      if (match) {
        logger.debug(`Jellyfin match by title "${title}": "${match.name}" (${match.year})`);
        return true;
      }
      // Log when no match found
      const close = movies.filter(m => m.name.toLowerCase().includes(normalizedTitle.substring(0, 5)));
      logger.debug(`Jellyfin: no match for "${title}" (imdb=${imdbId}, tmdb=${tmdbId}, year=${year}), ${movies.length} items in cache. Close: ${close.length > 0 ? close.map(m => `"${m.name}" imdb=${m.imdbId} tmdb=${m.tmdbId}`).join(', ') : 'none'}`);
    }

    return false;
  }

  /** Locate a show (Type='Series') in the cache using the same fallback chain as hasMovie. */
  private findShow(imdbId?: string | null, tmdbId?: number | null, title?: string, year?: number | null): JellyfinMovie | null {
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
      // Make sure the movie/show cache is warm so findShow can match.
      await this.getMovies();
    } catch {
      return null;
    }

    const show = this.findShow(imdbId, tmdbId, title, year);
    if (!show) {
      logger.debug(`Jellyfin: show "${title}" not in library (imdb=${imdbId}, tmdb=${tmdbId})`);
      return { found: false, episodes: new Set() };
    }

    try {
      const userId = await this.getUserId();
      const endpoint = userId
        ? `${this.getUrl()}/Users/${userId}/Items`
        : `${this.getUrl()}/Items`;

      const res = await axios.get(endpoint, {
        headers: { 'X-Emby-Token': this.getApiKey() },
        params: {
          ParentId: show.id,
          IncludeItemTypes: 'Episode',
          Recursive: true,
          Fields: 'IndexNumber,ParentIndexNumber',
        },
        timeout: 30000,
      });

      const episodes = new Set<string>();
      for (const item of (res.data?.Items || []) as { IndexNumber?: number; ParentIndexNumber?: number }[]) {
        if (typeof item.IndexNumber === 'number' && typeof item.ParentIndexNumber === 'number' && item.ParentIndexNumber > 0) {
          episodes.add(episodeKey(item.ParentIndexNumber, item.IndexNumber));
        }
      }
      logger.debug(`Jellyfin: "${show.name}" — ${episodes.size} episode file(s) in library`);
      return { found: true, episodes };
    } catch (error: any) {
      logger.warn(`Jellyfin: getShowEpisodes failed for "${show.name}": ${error.message}`);
      return null;
    }
  }
}

export const jellyfinService = new JellyfinService();
