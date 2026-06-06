import type { ScrapedRelease } from '../scraper/constants';
export type { ScrapedRelease } from '../scraper/constants';

export type MediaType = 'movie' | 'show' | 'music';

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
 * Progress update emitted by a self-downloading plugin during fetchRelease.
 * Purely informational — the host may surface it (logs / SSE) or ignore it.
 */
export interface FetchProgress {
  /** 0..1 overall completion, when the plugin can estimate it. */
  ratio?: number;
  /** Human-readable status line (e.g. "3/12 tracks"). */
  message?: string;
  /** Live download rate in bytes/sec, when the plugin can measure it. */
  speedBps?: number;
  /** For multi-file (album) fetches: total number of tracks. */
  tracksTotal?: number;
  /** For multi-file (album) fetches: tracks fully written so far. */
  tracksDone?: number;
  /** Title of the track currently downloading (album fetches). */
  currentTrack?: string;
  /** Artist/act, when the source exposes it — for a richer UI. */
  artist?: string;
  /** Cover-art URL, when the source exposes it. */
  cover?: string;
}

/**
 * Outcome of a self-download (fetchRelease). `files` are absolute paths the
 * plugin wrote under the host-provided destination directory.
 */
export interface FetchResult {
  ok: boolean;
  files: string[];
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
  /**
   * Optional result kind for sources that distinguish container vs. single
   * item (e.g. music: 'album' | 'track'). Free-form; the UI may badge it.
   */
  kind?: string;
  /** Optional child count for container results (album track count, etc.). */
  count?: number;
  /**
   * Optional short provenance label the UI may render as a badge.
   *
   * For a plugin that queries several back-ends behind one id, this says which
   * one produced the hit, so the user can pick between otherwise identical
   * results. Free-form and purely decorative — the host attaches no meaning to
   * the value and never branches on it.
   */
  label?: string;
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
   * Optional: the plugin downloads a release ITSELF, instead of handing hoster
   * links to the host's downloader (JDownloader). Sources that own their whole
   * fetch pipeline — their own API + auth, no external hoster or container —
   * implement this; the host calls it in place of the JDownloader handoff when
   * the method is present.
   *
   * The host owns the destination directory and passes it in `opts.destDir`
   * (already created). The plugin writes one or more files there and returns
   * their absolute paths. Requires the `filesystem` permission (disclosure).
   *
   * Presence of this method marks a "self-downloading" plugin: the host routes
   * such plugins around resolveLinks / JDownloader entirely. Neutral — the host
   * knows nothing about how the plugin fetches, only that it does.
   */
  fetchRelease?(
    release: ScrapedRelease,
    opts: { destDir: string; onProgress?: (p: FetchProgress) => void },
  ): Promise<FetchResult>;

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

  /**
   * Optional deep-path probe ("canary"): exercise the FULL discovery path —
   * search, detail page, release extraction — against a fixed, permanently
   * available title the plugin chooses. A cheap healthCheck() can keep
   * succeeding while the release path is walled off (challenge/token gate),
   * and a queue of not-yet-released titles can't tell "nothing to find" from
   * "blocked"; the canary title always has releases, so reading zero IS the
   * block signature. Expensive (may drive a browser or challenge solver) —
   * the host calls it on a slow cadence, never per-title.
   */
  canaryCheck?(): Promise<PluginHealthOutcome>;

  /** Optional cleanup on shutdown. */
  close?(): Promise<void>;
}
