import { getSetting } from '../database/index';
import { jellyfinService } from './jellyfin';
import { plexLibraryService } from './plexLibrary';
import { logger } from '../utils/logger';

/**
 * Common interface for media server library providers (Jellyfin, Plex).
 * All library checks in the app go through this abstraction.
 */
export interface LibraryMovie {
  id: string;
  name: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: string | null;
  overview: string | null;
  mediaType: string;
  imageTag: string | null;
}

export interface LibraryShowEpisodes {
  found: boolean;             // false = show itself not in library
  episodes: Set<string>;      // "S01E03" keys (zero-padded, uppercase)
}

export interface LibraryProvider {
  isConfigured(): boolean;
  hasMovie(imdbId?: string | null, tmdbId?: number | null, title?: string, year?: number | null): Promise<boolean>;
  getMovies(forceRefresh?: boolean): Promise<LibraryMovie[]>;
  /**
   * Synchronous count of movies currently in the in-memory cache (excludes
   * shows). Returns 0 when unconfigured or the cache hasn't been populated by
   * a sync yet — never triggers a fetch, safe to call from hot paths like the
   * status endpoint.
   */
  getCachedMovieCount(): number;
  /**
   * For a show: list the episode files actually present in the media library.
   * Returns null when the provider is unreachable or hits an error — callers
   * MUST treat null as "no information" (skip reconciliation), not as "empty".
   */
  getShowEpisodes(imdbId?: string | null, tmdbId?: number | null, title?: string, year?: number | null): Promise<LibraryShowEpisodes | null>;
  testConnection(): Promise<{ success: boolean; serverName?: string; movieCount?: number }>;
  deleteItem(id: string): Promise<boolean>;
  clearCache(): void;
}

/** Format a (season, episode) pair as the canonical "SxxEyy" key used by getShowEpisodes. */
export function episodeKey(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

export type LibraryProviderType = 'jellyfin' | 'plex';

export function getLibraryProviderType(): LibraryProviderType {
  return (getSetting('library.provider') || 'jellyfin') as LibraryProviderType;
}

export function getLibraryProvider(): LibraryProvider {
  const provider = getLibraryProviderType();
  if (provider === 'plex') return plexLibraryService;
  return jellyfinService;
}

/**
 * Get the display name for the current library provider.
 */
export function getLibraryProviderName(): string {
  return getLibraryProviderType() === 'plex' ? 'Plex' : 'Jellyfin';
}
