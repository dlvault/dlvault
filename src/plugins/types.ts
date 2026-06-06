import type { ScrapedRelease } from '../scraper/constants';
export type { ScrapedRelease } from '../scraper/constants';

export type MediaType = 'movie' | 'show';

/** Query passed to a plugin's findReleases / discover methods. */
export interface SearchQuery {
  title: string;
  year?: number;
  imdbId?: string;
  mediaType: MediaType;
  /** Alternate (e.g. localized) title for sources that index by it. */
  altTitle?: string;
}

/** A single hoster link — may be a direct file URL or an unresolved container. */
export interface HosterLink {
  hoster: string;
  url: string;
}

/**
 * Result of findReleases. `sourceUrl` is the canonical page on the source
 * (shown in the UI as "Quelle öffnen"). May be null for API-only sources.
 */
export interface ReleaseSet {
  sourceUrl: string | null;
  releases: ScrapedRelease[];
}

/** Optional discover entry (trending / featured item). */
export interface DiscoverItem {
  rank: number;
  title: string;
  year?: number;
  genres: string[];
  poster: string | null;
  /** Source-page URL — opened when the user clicks the entry. */
  url: string;
  description: string;
}

export interface PluginHealthOutcome {
  ok: boolean;
  critical: boolean;
  detail?: string;
  error?: string;
}

/**
 * A loose title match returned by a plugin's optional searchTitles method.
 * Used by disambiguation UIs (Telegram bot, manual search) to let the user
 * pick which film/show they meant before triggering the expensive
 * findReleases call.
 */
export interface TitleCandidate {
  title: string;
  year?: number;
  imdbId?: string | null;
  /** Thumbnail or poster URL (absolute). */
  poster?: string | null;
  /** Canonical source-page URL (opened on click). */
  url?: string;
  /** Plugin id that produced this candidate. Set by the registry aggregator. */
  pluginId?: string;
}

/**
 * A pluggable release source. Implementations may live in-tree (bundled with
 * the core) or be loaded from disk at runtime (Phase 3).
 *
 * Contract:
 *   - findReleases is the single entry point for "give me releases for X".
 *     Plugins decide internally whether to do search-then-listing or one-shot.
 *   - resolveLinks turns containers / redirect URLs into direct hoster URLs.
 *     No-op for plugins that always return resolved links (e.g. IA).
 *   - discover is optional; only plugins that surface trending content
 *     implement it. The host decides how to surface the results.
 */
export interface SourcePlugin {
  /** Stable identifier, kebab-case. Used in settings keys and logs. */
  readonly id: string;
  /** Human-readable name shown in the UI. */
  readonly name: string;
  /** Which media types this plugin can handle. */
  readonly mediaTypes: readonly MediaType[];
  /** Domains the plugin needs in the CSP image-src list (posters etc.). */
  readonly cspDomains?: readonly string[];

  /** Find releases matching the query. May return an empty release list. */
  findReleases(
    query: SearchQuery,
    opts?: { skipLinkResolution?: boolean },
  ): Promise<ReleaseSet>;

  /**
   * Resolve container / redirect links to direct hoster URLs.
   * Called by the scheduler before sending links to JDownloader.
   * Plugins that always return resolved links may return `links` as-is.
   */
  resolveLinks(links: HosterLink[]): Promise<HosterLink[]>;

  /**
   * Optional: return up to N title candidates for a free-text query — used by
   * disambiguation UIs (e.g. the Telegram bot's "which one did you mean?"
   * inline keyboard). Cheap relative to findReleases, no link resolution.
   */
  searchTitles?(query: string, opts?: { mediaType?: MediaType; limit?: number }): Promise<TitleCandidate[]>;

  /** Optional: trending / Top-N feed. */
  discover?(mediaType: MediaType): Promise<DiscoverItem[]>;

  /** Optional cached discover result (no network call). */
  getCachedDiscover?(mediaType: MediaType): DiscoverItem[] | null;

  /** Optional liveness probe. Aggregated into /api/health/deep. */
  healthCheck?(): Promise<PluginHealthOutcome>;

  /** Optional cleanup on shutdown. */
  close?(): Promise<void>;
}
