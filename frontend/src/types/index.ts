// Pipeline stages a movie/package can be in. The base API only ever stores the
// first six; 'extracting' and 'moved' are derived client-side from live
// JDownloader package state but share this union so the detail panel can map them.
export type MovieStatus =
  | 'pending' | 'searching' | 'found' | 'downloading'
  | 'extracting' | 'moved' | 'downloaded' | 'not_found'
  // Derived client-side from not_found_reason (see displayStatus) — the three
  // sub-buckets the queue splits "not_found" into. Never stored as movie.status.
  | 'not_available' | 'no_download' | 'quality_mismatch';

/** Sub-classification of a 'not_found' movie/season (mirrors the backend column). */
export type NotFoundReason = 'not_available' | 'no_download' | 'quality_mismatch';

/**
 * Per-title quality-filter override (mirrors movies.quality_override).
 * 'relaxed' = drop minimum resolution/audio + type exclusions, keep language;
 * 'any' = accept every release with links. null/absent = global filter.
 */
export type QualityOverride = 'relaxed' | 'any';

export interface Movie {
  id: number;
  title: string;
  year: number;
  imdb_id?: string;
  tmdb_id?: number;
  status: MovieStatus;
  /** Set by the backend while status === 'not_found'; null/absent otherwise. */
  not_found_reason?: NotFoundReason | null;
  desired_quality: string;
  source_url?: string;
  media_type?: 'movie' | 'show';
  last_checked_at?: string | null;
  added_at?: string | null;
  /** When it reached 'downloaded' (landed in the library). Stable across re-searches. */
  downloaded_at?: string | null;
  retry_count?: number;
  // Media metadata — populated lazily by the backend on first detail view.
  plot?: string | null;
  genres?: string | null;       // comma-separated, e.g. "Crime, Drama"
  rating?: number | null;        // 0–10
  runtime?: number | null;       // minutes
  director?: string | null;
  studio?: string | null;
  country?: string | null;
  /** Shows only: download seasons >= this number, skip the rest. null = all. */
  season_cutoff?: number | null;
  /** 1 while the integrity check is re-downloading an incomplete file → "Reparatur" badge. */
  repair?: number | null;
  /** Per-title quality-filter override — see QualityOverride. null = global filter. */
  quality_override?: QualityOverride | null;
}

export interface LogEntry {
  id: number;
  /** Backend joins movies and sends l.* — the id enables title → detail links. */
  movie_id?: number | null;
  movie_title?: string;
  action: string;
  details?: string;
  created_at: string;
}

export interface SyncStatus {
  schedulerRunning: boolean;
  syncRunning: boolean;
  totalMovies: number;
  libraryTotal: number;
  pending: number;
  searching: number;
  found: number;
  downloading: number;
  downloaded: number;
  notFound: number;
  weekDelta?: { added: number; completed: number };
}

export interface DownloadPackage {
  uuid: number;
  name: string;
  bytesLoaded: number;
  bytesTotal: number;
  speed: number;
  eta: number;
  running: boolean;
  finished: boolean;
  enabled: boolean;
  status?: string;
  statusIconKey?: string;
  saveTo?: string;
  isExtracting?: boolean;
  extractionProgress?: number;
  isMoved?: boolean;
}

export interface LibraryItem {
  id: string;
  name: string;
  year: number;
  mediaType: 'movie' | 'show';
  posterUrl?: string;
  imdbId?: string | null;
  tmdbId?: string | null;
  overview?: string | null;
  deepLinkUrl?: string | null;
  /** Real "added to media server" time from Plex/Jellyfin, naive-UTC
   *  `YYYY-MM-DDTHH:mm:ss` (append 'Z' to parse). Distinct from dlvault's
   *  own import time. null/absent when the provider didn't supply one. */
  addedAt?: string | null;
}

export interface ServiceStatus {
  connected: boolean;
  serverName?: string;
  username?: string;
  movieCount?: number;
}

export interface JDStatus {
  configured: boolean;
  connected: boolean;
  devices: { name: string }[];
  /** The configured device name (null = field empty, auto-pick first device). */
  deviceNameConfigured?: string | null;
  /** Device that will actually be used; null = configured name matched nothing. */
  selectedDevice?: string | null;
}

export interface TraktStatus {
  configured: boolean;
  authenticated: boolean;
  username: string;
}

export interface DownloadEntry {
  id: number;
  quality: string;
  release_name?: string;
  hoster?: string;
  download_url?: string;
  created_at?: string;
}

