import axios from 'axios';
import { getSetting } from '../database/index';
import { logger } from '../utils/logger';
import type { LibraryProvider, LibraryMovie, LibraryShowEpisodes, WatchedMovie } from './libraryProvider';
import { episodeKey, toNaiveUtc, videoQualityFromPlexResolution, plexExternalIds } from './libraryProvider';

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
  /** Legacy-agent single id ("com.plexapp.agents.imdb://tt…?lang=de"). */
  guid?: string;
  /** Unix epoch (SECONDS) when the item was added to the Plex library. */
  addedAt?: number;
  /** Present on movie items; show items carry no Media element. */
  /** Times the token's account finished it / where it stopped / last view (epoch s). */
  viewCount?: number;
  viewOffset?: number;
  lastViewedAt?: number;
  Media?: { videoResolution?: string | number; Part?: { file?: string }[] }[];
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
        const ids = plexExternalIds(item);

        items.push({
          id: item.ratingKey,
          name: item.title,
          year: item.year || null,
          imdbId: ids.imdbId,
          tmdbId: ids.tmdbId,
          tvdbId: ids.tvdbId,
          watched: (item.viewCount ?? 0) > 0 || (item.viewOffset ?? 0) > 0 || !!item.lastViewedAt,
          overview: item.summary || null,
          mediaType: sectionType === 'show' ? 'show' : 'movie',
          imageTag: item.thumb || null,
          addedAt: toNaiveUtc(item.addedAt),
          videoQuality: videoQualityFromPlexResolution(item.Media?.[0]?.videoResolution),
          files: (item.Media || []).flatMap(md => (md.Part || []).map(pt => pt.file || '')).filter(Boolean),
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
    // No movie/show section at all is a server still starting or a token that
    // cannot see the libraries — not an empty library. Fail the fetch so the
    // cache stays cold ("membership unknown") instead of "owns nothing".
    if (sections.length === 0) throw new Error('no movie/show library sections visible to this token');
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
      // An answer that is empty, or a fraction of what the library held a
      // moment ago, is a Plex that is starting up, a token that lost access to
      // its sections, or a section mid-rescan — not a library that lost its
      // titles. Taken as truth it said "not owned" for everything and the whole
      // library went back into the download queue.
      // Three such answers in a row (a minute apart) are the library itself —
      // a removed section, a big clean-up — and are accepted, or the stale list
      // stayed until the next restart.
      const before = this.movieCache.length;
      if (before >= 20 && movies.length < before * 0.5 && this.shrinkStreak < 2) {
        this.shrinkStreak++;
        logger.warn(`Plex library: answer has ${movies.length} items, cache had ${before} — keeping the cache, retrying later`);
        this.lastFetch = now - this.CACHE_TTL + 60_000; // try again in a minute
        return this.movieCache;
      }
      this.shrinkStreak = 0;

      this.movieCacheMap.clear();
      for (const movie of movies) {
        this.movieCacheMap.set(movie.id, movie);
      }
      this.movieCache = Array.from(this.movieCacheMap.values());
      this.lastFetch = now;
      this.lastFullFetch = now;
      logger.info(`Plex library: synced ${this.movieCache.length} items`);
      this.cacheWarm = true;
      return this.movieCache;
    } catch (error: any) {
      logger.error(`Plex library fetch error: ${error.message}`);
      return this.movieCache;
    }
  }

  /**
   * True once a fetch has actually succeeded since the last clearCache().
   *
   * Without this, a failed fetch is indistinguishable from an empty library:
   * doRefresh swallows the error and returns the (empty) cache, so right after a
   * restart with Plex down, hasMovie() answered "not in library" for everything
   * and the scheduler happily re-downloaded titles already on disk.
   */
  private cacheWarm = false;
  /** Consecutive answers far smaller than the cache (see doRefresh). */
  private shrinkStreak = 0;

  isCacheWarm(): boolean {
    return this.cacheWarm;
  }

  clearCache(): void {
    this.movieCache = [];
    this.movieCacheMap.clear();
    this.lastFetch = 0;
    this.lastFullFetch = 0;
    this.cacheWarm = false;
    this.shrinkStreak = 0;
  }

  getCachedMovieCount(): number {
    return this.movieCache.reduce((n, m) => n + (m.mediaType === 'movie' ? 1 : 0), 0);
  }

  /**
   * Rescan every movie/show section. Plex only notices new files by itself
   * when "scan automatically" works — on Docker volumes and network shares it
   * often does not, and an imported title stayed invisible until the next
   * scheduled scan. A section refresh only walks changed folders.
   */
  async refreshLibrary(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const sections = await this.getLibrarySections();
      for (const section of sections) {
        await axios.get(`${this.getServerUrl()}/library/sections/${section.key}/refresh`, {
          headers: this.getHeaders(),
          timeout: 10000,
        });
      }
      logger.debug(`Plex: rescan requested for ${sections.length} section(s)`);
      // The next membership check should see the new item, not a 10-minute-old cache.
      this.lastFetch = 0;
      return sections.length > 0;
    } catch (error: any) {
      logger.debug(`Plex: could not request a rescan: ${error?.message || error}`);
      return false;
    }
  }

  /**
   * Films the server account has watched or started — straight from the
   * library listing (viewCount / viewOffset / lastViewedAt), so no extra
   * request. Plex keeps watch state per account; the owner's token is the one
   * dlvault holds, which is the household that deletes films.
   */
  async getWatchedMovies(): Promise<WatchedMovie[] | null> {
    if (!this.isConfigured()) return null;
    const items = await this.getMovies(true);
    if (!this.cacheWarm) return null;
    // `watched` is the token's own account only. The play history covers every
    // account on the server (like Jellyfin's all-users check) — a household
    // member who watched a film and deleted it must not leave it "unexplained".
    const played = await this.playedRatingKeys();
    return items
      .filter(m => m.mediaType === 'movie' && (m.watched || played.has(m.id)))
      .map(m => ({ imdbId: m.imdbId, tmdbId: m.tmdbId, name: m.name, year: m.year, files: m.files }));
  }

  /** ratingKeys of films anyone played (play history, all accounts). Empty on failure. */
  private async playedRatingKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    const size = 500;
    try {
      for (let start = 0, page = 0; page < 40; page++, start += size) {
        const res = await axios.get(`${this.getServerUrl()}/status/sessions/history/all`, {
          headers: { ...this.getHeaders(), 'X-Plex-Container-Start': String(start), 'X-Plex-Container-Size': String(size) },
          timeout: 30000,
        });
        const rows: { ratingKey?: string | number; type?: string }[] = res.data?.MediaContainer?.Metadata || [];
        for (const r of rows) if (r.type === 'movie' && r.ratingKey != null) keys.add(String(r.ratingKey));
        if (rows.length < size) break;
      }
    } catch (err: any) {
      logger.debug(`Plex play history unavailable: ${err?.message || err}`);
    }
    return keys;
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

  async hasMovie(imdbId?: string | null, tmdbId?: number | null, title?: string, year?: number | null): Promise<boolean | null> {
    if (!this.isConfigured()) return false;

    const movies = await this.getMovies();
    // "The fetch failed" must not be reported as "not in the library" — that
    // answer sends already-owned titles back through the whole download pipeline.
    if (!this.cacheWarm) {
      logger.warn('Plex library cache is cold (last fetch failed) — library membership is unknown');
      return null;
    }

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

    // Title fallbacks must only consider films: the cache carries shows as well,
    // so matching across types let the series "Kettleby" answer for the film.
    const films = movies.filter(m => m.mediaType !== 'show');

    if (title && year) {
      const normalizedTitle = title.toLowerCase().trim();
      const match = films.find(m => m.name.toLowerCase().trim() === normalizedTitle && m.year === year);
      if (match) {
        logger.debug(`Plex match by title+year "${title}" (${year}): "${match.name}"`);
        return true;
      }
    }

    // Plex guessed the WRONG film for the file ("Grell (2026).mkv" became
    // "The Grell"): its ids and title then match nothing, and a request for
    // a film already on disk was downloaded again. dlvault named the file
    // itself — "Title (Year)" at the start of the file or folder name still
    // says which film it is.
    if (title && year) {
      const byFile = films.find(m => fileNamesTitle(m.files, title, year));
      if (byFile) {
        logger.debug(`Plex match by file name "${title}" (${year}): Plex calls it "${byFile.name}"`);
        return true;
      }
    }

    // Title-only is a last resort for entries with no year at all. When a year IS
    // known, a same-title different-year film is a different film (remakes), and
    // accepting it here marked the wrong one as already owned.
    if (title && !year) {
      const normalizedTitle = title.toLowerCase().trim();
      const match = films.find(m => m.name.toLowerCase().trim() === normalizedTitle);
      if (match) {
        logger.debug(`Plex match by title "${title}": "${match.name}" (${match.year})`);
        return true;
      }
    }

    return false;
  }

  private findShow(
    imdbId?: string | null, tmdbId?: number | null, title?: string, year?: number | null, tvdbId?: number | null,
  ): LibraryMovie | null {
    const shows = this.movieCache.filter(m => m.mediaType === 'show');
    if (tvdbId) {
      const m = shows.find(s => s.tvdbId === String(tvdbId));
      if (m) return m;
    }
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
      // Title alone only when one side has no year — "Shōgun" (2024) is not
      // "Shōgun" (1980), and its episodes would have counted as present.
      const m = shows.find(s => s.name.toLowerCase().trim() === norm && (!year || !s.year));
      if (m) return m;
    }
    return null;
  }

  async getShowEpisodes(
    imdbId?: string | null, tmdbId?: number | null, title?: string, year?: number | null, tvdbId?: number | null,
  ): Promise<LibraryShowEpisodes | null> {
    if (!this.isConfigured()) return null;

    try {
      await this.getMovies();
    } catch {
      return null;
    }
    if (!this.cacheWarm) return null;   // unknown, not "show missing"

    const show = this.findShow(imdbId, tmdbId, title, year, tvdbId);
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

/** Lower-case, umlauts kept, everything that is not a letter/digit → one space. */
export function normalizeName(s: string): string {
  return s.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A file or its folder is named "Title (Year)…" (dlvault's naming, or a scene name). */
export function fileNamesTitle(files: string[] | undefined, title: string, year: number): boolean {
  if (!files || files.length === 0) return false;
  const want = `${normalizeName(title)} ${year}`;
  return files.some(f => {
    const parts = f.split(/[\\/]/);
    const base = (parts.pop() || '').replace(/\.[^.]+$/, '');
    const folder = parts.pop() || '';
    return normalizeName(base).startsWith(want) || normalizeName(folder).startsWith(want);
  });
}
