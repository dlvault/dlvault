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
  /**
   * When the item was added to the media server itself (Plex `addedAt`,
   * Jellyfin `DateCreated`), normalized to naive-UTC `YYYY-MM-DDTHH:mm:ss`
   * (the format the frontend treats as UTC by appending 'Z'). null when the
   * provider didn't supply one. This is the REAL library-add time — distinct
   * from dlvault's own import time (`movies.added_at`).
   */
  addedAt: string | null;
  /**
   * Real video quality of the library file as reported by the media server,
   * canonical '4K' | '1080p' | '720p' | 'SD'. null for shows (per-episode
   * quality varies; providers return no stream info on series items) and when
   * the provider supplied no dimensions. Distinct from movies.desired_quality,
   * which is the TARGET — the library UI should show what's actually on disk.
   */
  videoQuality: string | null;
}

/**
 * Canonical quality label from a video stream's pixel dimensions. Width is the
 * primary signal — scope/letterbox encodes shrink the HEIGHT (a 2.39:1 "1080p"
 * file is 1920×800), so height thresholds alone would misgrade cropped files.
 * Height is only a fallback for providers that omit width.
 */
export function videoQualityFromDimensions(width?: number | null, height?: number | null): string | null {
  if (width && width > 0) {
    if (width >= 3200) return '4K';
    if (width >= 1600) return '1080p';
    if (width >= 1000) return '720p';
    return 'SD';
  }
  if (height && height > 0) {
    if (height >= 1600) return '4K';
    if (height >= 800) return '1080p';
    if (height >= 520) return '720p';
    return 'SD';
  }
  return null;
}

/** Canonical label from Plex's `Media.videoResolution` ('4k'|'1080'|'720'|'sd'|'480'|…). */
export function videoQualityFromPlexResolution(res?: string | number | null): string | null {
  if (res == null || res === '') return null;
  const r = String(res).toLowerCase();
  if (r === '4k' || r === '2160') return '4K';
  if (r === '1080') return '1080p';
  if (r === '720') return '720p';
  return 'SD';
}

/**
 * Normalize a provider timestamp into the naive-UTC `YYYY-MM-DDTHH:mm:ss` form
 * the frontend date helpers expect (they append 'Z'). Accepts a Plex epoch in
 * SECONDS (number) or an ISO string like Jellyfin's `DateCreated`. Returns null
 * for missing/invalid input.
 */
export function toNaiveUtc(input: number | string | null | undefined): string | null {
  if (input == null || input === '') return null;
  const d = typeof input === 'number' ? new Date(input * 1000) : new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19);
}

export interface LibraryShowEpisodes {
  found: boolean;             // false = show itself not in library
  episodes: Set<string>;      // "S01E03" keys (zero-padded, uppercase)
}

export interface LibraryProvider {
  isConfigured(): boolean;
  /**
   * Is this title already in the media library?
   *
   * Returns null for "no information" — the provider is unreachable and the
   * cache is cold, so neither answer is known to be true. Callers that would
   * ACT on a false (queue a download, add the title as new) must treat null as
   * "skip this item for now": answering "not in the library" during an outage
   * sent titles that are already on disk back through the whole pipeline.
   */
  hasMovie(imdbId?: string | null, tmdbId?: number | null, title?: string, year?: number | null): Promise<boolean | null>;
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