// A source release the pipeline considered. `at` is raw UTC; the panel renders relative.
export interface SearchCandidate {
  name: string;
  source: string;
  found: boolean;
  at: string;
  /** Why this round was rejected (filter-axis summary) — misses only. */
  rejectionReason?: string;
}

// Per-season availability summary the detail endpoint returns for shows.
// `episodes_aired` is the denominator ("8/10"), `episodes_not_yet_aired` are
// future episodes (not a gap), `episodes_missing` are aired-but-absent numbers.
export interface ApiSeasonSummary {
  season_number: number;
  status: string;
  episodes_downloaded: number;
  episodes_aired: number;
  episodes_total: number;
  episodes_not_yet_aired: number;
  episodes_missing: number[];
  episodes_complete: boolean;
  /** Below the show's season_cutoff — rendered dimmed as "übersprungen". */
  skipped?: boolean;
}

export interface MovieDetail extends Movie {
  added_at: string;
  downloads: DownloadEntry[];
  logs: LogEntry[];
  candidates?: SearchCandidate[];
  seasons?: ApiSeasonSummary[];
}

// ───── Unified detail-panel view-model ─────
// The DetailPanel is purely data-driven: each section shows based on which of
// these fields is present, never on which view opened it.
export type DetailContext = 'queue' | 'library' | 'downloads';

export interface PanelPipeline {
  stuck?: boolean;
  attempts?: number;
  lastChecked?: string;   // relative, e.g. "vor 2 Tagen"
  startedSearch?: string; // relative, e.g. "vor 12 s"
  attempt?: number;
}

export interface PanelCandidate {
  name: string;
  source: string;
  found: boolean;
  when: string;           // relative time
  reason?: string;        // filter rejection summary — misses only
}

export interface PanelProgress {
  pct: number;            // 0–100
  loaded: number;         // GB
  total: number;          // GB
  speed?: number;         // MB/s (0 / undefined when extracting)
  eta?: string;           // "41m"
  release?: string;       // JD release name
  parts?: string;         // e.g. "wird entpackt"
}

export interface PanelFile {
  path?: string;
  size?: string;          // "42.0 GB"
  codec?: string;         // "x265 HEVC"
  container?: string;     // "mkv"
  src: string;            // "archive.org"
}

export interface PanelProduction {
  director: string;
  studio: string;
  country: string;
}

export interface PanelActivity {
  time: string;           // relative
  action: string;         // short label, e.g. "found"
  text: string;
  tone?: 'ok' | 'err' | 'busy';
}

// One compact season row in the detail panel's "Staffeln" section.
export interface PanelSeason {
  number: number;
  downloaded: number;     // episodes present in the library
  aired: number;          // episodes aired (the "/Y" denominator)
  notYetAired: number;    // future episodes — shown as "+N", not a gap
  missing: number[];      // aired episode numbers not yet present
  complete: boolean;
  status: string;         // raw season status, used when no episode data exists
  skipped: boolean;       // below the show's cutoff — shown dimmed, not downloaded
}

export interface PanelMovie {
  id: number | string;
  title: string;
  year?: number;
  imdb_id?: string | null;
  media_type?: 'movie' | 'show';
  status: MovieStatus;
  quality?: string;       // '4K' | '1080p' | '720p' | ...
  rating?: number | null;
  runtime?: string | null;
  plot?: string | null;
  genres?: string[];
  added?: string;         // relative — shown in library context eyebrow
  pipeline?: PanelPipeline;
  candidates?: PanelCandidate[];
  progress?: PanelProgress;
  file?: PanelFile | null;
  production?: PanelProduction | null;
  activity?: PanelActivity[];
  seasons?: PanelSeason[];   // shows only — per-season availability
  seasonCutoff?: number | null;  // shows only — "download from season N", null = all
  deepLinkUrl?: string | null;
  // Concrete failure reason for a not_found sub-bucket (quality_mismatch /
  // no_download), pulled from the newest diagnostic log so the notice can show
  // it inline instead of pointing at the activity list.
  notFoundDetail?: string | null;
  // True when the source returned a page for this title (movie.source_url set).
  // Distinguishes "source has the title but no release" (e.g. takedown) from
  // "title not listed at the source at all" in the not_available notice.
  hasSource?: boolean;
  /** Per-title quality-filter override — drives the selector in the mismatch notice. */
  qualityOverride?: QualityOverride | null;
}

export interface DownloadReleasePayload {
  title: string;
  url: string;
  year?: number;
  quality?: string;
  hoster?: string;
}

export interface SSEPayload {
  [key: string]: unknown;
}
