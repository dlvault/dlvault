import { ref } from 'vue';
import { getMovie } from '../api/index';
import { timeAgo, activityVerb, activityText, sourceHost } from './useFormatters';
import type {
  DetailContext, DownloadPackage, LibraryItem, Movie, MovieDetail,
  MovieStatus, PanelActivity, PanelCandidate, PanelFile, PanelMovie,
  PanelPipeline, PanelProduction, PanelProgress, PanelSeason, SearchCandidate,
} from '../types/index';

// ───── small formatting helpers ─────

export function qualityLabel(q?: string | null): string {
  if (!q) return '';
  if (/2160p|\buhd\b|\b4k\b/i.test(q)) return '4K';
  if (/1080p/i.test(q)) return '1080p';
  if (/720p/i.test(q)) return '720p';
  return q;
}

function formatRuntime(min?: number | null): string | null {
  if (!min || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatEtaShort(seconds?: number): string | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
function toGB(bytes: number): number { return Math.round((bytes / GB) * 10) / 10; }

// ───── activity / candidate mapping ─────

const SUCCESS_ACTIONS = new Set([
  'release_found', 'sent_to_jdownloader', 'download_finished',
  'extraction_finished', 'moved_to_library', 'library_import', 'quality_upgrade',
]);
const ERROR_ACTIONS = new Set([
  'not_found', 'error', 'jdownloader_error', 'jdownloader_failed',
  'captcha_pending', 'links_offline', 'download_stale', 'linkgrabber_stuck',
]);
const BUSY_ACTIONS = new Set([
  'search_started', 'resolving_links', 'extraction_started', 'sync_started',
]);

function toneOf(action: string): PanelActivity['tone'] {
  if (SUCCESS_ACTIONS.has(action)) return 'ok';
  if (ERROR_ACTIONS.has(action)) return 'err';
  if (BUSY_ACTIONS.has(action)) return 'busy';
  return undefined;
}

function mapActivity(detail: MovieDetail): PanelActivity[] {
  return (detail.logs || []).map(log => ({
    time: log.created_at ? timeAgo(log.created_at) : '',
    action: activityVerb(log.action),
    text: activityText(log.action, log.details),
    tone: toneOf(log.action),
  }));
}

function mapCandidates(cands?: SearchCandidate[]): PanelCandidate[] {
  return (cands || []).map(c => ({
    name: c.name,
    source: c.source,
    found: c.found,
    when: c.at ? timeAgo(c.at) : '',
  }));
}

// ───── section builders ─────

const STUCK_MS = 86_400_000; // 1 day

function buildPipeline(detail: MovieDetail, status: MovieStatus): PanelPipeline | undefined {
  const logs = detail.logs || [];
  const attempts = logs.filter(l => l.action === 'search_started').length;

  if (status === 'pending') {
    const ts = detail.last_checked_at || detail.added_at;
    const stuck = !!ts && (Date.now() - new Date(ts + 'Z').getTime()) > STUCK_MS;
    if (!stuck && attempts === 0) return undefined;
    return {
      stuck,
      attempts: attempts || detail.retry_count || 0,
      lastChecked: ts ? timeAgo(ts) : undefined,
    };
  }
  if (status === 'searching') {
    const lastSearch = logs.find(l => l.action === 'search_started');
    return {
      startedSearch: lastSearch?.created_at ? timeAgo(lastSearch.created_at) : undefined,
      attempt: attempts || 1,
    };
  }
  return attempts > 0 ? { attempts } : undefined;
}

function progressFromPackage(pkg: DownloadPackage, extracting: boolean): PanelProgress {
  if (extracting) {
    const pct = typeof pkg.extractionProgress === 'number' && pkg.extractionProgress > 0
      ? Math.round(pkg.extractionProgress) : 0;
    return { pct, loaded: toGB(pkg.bytesLoaded), total: toGB(pkg.bytesTotal), speed: 0, parts: 'wird entpackt', release: pkg.name };
  }
  const pct = pkg.bytesTotal > 0 ? Math.round((pkg.bytesLoaded / pkg.bytesTotal) * 100) : 0;
  return {
    pct,
    loaded: toGB(pkg.bytesLoaded),
    total: toGB(pkg.bytesTotal),
    speed: pkg.speed > 0 ? Math.round((pkg.speed / MB) * 10) / 10 : 0,
    eta: formatEtaShort(pkg.eta),
    release: pkg.name,
  };
}

function fileFromDetail(detail: MovieDetail): PanelFile | null {
  const dl = detail.downloads?.[0];
  const release = dl?.release_name || '';
  const src = sourceHost(detail.source_url) || dl?.hoster || '';
  if (!src && !release) return null;

  const codecMatch = release.match(/x265|x264|hevc|h\.?264|av1/i);
  const containerMatch = release.match(/\.(mkv|mp4|avi)$/i);
  return {
    src: src || 'unbekannt',
    codec: codecMatch ? codecMatch[0].toUpperCase().replace('X', 'x') : undefined,
    container: containerMatch ? containerMatch[1].toLowerCase() : undefined,
  };
}

function mapSeasons(detail: MovieDetail): PanelSeason[] | undefined {
  if (detail.media_type !== 'show' || !detail.seasons?.length) return undefined;
  return detail.seasons.map(s => ({
    number: s.season_number,
    downloaded: s.episodes_downloaded,
    aired: s.episodes_aired,
    notYetAired: s.episodes_not_yet_aired,
    missing: s.episodes_missing,
    complete: s.episodes_complete,
    status: s.status,
  }));
}

function productionFromDetail(detail: MovieDetail): PanelProduction | null {
  if (!detail.director && !detail.studio && !detail.country) return null;
  return {
    director: detail.director || '—',
    studio: detail.studio || '—',
    country: detail.country || '—',
  };
}

// ───── top-level assembly ─────

interface BuildOpts {
  context: DetailContext;
  status: MovieStatus;       // effective status (may be 'extracting'/'moved')
  pkg?: DownloadPackage | null;
  extracting?: boolean;
}

function panelFromDetail(detail: MovieDetail, opts: BuildOpts): PanelMovie {
  const { status, pkg, extracting } = opts;
  const showProgress = status === 'downloading' || status === 'extracting';
  const showFile = ['downloading', 'extracting', 'moved', 'downloaded'].includes(status);

  return {
    id: detail.id,
    title: detail.title,
    year: detail.year ?? undefined,
    imdb_id: detail.imdb_id,
    media_type: detail.media_type,
    status,
    quality: qualityLabel(detail.downloads?.[0]?.quality || detail.desired_quality),
    rating: detail.rating ?? undefined,
    runtime: formatRuntime(detail.runtime),
    plot: detail.plot ?? undefined,
    genres: detail.genres ? detail.genres.split(',').map(g => g.trim()).filter(Boolean) : undefined,
    added: opts.context === 'library' && detail.added_at ? timeAgo(detail.added_at) : undefined,
    pipeline: status === 'downloaded' ? undefined : buildPipeline(detail, status),
    candidates: status === 'searching' ? mapCandidates(detail.candidates) : undefined,
    progress: showProgress && pkg ? progressFromPackage(pkg, !!extracting) : undefined,
    file: showFile ? fileFromDetail(detail) : null,
    production: opts.context === 'library' ? productionFromDetail(detail) : null,
    seasons: mapSeasons(detail),
    activity: mapActivity(detail),
  };
}

// Minimal panel from a JDownloader package alone — used in the downloads view
// when the package can't be matched back to a queue movie.
function panelFromPackage(pkg: DownloadPackage, status: MovieStatus, extracting: boolean): PanelMovie {
  const m = (pkg.name || '').match(/^(.+?) \((\d{4})\)/);
  const title = m ? m[1] : pkg.name.replace(/\.(mkv|mp4|rar|zip|avi)$/i, '').replace(/[._]/g, ' ');
  const year = m ? Number(m[2]) : undefined;
  const showProgress = status === 'downloading' || status === 'extracting';
  return {
    id: pkg.uuid,
    title,
    year,
    status,
    quality: qualityLabel(pkg.name),
    progress: showProgress ? progressFromPackage(pkg, extracting) : undefined,
    file: { src: 'JDownloader', container: undefined, codec: undefined },
    activity: [],
  };
}

/**
 * Shared open/close state + async assembly for the unified DetailPanel.
 * Each view instantiates its own copy, renders <DetailPanel :movie :context>,
 * and wires the action emits (retry/delete/pause/...) to its own handlers.
 */
export function useDetailPanel() {
  const movie = ref<PanelMovie | null>(null);
  const context = ref<DetailContext>('queue');
  const loading = ref(false);

  function close() {
    movie.value = null;
  }

  // Queue: open from a queue Movie. Fetches full detail (metadata + logs +
  // candidates) and merges the live JD package for download/extract progress.
  async function openFromMovie(
    m: Movie,
    effectiveStatus: MovieStatus,
    pkg: DownloadPackage | null,
    extracting: boolean,
  ) {
    context.value = 'queue';
    loading.value = true;
    // Show a fast first paint from the list row while detail loads.
    movie.value = {
      id: m.id, title: m.title, year: m.year, imdb_id: m.imdb_id,
      status: effectiveStatus, quality: qualityLabel(m.desired_quality),
    };
    try {
      const res = await getMovie(m.id);
      movie.value = panelFromDetail(res.data, { context: 'queue', status: effectiveStatus, pkg, extracting });
    } catch {
      // Keep the minimal panel already shown.
    } finally {
      loading.value = false;
    }
  }

  // Downloads: open from a live package. Enriches with queue-movie metadata when
  // the package name maps to a known movie, otherwise renders package-only.
  async function openFromPackage(
    pkg: DownloadPackage,
    status: MovieStatus,
    extracting: boolean,
    matchedMovie: Movie | null,
  ) {
    context.value = 'downloads';
    if (!matchedMovie) {
      movie.value = panelFromPackage(pkg, status, extracting);
      return;
    }
    loading.value = true;
    movie.value = panelFromPackage(pkg, status, extracting);
    try {
      const res = await getMovie(matchedMovie.id);
      movie.value = panelFromDetail(res.data, { context: 'downloads', status, pkg, extracting });
    } catch {
      // Keep package-only panel.
    } finally {
      loading.value = false;
    }
  }

  // Library: open from a library item. Matches back to a queue movie for full
  // metadata/file/production; falls back to the item's own overview otherwise.
  async function openFromLibraryItem(item: LibraryItem, matchedMovie: Movie | null) {
    context.value = 'library';
    if (!matchedMovie) {
      movie.value = {
        id: item.id,
        title: item.name,
        year: item.year,
        imdb_id: item.imdbId ?? undefined,
        status: 'downloaded',
        plot: item.overview ?? undefined,
        activity: [],
        file: null,
        production: null,
        deepLinkUrl: item.deepLinkUrl ?? null,
      };
      return;
    }
    loading.value = true;
    movie.value = {
      id: item.id, title: item.name, year: item.year,
      imdb_id: item.imdbId ?? undefined, status: 'downloaded',
      plot: item.overview ?? undefined,
      deepLinkUrl: item.deepLinkUrl ?? null,
    };
    try {
      const res = await getMovie(matchedMovie.id);
      const panel = panelFromDetail(res.data, { context: 'library', status: 'downloaded' });
      if (!panel.plot && item.overview) panel.plot = item.overview;
      panel.deepLinkUrl = item.deepLinkUrl ?? null;
      movie.value = panel;
    } catch {
      // Keep the minimal item-only panel.
    } finally {
      loading.value = false;
    }
  }

  return { movie, context, loading, close, openFromMovie, openFromPackage, openFromLibraryItem };
}
