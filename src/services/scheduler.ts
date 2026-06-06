import cron, { type ScheduledTask } from 'node-cron';
import pLimit from 'p-limit';
import { getSetting } from '../database/index';
import db from '../database/index';
import { getAllMovies, getMoviesByStatus, getMovieById, updateMovieStatus, updateLastChecked, incrementRetryCount, resetRetryCount, setRepairFlag, Movie } from '../database/services/movies';
import { addDownload, getDownloadsByMovieId, getDownloadsByMovieIds, updateDownloadStatusByMovieId, updateDownloadStatusBySeason, type Download } from '../database/services/downloads';
import { addLogEntry } from '../database/services/activityLog';
import { getSeasonsByShowId, getSeasonsByShowIds, updateSeasonStatus, updateSeasonLastChecked, updateSeasonEpisodeCount, Season } from '../database/services/seasons';
import { getEpisodesBySeasonId, getPendingEpisodes, addEpisodes, updateEpisodeStatus, getSeasonCompletionStatus, Episode } from '../database/services/episodes';
import { traktService } from './trakt';
import { plexService } from './plex';
import { seerrService } from './seerr';
// Dependency-free guard sets (no import cycle with trakt/plex/postprocess).
// Re-exported so existing importers (telegram, tests) keep working unchanged.
import { processingMovies, upgradingMovies } from './processingState';
export { processingMovies, upgradingMovies };
import type { ScrapedRelease } from '../scraper/constants';
import { QUALITY_RANK } from '../scraper/constants';
import { filterReleases, filterReleasesWithStats } from '../scraper/filter';
import { pluginRegistry } from '../plugins/registry';
import { withPluginTimeout, PLUGIN_TIMEOUTS } from '../plugins/timeout';
import type { SourcePlugin, HosterLink, PluginHealthOutcome } from '../plugins/types';
import { jdownloaderService } from '../jdownloader/index';
import { getLibraryProvider, getLibraryProviderName } from './libraryProvider';
import { enrichMovieMetadata, resolveMovieImdbId } from './metadata';
import { runIntegrityCheck, runAudioLanguageCheck } from './integrityCheck';
import { logger } from '../utils/logger';
import { toSqliteUtc, parseUtcDate } from '../utils/datetime';
import { incrementMetric, setMetric } from './metrics';
import { eventBus } from './eventbus';
import { isReleaseBlocklisted, addBlocklistEntry } from '../database/services/blocklist';
import { getGermanTitleFromWikidata } from './wikidata';
import { reconcileEpisodesWithLibrary } from './libraryReconcile';

/**
 * Blocklist a release JD's pre-download online-check found entirely dead (every
 * link offline at the hoster), so the next search skips it instead of resolving
 * the same dead links again. Mirrors the reactive guard in postprocess.ts.
 */
function blocklistDeadOnAdd(entity: { id: number; title: string }, releaseTitle: string | undefined | null): void {
  if (!releaseTitle || isReleaseBlocklisted(releaseTitle)) return;
  try {
    addBlocklistEntry({
      release_name: releaseTitle,
      title: entity.title,
      reason: 'auto: alle Links offline beim Hoster (vor Download geprüft)',
      movie_id: entity.id,
    });
    logger.info(`Pre-download guard: blocklisted dead release "${releaseTitle}" (${entity.title})`);
  } catch (e: any) {
    logger.debug(`Failed to blocklist "${releaseTitle}": ${e.message}`);
  }
}

let scheduledTask: ScheduledTask | null = null;
let healthMonitorTask: ScheduledTask | null = null;
let jdMonitorTask: ScheduledTask | null = null;
let jdMonitorStartupTimer: NodeJS.Timeout | null = null;
let watchlistMonitor: NodeJS.Timeout | null = null;
let watchlistStartupTimer: NodeJS.Timeout | null = null;
let retryMonitorTask: ScheduledTask | null = null;
let retryMonitorRunning = false;
let canaryMonitorTask: ScheduledTask | null = null;
let isRunning = false;

// Canary monitor state — last deep-path probe outcome per plugin, plus whether
// we already alerted for the current outage (alert once per outage, mirroring
// the JD offline alert; a success resets the flag and notifies recovery).
interface CanaryState {
  ok: boolean;
  error: string | null;
  detail: string | null;
  lastRunAt: number;
  alerted: boolean;
}
const canaryStates = new Map<string, CanaryState>();

// Health monitor state — rate-limit alerts so we don't spam Telegram every 15
// minutes for the same ongoing outage.
let lastHealthAlertAt = 0;
let lastHealthAlertOverall: string | null = null;
const HEALTH_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour per status

// JD monitor state — tracks reachability + update availability between ticks so
// the dashboard can read a cached value and the offline alert fires only on the
// reachable→unreachable transition (not every tick during an outage).
let jdLastReachable: boolean | null = null; // null = not yet probed (startup)
let jdOfflineAlertedAt = 0;
let jdConsecutiveFailures = 0; // reachability probe failures in a row (debounce)
let jdOfflineAlerted = false;  // already alerted for the current outage?
let jdUpdateAvailable = false;
let jdLastUpdateCheckAt = 0;
let jdUpdateSuppressedUntil = 0; // ignore JD's update flag until this time (post user-triggered update)
const JD_OFFLINE_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
// Require 2 consecutive failed probes (~5 min apart) before alerting. A single
// transient MyJDownloader *cloud-relay* timeout — JD itself running fine, the
// probe just times out and reconnects on the next tick — must not fire the
// scary "JD wurde beendet, bitte neu starten" message. Real outages persist and
// still alert within ~10 min; recovery auto-resume is unaffected.
const JD_OFFLINE_ALERT_THRESHOLD = 2;
const JD_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // nudge JD's own check ~4×/day
const JD_UPDATE_SUPPRESS_MS = 15 * 60 * 1000; // grace window after restartAndUpdate

/** Test helper — reset cooldown state so tests can exercise multiple alerts. */
export function _resetHealthMonitorState(): void {
  lastHealthAlertAt = 0;
  lastHealthAlertOverall = null;
}

/** Test helper — reset canary monitor state between tests. */
export function _resetCanaryMonitorState(): void {
  canaryStates.clear();
}

/** Cached canary snapshot for /api/health/detailed (no live probe). */
export function getCanaryState(): Record<string, { ok: boolean; error: string | null; detail: string | null; lastRunAt: number }> {
  return Object.fromEntries(
    [...canaryStates].map(([id, s]) => [id, { ok: s.ok, error: s.error, detail: s.detail, lastRunAt: s.lastRunAt }]),
  );
}

/** Test helper — reset JD monitor state between tests. */
export function _resetJdMonitorState(): void {
  jdLastReachable = null;
  jdOfflineAlertedAt = 0;
  jdConsecutiveFailures = 0;
  jdOfflineAlerted = false;
  jdUpdateAvailable = false;
  jdLastUpdateCheckAt = 0;
  jdUpdateSuppressedUntil = 0;
}

/**
 * Called when the user triggers a JD self-update from the dashboard. JD's own
 * isUpdateAvailable flag lingers `true` after restartAndUpdate — JD only clears it
 * once it re-evaluates against the freshly installed version, which left the
 * dashboard banner stuck until the next internal check. So: optimistically clear
 * the badge, suppress re-showing it for a grace window (covers the restart + JD's
 * settle time), and force a fresh runUpdateCheck on the next monitor tick so the
 * flag re-affirms rather than reading a stale value.
 */
export function notifyJdUpdateTriggered(): void {
  jdUpdateAvailable = false;
  jdUpdateSuppressedUntil = Date.now() + JD_UPDATE_SUPPRESS_MS;
  jdLastUpdateCheckAt = 0; // force runUpdateCheck on next tick once JD is back
}

/** Cached JD monitor snapshot for the dashboard (no live JD call). */
export function getJdMonitorState(): { updateAvailable: boolean; reachable: boolean | null } {
  return { updateAvailable: jdUpdateAvailable, reachable: jdLastReachable };
}

/** Test helper — clear the per-sync caches that otherwise leak between unit tests. */
export function _resetSyncCaches(): void {
  cachedJdPackages = null;
  jdPackageProbeFailed = false;
  libraryPreloaded = false;
}
// Shows we've already attempted a Trakt id-lookup season-backfill for this
// process. Prevents re-hitting Trakt every cycle for a trakt-id-less show whose
// id Trakt can't resolve (resolved ones seed their seasons once; we don't
// persist the trakt_id — see backfillShowSeasons). Resets on restart.
const seasonBackfillTried = new Set<number>();
const movieQueue = pLimit(3); // Shared concurrency limiter for all movie processing

/**
 * True if a show already has at least one season that's downloaded or actively
 * downloading. Used to stop a fruitless source search from clobbering the whole
 * show to 'not_found' — that status hides the show from the post-processor and
 * strands already-downloaded episodes on disk (e.g. a finished S01 pack waiting
 * to be moved while a later empty search flipped the show to not_found).
 */
function showHasSeasonProgress(movieId: number): boolean {
  return getSeasonsByShowId(movieId).some(s => s.status === 'downloaded' || s.status === 'downloading');
}

/**
 * Defensive filter for plugin output: drop entries whose `hoster` or `url` is
 * missing/empty/non-string. A malformed link silently inserted into the
 * downloads table becomes invisible breakage — the row sits forever with a
 * useless URL — so we reject it at the host boundary and log loudly.
 */
function validateHosterLinks(links: HosterLink[], pluginId: string): HosterLink[] {
  return links.filter(l => {
    const ok = !!l
      && typeof l.hoster === 'string' && l.hoster.length > 0
      && typeof l.url === 'string' && l.url.length > 0;
    if (!ok) {
      logger.warn(`Plugin "${pluginId}" returned malformed HosterLink, dropping: ${JSON.stringify(l)}`);
    }
    return ok;
  });
}

/**
 * Resolve a release's container / redirect links to direct hoster URLs via the
 * source plugin. Done *after* quality filtering so captcha budget is only ever
 * spent on a release the user actually wants — not on the highest-quality
 * candidate that then gets rejected by the filter.
 *
 * The plugin's resolveLinks is the source of truth: plugins that already return
 * direct links echo them back (no-op), plugins with container links resolve
 * them. We therefore trust its output and never fall back to the unresolved
 * input — returning those would send raw container/redirect URLs to JDownloader.
 * Mutates `release.links` to the resolved set; returns direct URLs for enabled
 * hosters (empty if resolution failed).
 */
async function resolveReleaseLinks(
  release: ScrapedRelease,
  activePlugin: SourcePlugin | null,
  enabledHosters: string[],
): Promise<string[]> {
  const allowed = (h: string) => enabledHosters.length === 0 || enabledHosters.includes(h);
  const candidates = release.links.filter(l => allowed(l.hoster));
  if (candidates.length === 0) return [];
  if (!activePlugin) return candidates.map(l => l.url);
  const resolved = validateHosterLinks(await withPluginTimeout('resolveLinks', PLUGIN_TIMEOUTS.resolveLinks, activePlugin.resolveLinks(candidates)), activePlugin.id);
  release.links = resolved;
  return resolved.filter(l => allowed(l.hoster)).map(l => l.url);
}

// Per-sync caches — populated once at sync start, cleared at end
let cachedJdPackages: { name: string; bytesTotal?: number; childCount?: number }[] | null = null;
/**
 * Negative cache for the snapshot above: set when the probe failed, so the rest
 * of the pass skips the duplicate check instead of re-timing-out per movie.
 * Cleared wherever cachedJdPackages is.
 */
let jdPackageProbeFailed = false;
let libraryPreloaded = false;

/**
 * If the active library provider (library.provider) isn't configured but the OTHER
 * media server IS, the user almost certainly picked the wrong provider — dlvault
 * then can't see the library and re-fetches titles it already has. Warn clearly
 * (once per full sync) instead of silently skipping the library check.
 */
function warnIfLibraryProviderMismatch(): void {
  const active = getLibraryProvider();
  if (active.isConfigured()) return;
  const activeName = getLibraryProviderName();
  const jellyfinSet = !!(getSetting('jellyfin.url') && getSetting('jellyfin.api_key'));
  const plexSet = !!(getSetting('plex.server_url') && getSetting('plex.token'));
  const otherConfigured = (activeName === 'Plex' && jellyfinSet) || (activeName === 'Jellyfin' && plexSet);
  if (otherConfigured) {
    logger.warn(`library.provider is set to "${activeName}", but ${activeName} is not configured while the other media server IS. dlvault can't check your library and may re-download titles you already have — pick the correct provider in Settings -> Media Server.`);
  }
}

/**
 * The sync cadence the user configured, in hours.
 *
 * Shared with startScheduler so the backoff can never pace a title *slower*
 * than the interval that was asked for. Same clamp: the value arrives from
 * PATCH /api/settings, which only prefix-validates keys.
 */
function configuredIntervalHours(): number {
  const raw = parseInt(getSetting('scheduler.interval_hours') || '24', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 24;
}

export async function processMovie(movie: Movie): Promise<void> {
  // Prevent duplicate processing of the same movie
  if (processingMovies.has(movie.id)) {
    logger.debug(`Skipping ${movie.title} - already being processed`);
    return;
  }
  processingMovies.add(movie.id);

  // Re-read from DB — the passed object may be a stale snapshot (status could have changed)
  const freshMovie = getMovieById(movie.id);
  if (!freshMovie) {
    logger.warn(`${movie.title}: movie no longer exists in DB — aborting`);
    processingMovies.delete(movie.id);
    return;
  }

  // Skip movies that are already found/downloading/downloaded
  // For shows: always re-process to detect new seasons/episodes (cheap — no captcha until download)
  if (['found', 'downloading', 'downloaded'].includes(freshMovie.status)) {
    if (freshMovie.media_type === 'show') {
      // Shows always get re-checked — new seasons/episodes may have appeared
      logger.info(`${freshMovie.title} is ${freshMovie.status} — re-checking for new seasons/episodes`);
    } else {
      logger.debug(`Skipping ${freshMovie.title} - already ${freshMovie.status}`);
      processingMovies.delete(movie.id);
      return;
    }
  }

  /**
   * Where dlvault stops expecting a title *soon* — but not where it stops
   * looking.
   *
   * This used to return outright, which abandoned the title for good. On a live
   * instance that left 18 of 29 not-found titles frozen, eight of them last
   * searched over a month earlier — and they were films like "The Beekeeper 2
   * (2027)" that simply had not been released yet. "Not found ten times" is no
   * evidence about an unreleased film; it only measures how long it has been
   * waiting. Watching for exactly those is the point of the tool.
   *
   * So the wind-down still happens once, at the crossing, and then the ordinary
   * backoff below takes over. It caps at 48 h, which is a sensible standing
   * watch: one query every two days, indefinitely.
   */
  const MAX_RETRIES = 10;
  if (freshMovie.retry_count === MAX_RETRIES) {
    logger.info(`${freshMovie.title}: ${MAX_RETRIES} attempts without a release — continuing on the configured ${configuredIntervalHours()}h cadence`);
    // Let whoever requested this via Telegram know it isn't coming soon
    // (once-only, deduped inside notifyGaveUp). Best-effort — never block the tick.
    try {
      const { notifyGaveUp } = await import('./telegram');
      await notifyGaveUp(freshMovie);
    } catch (err: any) {
      logger.debug(`notifyGaveUp failed for ${freshMovie.title}: ${err.message}`);
    }
    // A repair that never completed has to be closed out here, or the title
    // stays flagged forever — and since the repair flag now also makes the
    // library check skip it, that protection would turn into a permanent blind
    // spot. Put the old copy back, drop the flag, and say so in Seerr.
    if (freshMovie.repair === 1) {
      try {
        const { restoreQuarantinedFiles, reportGiveUp } = await import('./seerrIssues');
        const restored = restoreQuarantinedFiles(freshMovie);
        setRepairFlag(freshMovie.id, false);
        addLogEntry(freshMovie.id, 'repair_abandoned',
          `Reparatur aufgegeben — ${restored} Datei(en) wiederhergestellt`);
        await reportGiveUp(freshMovie, restored);
      } catch (err: any) {
        logger.debug(`Repair wind-down failed for ${freshMovie.title}: ${err.message}`);
      }
    } else {
      try {
        const { reportGiveUp } = await import('./seerrIssues');
        await reportGiveUp(freshMovie, 0);
      } catch (err: any) {
        logger.debug(`Give-up report failed for ${freshMovie.title}: ${err.message}`);
      }
    }
    // Deliberately no return: the backoff below paces it from here on.
  }

  // Exponential backoff: skip if not enough time has passed since last check
  if (freshMovie.retry_count > 0 && freshMovie.last_checked_at) {
    const lastChecked = parseUtcDate(freshMovie.last_checked_at);
    // Doubles 1h, 2h, 4h … but never past the configured sync interval. A fixed
    // 48h ceiling meant a title that had been waiting a while was checked HALF
    // as often as the user had asked for — the backoff quietly overrode the
    // setting. The scheduler decides the cadence; this only slows the first few
    // attempts after a fresh failure.
    const backoffHours = Math.min(Math.pow(2, freshMovie.retry_count - 1), configuredIntervalHours());
    const nextRetryAt = lastChecked + backoffHours * 60 * 60 * 1000;
    if (Date.now() < nextRetryAt) {
      logger.debug(`Skipping ${freshMovie.title} - backoff (retry ${freshMovie.retry_count}, next in ${Math.round((nextRetryAt - Date.now()) / 3600000)}h)`);
      processingMovies.delete(movie.id);
      return;
    }
  }

  // Skip if already exists in media server library (uses pre-loaded cache from sync start)
  // For shows: only skip if the show exists AND all wanted seasons are present (checked later per-season)
  const isShow = freshMovie.media_type === 'show';

  // A show added without a Trakt id (Telegram free-text / source-by-title) has no
  // "should-exist" baseline, so missing seasons/episodes can never be detected —
  // the DB only ever learns what the source or library happened to reveal. If we
  // have an imdb/tmdb id, resolve the Trakt id once and seed the full aired
  // season/episode list; reconcile + per-season processing then know what's still
  // missing. Best-effort and non-blocking; the resolved id is NOT persisted (keeps
  // the show protected from watchlist-driven deletion — see backfillShowSeasons).
  if (isShow && !freshMovie.trakt_id && (freshMovie.imdb_id || freshMovie.tmdb_id)
      && !seasonBackfillTried.has(freshMovie.id) && traktService.isConfigured()) {
    seasonBackfillTried.add(freshMovie.id);
    try {
      await traktService.backfillShowSeasons(freshMovie.id, freshMovie.imdb_id, freshMovie.tmdb_id);
    } catch (err: any) {
      logger.debug(`${freshMovie.title}: Trakt season backfill failed (non-blocking): ${err.message}`);
    }
  }

  const libraryProvider = getLibraryProvider();
  if (libraryProvider.isConfigured() && !isShow) {
    try {
      if (!libraryPreloaded) {
        await libraryProvider.getMovies(true);
        libraryPreloaded = true;
      }
    } catch (err: any) {
      logger.warn(`Library preload failed (non-blocking): ${err.message}`);
    }
    const inLibrary = await libraryProvider.hasMovie(movie.imdb_id, movie.tmdb_id, movie.title, movie.year);
    if (inLibrary === null) {
      // Provider unreachable with a cold cache — "not in library" would be a
      // guess that costs a full re-download of a title already on disk. Leave
      // the movie untouched; the next pass re-checks against a warm cache.
      logger.debug(`Skipping ${movie.title} this pass — library membership unknown (provider unreachable)`);
      processingMovies.delete(movie.id);
      return;
    }
    if (inLibrary) {
      const providerName = getLibraryProviderName();
      updateMovieStatus(movie.id, 'downloaded');
      addLogEntry(movie.id, 'already_in_library', `${movie.title} already exists in ${providerName}`);
      logger.info(`Skipping ${movie.title} — already in ${providerName} library`);
      processingMovies.delete(movie.id);
      return;
    }
  }

  // Skip if movie already has a package in JDownloader (uses cached package list).
  // SHOWS are exempt: their JD package names carry a season suffix
  // ("Title (Year) - S01 - 1080p"), so a startsWith(title) match on ONE season's
  // package would skip the ENTIRE show and starve still-pending seasons — e.g. S02
  // stuck on 'pending' forever while S01 downloads, or a season whose first
  // resolution failed never getting retried. processShowSeasons does its own
  // per-season dedup (downloading seasons are skipped / partial-filled, and JD's
  // addLinks dedups anyway), so let it run for shows.
  if (jdownloaderService.isConfigured() && movie.media_type !== 'show') {
    try {
      // JD rewrites ":" to ";" in package names — match what JD echoes back.
      const packageName = `${movie.title.replace(/:/g, ';')} (${movie.year})`;
      // A failed probe is remembered for the rest of the pass. Leaving the cache
      // null on failure meant every single movie re-issued both calls — each one
      // a 15s axios timeout plus the retry ladder — so a sync over a few hundred
      // pending titles spent the better part of an hour doing nothing but
      // timing out against an unreachable JDownloader, and repeated it on every
      // 30-minute retry tick.
      if (!cachedJdPackages && !jdPackageProbeFailed) {
        const [dlPkgs, lgPkgs] = await Promise.all([
          jdownloaderService.getDownloadPackages(),
          jdownloaderService.getLinkGrabberPackages(),
        ]);
        // Cache only if BOTH queries succeeded — a partial result risks treating
        // a transiently-missing package as "no duplicate" and re-sending.
        if (dlPkgs !== null && lgPkgs !== null) {
          cachedJdPackages = [...dlPkgs, ...lgPkgs];
        } else {
          jdPackageProbeFailed = true;
          logger.warn('JDownloader package probe failed — skipping the duplicate check for the rest of this pass');
        }
      }
      const existing = cachedJdPackages?.find(p => p.name.startsWith(packageName));
      if (existing) {
        // Ignore dead/failed packages (0 bytes, no online links)
        const isDead = existing.bytesTotal === 0 && existing.childCount !== undefined && existing.childCount <= 1;
        if (!isDead) {
          if (freshMovie.status !== 'downloading') {
            updateMovieStatus(movie.id, 'downloading');
          }
          logger.info(`Skipping ${movie.title} — already in JDownloader: "${existing.name}"`);
          processingMovies.delete(movie.id);
          return;
        }
        logger.info(`${movie.title}: existing JD package "${existing.name}" is dead (0 bytes) — re-processing`);
      }
    } catch (err: any) {
      logger.debug(`JDownloader duplicate check failed (non-blocking): ${err.message}`);
    }
  }

  logger.info(`Processing ${isShow ? 'show' : 'movie'}: ${movie.title} (${movie.year})`);
  addLogEntry(movie.id, 'search_started', `Searching for: ${movie.title}`);

  try {
    // Don't flip already-downloaded OR actively-downloading shows to 'searching' —
    // they're just being re-checked for new episodes. Changing the status confuses
    // the UI and leaks an orphaned 'searching' state when the re-check
    // short-circuits early (e.g. the season-progress no-clobber paths below return
    // without restoring the status; reconcile then bounced it to 'pending' after
    // 30 min and the show lost its 'downloading' badge).
    // Remember what we came from: the no-clobber early returns below leave the
    // status untouched, which is correct for 'downloaded'/'downloading' (never
    // set to 'searching' above) but stranded a show that entered as 'pending' —
    // it stayed 'searching' forever, showing a permanent "Suche läuft" badge, and
    // the 30-minute retry monitor only selects 'pending'/'not_found', so it had
    // to wait for the 24h full sync instead.
    const statusBeforeSearch = freshMovie.status;
    let flippedToSearching = false;
    if (!isShow || !['downloaded', 'downloading'].includes(freshMovie.status)) {
      updateMovieStatus(movie.id, 'searching');
      flippedToSearching = true;
      eventBus.emit('movie:updated', { id: movie.id, title: movie.title, status: 'searching' });
    }
    /** Undo the optimistic 'searching' flip on a path that decides nothing. */
    const restoreStatusIfUntouched = () => {
      if (!flippedToSearching) return;
      updateMovieStatus(movie.id, statusBeforeSearch);
      eventBus.emit('movie:updated', { id: movie.id, title: movie.title, status: statusBeforeSearch });
    };

    // Step 1: Resolve a source page for this title.
    // German-language sources often use the German title — pull it from Wikidata for matching.
    let germanTitle: string | undefined;
    if (!isShow && movie.imdb_id) {
      germanTitle = await getGermanTitleFromWikidata(movie.imdb_id) ?? undefined;
      if (germanTitle && germanTitle !== movie.title) {
        logger.info(`${movie.title}: using German Wikidata title as alt search: "${germanTitle}"`);
      }
    }

    // Iterate registered plugins for this media type in priority order.
    // First plugin returning releases wins; we keep going only if it found
    // a canonical source page but no releases (so the UI still has a link).
    const mediaType = (movie.media_type || 'movie') as 'movie' | 'show';
    const candidates = pluginRegistry.forMediaType(mediaType);
    let url: string | null = null;
    let releases: ScrapedRelease[] = [];
    let activePlugin: SourcePlugin | null = null;
    for (const plugin of candidates) {
      let result;
      try {
        result = await withPluginTimeout('findReleases', PLUGIN_TIMEOUTS.findReleases, plugin.findReleases(
          {
            title: movie.title,
            year: movie.year ?? undefined,
            imdbId: movie.imdb_id ?? undefined,
            mediaType,
            altTitle: germanTitle,
          },
          // Never resolve links inside the plugin — we resolve on demand after
          // filtering (resolveReleaseLinks) so captcha budget is only spent on
          // a release the user actually wants.
          { skipLinkResolution: true },
        ));
      } catch (err: any) {
        logger.warn(`${movie.title}: plugin "${plugin.id}" findReleases failed: ${err?.message || err}`);
        continue;
      }

      if (result.sourceUrl && !url) url = result.sourceUrl;
      if (result.releases.length === 0) {
        logger.info(`${movie.title}: plugin "${plugin.id}" returned no releases${result.sourceUrl ? '' : ' (no source page)'}`);
        continue;
      }

      // Only let a plugin "win" if at least one of its releases survives the
      // user's quality filter AND isn't blocklisted. Otherwise a source that
      // returns only junk (a 'complete' disc rip below the floor) OR only
      // releases we already proved dead (every link offline at the hoster, see
      // the post-processor's blocklist) would pre-empt a later source that has
      // the wanted release — the bug that left well-seeded titles "not found"
      // (junk variant), and the case where one source's only release had dead
      // links so a later source, which had a working one, was never consulted.
      // We still remember the first non-empty set as a fallback so the UI keeps
      // a source link and the failure log can report an honest quality breakdown.
      const survivors = filterReleases(result.releases, mediaType, movie.quality_override)
        .filter(r => !isReleaseBlocklisted(r.title));
      if (survivors.length > 0) {
        releases = result.releases;
        activePlugin = plugin;
        if (result.sourceUrl) url = result.sourceUrl; // winning source's page takes precedence over an earlier fallback link
        logger.info(`Found ${result.releases.length} release(s) for ${movie.title} via plugin "${plugin.id}" (${survivors.length} pass quality filter)`);
        break;
      }
      if (releases.length === 0) {
        releases = result.releases;
        activePlugin = plugin;
      }
      logger.info(`${movie.title}: plugin "${plugin.id}" returned ${result.releases.length} release(s), none passing the quality filter — trying next plugin`);
    }

    if (!url) {
      if (isShow && showHasSeasonProgress(movie.id)) {
        restoreStatusIfUntouched();
        updateLastChecked(movie.id);
        logger.info(`${movie.title}: Quelle ohne Treffer, aber Serie hat Staffel-Fortschritt — Status unangetastet (kein not_found-Clobber)`);
        return;
      }
      updateMovieStatus(movie.id, 'not_found', undefined, 'not_available');
      updateLastChecked(movie.id);
      const retries = incrementRetryCount(movie.id);
      addLogEntry(movie.id, 'not_found', `${movie.title} not found (retry ${retries}/${MAX_RETRIES})`);
      eventBus.emit('movie:updated', { id: movie.id, title: movie.title, status: 'not_found' });
      return;
    }

    // Step 3: Filter by quality/audio/language, then exclude blocklisted releases.
    // Pure ScrapedRelease[] in / out — no source-specific knowledge. The per-title
    // quality_override (detail panel, "Anforderungen nicht erfüllt" bucket) relaxes
    // this search; the upgrade path stays on the global filter so a relaxed
    // download still gets upgraded to the configured quality when one appears.
    const { releases: filteredRaw, stats } = filterReleasesWithStats(releases, mediaType, movie.quality_override);
    const filtered = filteredRaw.filter(r => !isReleaseBlocklisted(r.title));

    if (filtered.length === 0) {
      // A show with real per-season progress must not be clobbered to not_found by
      // a transient empty/quality-failed search: that status hides it from the
      // post-processor, stranding already-downloaded episodes on disk. Defer to the
      // per-season pipeline and leave the existing show status alone.
      if (isShow && showHasSeasonProgress(movie.id)) {
        restoreStatusIfUntouched();
        updateLastChecked(movie.id);
        logger.info(`${movie.title}: keine passenden Releases diesmal, aber Serie hat Staffel-Fortschritt — kein not_found-Clobber`);
        return;
      }
      // Pinpoint the dominant failure reason so the log doesn't always blame
      // "quality" when the real cause is e.g. a hoster resolver bailing out
      // and every release returning with `links: []`.
      const allFailedOnLinks = stats.noLinksFail === stats.total && stats.total > 0;
      // Classify why nothing was usable, into the right bucket:
      //   • 0 releases at the source        → 'not_available' ("Noch nicht verfügbar")
      //   • releases exist, all dead links   → 'no_download'   ("Kein Download verfügbar")
      //   • releases exist, fail quality/etc → 'quality_mismatch' ("Keine passende Qualität")
      // The old code lumped 0-releases in with no_download, and mislabelled them as
      // quality_mismatch in the activity log — so a title the source simply doesn't
      // have yet showed up under "Keine passende Qualität".
      const notFoundReason = releases.length === 0 ? 'not_available'
        : allFailedOnLinks ? 'no_download'
        : 'quality_mismatch';
      updateMovieStatus(movie.id, 'not_found', url, notFoundReason);
      updateLastChecked(movie.id);
      incrementRetryCount(movie.id);
      const availableHosters = [...new Set(releases.flatMap(r => r.links.map(l => l.hoster)))].join(', ') || 'none';
      const qualitySummary = releases.map(r => `${r.quality}/${r.audio}/${r.language}`).join(', ');

      const reasonParts: string[] = [];
      if (stats.noLinksFail)  reasonParts.push(`${stats.noLinksFail} ohne Links`);
      if (stats.qualityFail)  reasonParts.push(`${stats.qualityFail} unter Qualitäts-Mindest`);
      if (stats.audioFail)    reasonParts.push(`${stats.audioFail} unter Audio-Mindest`);
      if (stats.languageFail) reasonParts.push(`${stats.languageFail} falsche Sprache`);
      if (stats.typeFail)     reasonParts.push(`${stats.typeFail} ausgeschlossener Release-Typ`);
      if (stats.sourceFail)   reasonParts.push(`${stats.sourceFail} minderwertige Quelle (CAM/TS)`);
      if (stats.dvFail)       reasonParts.push(`${stats.dvFail} Dolby Vision (ausgeschlossen)`);
      const wanted = movie.desired_quality || getSetting('quality.minimum') || '1080p';
      const reasonSummary = reasonParts.join(', ')
        || (releases.length === 0 ? 'keine Releases bei der Quelle' : `gewünscht: mind. ${wanted}`);
      const headline = allFailedOnLinks
        ? 'alle Releases ohne auflösbare Hoster-Links — Plugin-Resolver blockiert?'
        : releases.length === 0
          ? 'keine Releases bei der Quelle gefunden'
          : 'kein Release erfüllt alle Filter-Kriterien';

      logger.info(`${movie.title}: ${releases.length} release(s) — ${headline} (${reasonSummary}) · gefunden: ${qualitySummary} [hosters: ${availableHosters}]`);
      addLogEntry(
        movie.id,
        // 0 releases here means the source PAGE was found (url is set — the !url
        // path returned above) but nothing could be extracted from it. That is the
        // scrape-block signature (CF challenge, token-extraction failure, goto
        // timeout) — a title that simply isn't released yet returns sourceUrl=null
        // and exits at the !url branch, so it never reaches this action. Tagged
        // distinctly (not 'not_found') so the health monitor can count a systemic
        // block across DISTINCT titles without false-firing on unreleased ones.
        releases.length === 0 ? 'scrape_blocked' : allFailedOnLinks ? 'no_hoster' : 'quality_mismatch',
        // No "Release(s)" shorthand here: the detail panel extracts the reason
        // as the trailing parenthetical, and a "(s)" in the prefix used to
        // confuse that parse. Use a real plural instead.
        allFailedOnLinks
          ? `Alle ${releases.length} ${releases.length === 1 ? 'Release' : 'Releases'} ohne auflösbare Hoster-Links`
          : releases.length === 0
            ? `Keine Releases bei der Quelle gefunden (gewünscht: mind. ${wanted})`
            : `${releases.length} ${releases.length === 1 ? 'Release' : 'Releases'} gefunden, aber keins erfüllt die Anforderungen (${reasonSummary}; gewünscht ≥ ${wanted})`,
      );
      return;
    }

    // For shows: process per-season — only download seasons that are still needed
    if (isShow) {
      await processShowSeasons(movie, url, filtered, activePlugin);
      return;
    }

    // --- Movie processing ---
    // Step 4: Walk releases best-first and resolve links on demand. Stop at the
    // first one that yields usable direct hoster links — resolution only ever
    // touches a release that already passed the quality filter.
    const enabledHosters = (getSetting('hosters.enabled') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    let bestRelease: typeof filtered[0] | null = null;
    let directLinks: string[] = [];
    const allDiagnostics: string[] = [];

    for (const release of filtered) {
      const links = await resolveReleaseLinks(release, activePlugin, enabledHosters);
      const diag = release._resolutionDiagnostic;
      if (diag) allDiagnostics.push(`${release.title}: ${diag}`);
      if (links.length > 0) {
        bestRelease = release;
        directLinks = links;
        break;
      }
    }

    // Fall-through: the winning plugin's releases passed the quality filter but
    // NONE of their links resolved (dead link container, blocked hoster…).
    // Without this, an unresolvable winner permanently shadows every later
    // plugin: each retry re-picks the same winner and the title loops in
    // "will retry (n/10)" while another source has a working release. Only fires
    // in the failure case, which previously burned a retry cycle anyway, so the
    // extra source queries replace retries instead of adding steady-state load.
    if (!bestRelease) {
      const failedIdx = candidates.findIndex(p => p.id === activePlugin?.id);
      for (let i = failedIdx >= 0 ? failedIdx + 1 : candidates.length; i < candidates.length && !bestRelease; i++) {
        const plugin = candidates[i];
        let result;
        try {
          result = await withPluginTimeout('findReleases', PLUGIN_TIMEOUTS.findReleases, plugin.findReleases(
            {
              title: movie.title,
              year: movie.year ?? undefined,
              imdbId: movie.imdb_id ?? undefined,
              mediaType,
              altTitle: germanTitle,
            },
            { skipLinkResolution: true },
          ));
        } catch (err: any) {
          logger.warn(`${movie.title}: fall-through plugin "${plugin.id}" findReleases failed: ${err?.message || err}`);
          continue;
        }
        if (result.releases.length === 0) continue;
        const survivors = filterReleases(result.releases, mediaType, movie.quality_override)
          .filter(r => !isReleaseBlocklisted(r.title));
        if (survivors.length === 0) continue;
        logger.info(`${movie.title}: links of "${activePlugin?.id}" unresolvable — falling through to plugin "${plugin.id}" (${survivors.length} release(s) pass the filter)`);
        for (const release of survivors) {
          const links = await resolveReleaseLinks(release, plugin, enabledHosters);
          const diag = release._resolutionDiagnostic;
          if (diag) allDiagnostics.push(`${release.title}: ${diag}`);
          if (links.length > 0) {
            bestRelease = release;
            directLinks = links;
            activePlugin = plugin;
            if (result.sourceUrl) url = result.sourceUrl;
            break;
          }
        }
      }
    }

    if (!bestRelease || directLinks.length === 0) {
      updateMovieStatus(movie.id, 'pending', url);
      updateLastChecked(movie.id);
      const retries = incrementRetryCount(movie.id);
      const diagSuffix = allDiagnostics.length > 0 ? ` [${allDiagnostics.join(' | ')}]` : '';
      addLogEntry(movie.id, 'captcha_pending',
        `${filtered.length} release(s) found but links not resolved — will retry (${retries}/${MAX_RETRIES})${diagSuffix}`);
      logger.info(`${movie.title}: links not resolved across ${filtered.length} release(s), will retry (${retries}/${MAX_RETRIES})${diagSuffix}`);
      return;
    }

    // Wrap status update + download inserts in a transaction for consistency
    const saveFoundMovie = db.transaction(() => {
      updateMovieStatus(movie.id, 'found', url);
      resetRetryCount(movie.id);
      addLogEntry(movie.id, 'release_found',
        `Found: ${bestRelease.quality} | ${bestRelease.audio} | ${directLinks.length} direct link(s)`);

      // Step 5: Add downloads to DB
      for (const link of bestRelease.links.filter(l => (enabledHosters.length === 0 || enabledHosters.includes(l.hoster)))) {
        addDownload({
          movie_id: movie.id,
          release_name: bestRelease.title,
          quality: bestRelease.quality,
          audio: bestRelease.audio,
          hoster: link.hoster,
          download_url: link.url,
        });
      }
    });
    saveFoundMovie();
    eventBus.emit('movie:updated', { id: movie.id, title: movie.title, status: 'found' });

    // Step 6: Send only direct links to JDownloader (never unresolved containers)
    if (jdownloaderService.isConfigured()) {
      const yearStr = movie.year != null ? ` (${movie.year})` : '';
      const packageName = `${movie.title}${yearStr} - ${bestRelease.quality}`;
      const result = await jdownloaderService.addLinks(directLinks, packageName);

      if (result === 'sent') {
        updateMovieStatus(movie.id, 'downloading');
        updateDownloadStatusByMovieId(movie.id, 'sent_to_jd');
        addLogEntry(movie.id, 'sent_to_jdownloader',
          `Sent ${directLinks.length} direct link(s) to JDownloader`);
        eventBus.emit('movie:updated', { id: movie.id, title: movie.title, status: 'downloading' });
      } else if (result === 'offline') {
        // Pre-download guard caught a dead release — blocklist it and re-search
        // so the same offline links aren't resolved again next cycle.
        blocklistDeadOnAdd(movie, bestRelease.title);
        updateMovieStatus(movie.id, 'not_found', undefined, 'no_download');
        incrementRetryCount(movie.id);
        addLogEntry(movie.id, 'links_offline',
          'Release tot — alle Links offline beim Hoster, geblockt, neue Suche folgt');
        eventBus.emit('movie:updated', { id: movie.id, title: movie.title, status: 'not_found' });
      } else {
        addLogEntry(movie.id, 'jdownloader_error', 'Failed to send links to JDownloader');
      }
    }

    updateLastChecked(movie.id);
    incrementMetric('moviesProcessed');
  } catch (error: any) {
    // Reset to pending so it gets retried on next sync
    updateMovieStatus(movie.id, 'pending');
    updateLastChecked(movie.id);
    incrementRetryCount(movie.id);
    logger.error(`Error processing ${movie.title}: ${error.message}`, { stack: error.stack });
    addLogEntry(movie.id, 'error', error.message);
  } finally {
    processingMovies.delete(movie.id);
  }
}

/**
 * Process a show with hybrid strategy:
 * 1. Discover available releases (free, no captcha) — season packs & individual episodes
 * 2. Auto-add new seasons/episodes from source releases (fallback if Trakt missed them)
 * 3. Per-season: prefer season pack, fall back to individual episode downloads
 * 4. Only solve captcha when actually downloading
 */
async function processShowSeasons(movie: Movie, url: string, filtered: ScrapedRelease[], activePlugin: SourcePlugin | null): Promise<void> {
  // Phase 0: Reconcile DB against the media library (Plex/Jellyfin).
  // Catches drift in both directions: files we think are downloaded but aren't,
  // and files in the library we never tracked. Done before computing pending
  // seasons so the rest of this function sees the corrected state.
  try {
    await reconcileEpisodesWithLibrary(movie);
  } catch (err: any) {
    logger.warn(`${movie.title}: library reconcile failed (non-blocking): ${err.message}`);
  }

  // Phase 1: Categorize releases — this is FREE (no captcha)
  const seasonPacks = filtered.filter(r => r.season !== null && r.isSeasonPack);
  const episodeReleases = filtered.filter(r => r.season !== null && r.episode !== null);

  // Log what the source has available
  const availableSeasons = [...new Set(filtered.filter(r => r.season !== null).map(r => r.season!))].sort((a, b) => a - b);
  const availablePackSeasons = [...new Set(seasonPacks.map(r => r.season!))].sort((a, b) => a - b);
  const availableEpisodes = episodeReleases.map(r => `S${String(r.season).padStart(2, '0')}E${String(r.episode).padStart(2, '0')}`);
  logger.info(`${movie.title}: available at source — seasons: ${availableSeasons.map(n => `S${String(n).padStart(2, '0')}`).join(', ') || 'none'}, packs: ${availablePackSeasons.map(n => `S${String(n).padStart(2, '0')}`).join(', ') || 'none'}, episodes: ${availableEpisodes.join(', ') || 'none'}`);

  // Per-show season cutoff: when set, only seasons >= cutoff are monitored.
  // Applied at every gate below so skipped seasons are neither auto-added,
  // processed, re-fetched, nor counted toward the show's aggregate status.
  const cutoff = movie.season_cutoff;
  const isMonitored = (seasonNum: number) => cutoff == null || seasonNum >= cutoff;

  // Phase 2: Auto-discover new seasons from releases (fallback for Trakt gaps)
  let seasons = getSeasonsByShowId(movie.id);
  const existingNumbers = new Set(seasons.map(s => s.season_number));
  const quality = movie.desired_quality || getSetting('quality.minimum') || '1080p';

  // A request names its seasons; a watchlist entry does not. Auto-discovery is
  // right for the latter and wrong for the former — it silently turned a
  // two-season request into the show's full eight-season run.
  const seasonsExplicit = movie.seasons_explicit === 1;
  if (seasonsExplicit && availableSeasons.some(n => n > 0 && !existingNumbers.has(n))) {
    logger.debug(`${movie.title}: season set is request-scoped — not auto-adding seasons found at source`);
  }

  for (const seasonNum of availableSeasons) {
    if (seasonNum === 0) continue; // Never auto-add Specials (season 0) — Trakt intentionally excludes them
    if (seasonsExplicit && !existingNumbers.has(seasonNum)) continue; // only what was asked for
    if (!isMonitored(seasonNum)) continue; // Below the show's cutoff — don't track it
    if (!existingNumbers.has(seasonNum)) {
      const newSeason = (await import('../database/services/seasons')).addSeason(movie.id, seasonNum, quality);
      // If we know episodes from releases, add them
      const epNums = episodeReleases
        .filter(r => r.season === seasonNum)
        .map(r => r.episode!)
        .filter((v, i, a) => a.indexOf(v) === i);
      if (epNums.length > 0) {
        addEpisodes(newSeason.id, epNums);
      }
      addLogEntry(movie.id, 'season_discovered', `S${String(seasonNum).padStart(2, '0')}: new season discovered at source`);
      logger.info(`${movie.title}: auto-added S${String(seasonNum).padStart(2, '0')} from source releases`);
    } else {
      // Existing season — add any new episodes we didn't know about
      const season = seasons.find(s => s.season_number === seasonNum)!;
      const newEpNums = episodeReleases
        .filter(r => r.season === seasonNum)
        .map(r => r.episode!)
        .filter((v, i, a) => a.indexOf(v) === i);
      if (newEpNums.length > 0) {
        addEpisodes(season.id, newEpNums); // INSERT OR IGNORE — safe for duplicates
      }
    }
  }

  // Re-fetch seasons after auto-add
  seasons = getSeasonsByShowId(movie.id);

  if (seasons.length === 0) {
    logger.info(`${movie.title}: no seasons known — waiting for Trakt sync or source releases`);
    updateMovieStatus(movie.id, 'pending', url);
    updateLastChecked(movie.id);
    return;
  }

  // Phase 3: Process each season with hybrid strategy
  const pendingSeasons = seasons.filter(s => isMonitored(s.season_number) && ['pending', 'not_found'].includes(s.status));

  // Re-process seasons that still have 'pending' episodes to fetch:
  //  - 'downloaded' seasons that gained new episodes (weekly releases)
  //  - 'downloading' seasons whose earlier pass couldn't resolve every episode
  //    (only the gaps are filled; episodes already sent to JD stay untouched)
  for (const season of seasons) {
    if (pendingSeasons.some(p => p.id === season.id)) continue;
    if (!isMonitored(season.season_number)) continue; // below cutoff — don't fill its gaps
    if (season.status !== 'downloaded' && season.status !== 'downloading') continue;
    const pending = getPendingEpisodes(season.id);
    if (pending.length === 0) continue;
    if (season.status === 'downloaded') updateSeasonStatus(season.id, 'pending', url);
    // Keep the original status — the loop treats a 'downloading' season as a
    // partial fill (skip the season-pack step, fetch only the missing episodes).
    pendingSeasons.push(season);
    logger.info(`${movie.title} S${String(season.season_number).padStart(2, '0')}: ${pending.length} pending episode(s) — (re)processing`);
  }

  if (pendingSeasons.length === 0) {
    // Before declaring complete, check Trakt for new seasons that may not be in the DB yet
    // (e.g. S2 had aired_episodes=0 when first synced and was filtered out)
    if (movie.trakt_id && traktService.isConfigured() && traktService.isAuthenticated()) {
      await traktService.syncShowSeasons(movie.id, movie.trakt_id);
      const refreshedSeasons = getSeasonsByShowId(movie.id);
      const newPending = refreshedSeasons.filter(s => isMonitored(s.season_number) && ['pending', 'not_found'].includes(s.status));
      if (newPending.length > 0) {
        logger.info(`${movie.title}: Trakt revealed ${newPending.length} new season(s) — continuing`);
        pendingSeasons.push(...newPending);
      }
    }
  }

  if (pendingSeasons.length === 0) {
    logger.info(`${movie.title}: all seasons complete (${seasons.map(s => `S${String(s.season_number).padStart(2, '0')}=${s.status}`).join(', ')})`);
    updateMovieStatus(movie.id, 'downloaded', url);
    updateLastChecked(movie.id);
    return;
  }

  logger.info(`${movie.title}: need seasons ${pendingSeasons.map(s => `S${String(s.season_number).padStart(2, '0')}`).join(', ')}`);

  const enabledHosters = (getSetting('hosters.enabled') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  let anyProcessed = false;

  for (const season of pendingSeasons) {
    const sNum = season.season_number;
    const sLabel = `${movie.title} S${String(sNum).padStart(2, '0')}`;

    // A 'downloading' season here is a partial fill (some episodes already sent):
    // skip the season-pack step and only fetch the still-'pending' episodes.
    const partialFill = season.status === 'downloading';

    // Strategy A: Try season pack first (preferred — one download for entire season)
    const packRelease = partialFill ? undefined : seasonPacks.find(r => r.season === sNum);
    if (packRelease) {
      const result = await tryDownloadRelease(movie, season, packRelease, sLabel + ' [PACK]', enabledHosters, url, activePlugin);
      if (result === 'downloaded') {
        // Season pack sent to JDownloader — mark season as downloading so the scheduler
        // doesn't retry, but let the post-processor handle per-episode tracking once files land.
        updateSeasonStatus(season.id, 'downloading');
        anyProcessed = true;
        continue;
      }
      if (result === 'pending') {
        // Links resolved but JD send failed / release dead — episodes would hit
        // the same wall (JD down) or were just blocklisted; wait for retry.
        continue;
      }
      // result === 'no_links' (pack resolution yielded nothing) — fall through
      // to the per-episode releases. Costs one captcha per episode instead of
      // one per pack, but it is the only path to content when the pack
      // container is permanently dead.
    }

    // Strategy B: Fall back to individual episode downloads
    const seasonEpisodes = episodeReleases.filter(r => r.season === sNum);
    if (seasonEpisodes.length === 0 && !packRelease) {
      if (partialFill) {
        // Partial season but the source no longer lists the missing episodes —
        // leave it 'downloading'; the post-processor finalizes what was sent.
        logger.info(`${sLabel}: missing episode(s) not currently at source — leaving as downloading`);
        updateSeasonLastChecked(season.id);
        continue;
      }
      logger.info(`${sLabel}: no releases found (neither pack nor episodes)`);
      updateSeasonStatus(season.id, 'not_found', url, 'no_download');
      updateSeasonLastChecked(season.id);
      addLogEntry(movie.id, 'not_found', `${sLabel}: no release found`);
      continue;
    }

    if (seasonEpisodes.length > 0) {
      let pending = getPendingEpisodes(season.id);
      if (pending.length === 0) {
        // No 'pending' episodes left — but that is NOT the same as "all
        // downloaded": getPendingEpisodes excludes 'downloading', so a season
        // whose sent-to-JD episodes never landed (JD package deleted/crashed)
        // would have been falsely flipped to 'downloaded' here with zero files
        // on disk. Only complete the season when every episode really is
        // 'downloaded'; otherwise check JD for orphaned in-flight episodes and
        // reclaim them (reset to 'pending') so this same pass can re-send them.
        const completion = getSeasonCompletionStatus(season.id);
        if (completion.allDone) {
          updateSeasonStatus(season.id, 'downloaded', url);
          continue;
        }
        pending = await reclaimOrphanedEpisodes(movie, season, sLabel);
        if (pending.length === 0) {
          logger.info(`${sLabel}: ${completion.total - completion.downloaded} episode(s) still in flight in JD — waiting`);
          updateSeasonLastChecked(season.id);
          continue;
        }
      }

      let episodesProcessed = 0;
      for (const ep of pending) {
        const epRelease = seasonEpisodes.find(r => r.episode === ep.episode_number);
        if (!epRelease) continue;

        const eLabel = `${sLabel}E${String(ep.episode_number).padStart(2, '0')}`;
        // ALWAYS resolve through the plugin. findReleases ran with
        // skipLinkResolution:true, so epRelease.links may still be UNRESOLVED
        // container/redirect URLs (e.g. a source plugin's intermediate landing pages),
        // not direct hoster links. The previous "resolve only when the filtered
        // list is empty" guard could never fire — the filter that built
        // directLinks and the one that built the resolution candidates were
        // identical, so one being empty implied the other was too — and raw
        // /external/ URLs went straight to JDownloader. Same bug class the
        // season-pack path had (see tryDownloadRelease); same fix:
        // resolveReleaseLinks is a no-op for plugins returning direct URLs.
        if (epRelease.links.length > 0) {
          addLogEntry(movie.id, 'resolving_links', `${eLabel}: resolving download links...`);
        }
        const directLinks = await resolveReleaseLinks(epRelease, activePlugin, enabledHosters);

        if (directLinks.length === 0) {
          const diag = epRelease._resolutionDiagnostic;
          const diagSuffix = diag ? ` [${diag}]` : '';
          addLogEntry(movie.id, 'captcha_pending', `${eLabel}: links not resolved — will retry${diagSuffix}`);
          continue;
        }

        // Save episode download
        const saveEpisode = db.transaction(() => {
          updateEpisodeStatus(ep.id, 'downloading', epRelease.title);
          addLogEntry(movie.id, 'release_found',
            `${eLabel}: ${epRelease.quality} | ${epRelease.audio} | ${directLinks.length} link(s)`);
          for (const link of epRelease.links.filter(l => (enabledHosters.length === 0 || enabledHosters.includes(l.hoster)))) {
            addDownload({
              movie_id: movie.id,
              season_number: season.season_number,
              release_name: epRelease.title,
              quality: epRelease.quality,
              audio: epRelease.audio,
              hoster: link.hoster,
              download_url: link.url,
            });
          }
        });
        saveEpisode();

        // Send to JDownloader. Counts as processed unless the send failed and we
        // reverted the episode to 'pending' — otherwise a season where every
        // episode send failed would still be flipped to 'downloading' below
        // (episodesProcessed > 0) despite nothing having reached JD.
        let episodeSent = true;
        if (jdownloaderService.isConfigured()) {
          // Guard the year like the pack/movie paths do — an unguarded
          // `(${movie.year})` renders "(null)" for year-less shows, which no
          // package matcher (jdPackagePrefix) ever produces, so those packages
          // became invisible to the status sync.
          const yearStr = movie.year != null ? ` (${movie.year})` : '';
          const packageName = `${movie.title}${yearStr} - S${String(sNum).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')} - ${epRelease.quality}`;
          const result = await jdownloaderService.addLinks(directLinks, packageName);
          if (result === 'sent') {
            addLogEntry(movie.id, 'sent_to_jdownloader', `${eLabel}: sent ${directLinks.length} link(s) to JDownloader`);
            logger.info(`${eLabel}: sent to JDownloader as "${packageName}"`);
          } else if (result === 'offline') {
            // Dead release — blocklist it and revert the episode to 'pending' so
            // the next search picks a different release instead of these dead links.
            blocklistDeadOnAdd(movie, epRelease.title);
            updateEpisodeStatus(ep.id, 'pending');
            addLogEntry(movie.id, 'links_offline', `${eLabel}: Release tot — alle Links offline, geblockt, neue Suche folgt`);
            logger.warn(`${eLabel}: all links offline, blocklisted + episode reset to pending`);
            episodeSent = false;
          } else {
            // Revert: the saveEpisode tx already flipped the episode to 'downloading'
            // and inserted download rows. Without this revert the episode is invisible
            // (getPendingEpisodes only sees 'pending') yet JD never received the links —
            // a permanent soft orphan. Reverting puts it back in the next sync's queue.
            updateEpisodeStatus(ep.id, 'pending');
            addLogEntry(movie.id, 'jdownloader_error', `${eLabel}: failed to send links to JDownloader — will retry`);
            logger.warn(`${eLabel}: JDownloader send failed, episode reset to pending`);
            episodeSent = false;
          }
        }
        if (episodeSent) episodesProcessed++;
      }

      // Check if all episodes are now done
      const completion = getSeasonCompletionStatus(season.id);
      if (completion.allDone) {
        updateSeasonStatus(season.id, 'downloaded', url);
        logger.info(`${sLabel}: all ${completion.total} episodes downloaded`);
      } else if (episodesProcessed > 0) {
        updateSeasonStatus(season.id, 'downloading', url);
        logger.info(`${sLabel}: ${completion.downloaded}/${completion.total} episodes done`);
      }

      if (episodesProcessed > 0) anyProcessed = true;
    }

    updateSeasonLastChecked(season.id);
  }

  // Phase 4: Update aggregate show status — derived only from MONITORED seasons.
  // Skipped seasons (below the cutoff) stay 'pending' in the DB forever, so
  // counting them would keep an otherwise-complete show out of 'downloaded'.
  const updatedSeasons = getSeasonsByShowId(movie.id).filter(s => isMonitored(s.season_number));
  let newStatus: 'pending' | 'searching' | 'found' | 'downloading' | 'downloaded' | 'not_found';
  if (updatedSeasons.length === 0) {
    // Cutoff sits above every known season — nothing to fetch yet; keep waiting
    // for the cutoff season to air rather than declaring the show complete.
    newStatus = 'pending';
  } else if (updatedSeasons.every(s => s.status === 'downloaded')) {
    newStatus = 'downloaded';
  } else if (updatedSeasons.some(s => s.status === 'downloading')) {
    newStatus = 'downloading';
  } else if (updatedSeasons.some(s => s.status === 'found')) {
    newStatus = 'found';
  } else if (updatedSeasons.every(s => s.status === 'not_found')) {
    newStatus = 'not_found';
  } else {
    newStatus = 'pending';
  }
  updateMovieStatus(movie.id, newStatus, url);
  updateLastChecked(movie.id);
  if (anyProcessed) {
    resetRetryCount(movie.id);
    incrementMetric('moviesProcessed');
  } else {
    // No season made progress this pass — advance the show's retry clock so the
    // movie-level backoff/give-up (it runs for shows too, before
    // processShowSeasons) throttles the next re-search and eventually gives up.
    // The show stays re-selected by runFullSync and its not_found seasons stay
    // re-selected, so a later-available season is only delayed by backoff, never
    // stranded; resetRetryCount above fires the moment any season makes progress.
    //
    // This used to fire only for newStatus === 'not_found'. A show whose season
    // pack resolves to no usable links lands back on 'pending' instead, so its
    // retry_count never moved, the backoff guard (which requires retry_count > 0)
    // never engaged, and the 30-minute retry monitor re-ran a full source search
    // AND a link resolution — a captcha/PoW spend — on that show forever.
    incrementRetryCount(movie.id);
  }
  eventBus.emit('movie:updated', { id: movie.id, title: movie.title, status: newStatus });
}

/**
 * Try to download a release for a season. Returns:
 * - 'downloaded' if links sent to JDownloader
 * - 'pending' if links resolved but the JD send failed / release was dead
 *   (offline) — wait for the retry cycle, episodes would hit the same wall
 * - 'no_links' if resolution yielded no usable links — the caller falls back
 *   to per-episode releases. This used to return 'pending' too, which made the
 *   documented episode fallback unreachable: a season whose pack container was
 *   permanently dead (expired link container, unsolvable captcha) retried the pack
 *   forever and never tried the per-episode releases sitting right there.
 *
 * If links are unresolved (container/redirect URLs), resolves them on-demand via the active plugin.
 */
async function tryDownloadRelease(
  movie: Movie, season: Season, release: ScrapedRelease,
  label: string, enabledHosters: string[], url: string,
  activePlugin: SourcePlugin | null,
): Promise<'downloaded' | 'pending' | 'no_links'> {
  // Always resolve through the plugin. findReleases is called with
  // skipLinkResolution:true, so release.links here may still be UNRESOLVED
  // container/redirect URLs (e.g. intermediate landing links from the source), not
  // direct hoster URLs. Sending those straight to JDownloader lets JD do the
  // resolution itself — landing on an arbitrary (often dead) mirror and pulling
  // in every hoster, including dead ones. Resolving here runs the plugin's
  // hoster-preference-ordered resolution, which follows the per-hoster link to
  // the live mirror. This is the same path the individual-episode download
  // already uses; the season-pack path previously only resolved when the list
  // was empty (i.e. never), which sent raw redirect URLs to JD.
  // resolveReleaseLinks is a no-op for plugins that already return direct URLs.
  if (release.links.length > 0) {
    addLogEntry(movie.id, 'resolving_links', `${label}: resolving download links...`);
  }
  const directLinks = await resolveReleaseLinks(release, activePlugin, enabledHosters);

  if (directLinks.length === 0) {
    const diag = release._resolutionDiagnostic;
    const diagSuffix = diag ? ` [${diag}]` : '';
    updateSeasonStatus(season.id, 'pending', url);
    updateSeasonLastChecked(season.id);
    addLogEntry(movie.id, 'captcha_pending', `${label}: links not resolved — trying episode fallback, else retry${diagSuffix}`);
    logger.info(`${label}: links not resolved — episode fallback if available, else retry${diagSuffix}`);
    return 'no_links';
  }

  // Save in transaction
  const saveFound = db.transaction(() => {
    updateSeasonStatus(season.id, 'found', url);
    addLogEntry(movie.id, 'release_found',
      `${label}: ${release.quality} | ${release.audio} | ${directLinks.length} direct link(s)`);
    for (const link of release.links.filter(l => (enabledHosters.length === 0 || enabledHosters.includes(l.hoster)))) {
      addDownload({
        movie_id: movie.id,
        season_number: season.season_number,
        release_name: release.title,
        quality: release.quality,
        audio: release.audio,
        hoster: link.hoster,
        download_url: link.url,
      });
    }
  });
  saveFound();

  // Send to JDownloader
  if (jdownloaderService.isConfigured()) {
    const sNum = String(season.season_number).padStart(2, '0');
    const yearStr = movie.year != null ? ` (${movie.year})` : '';
    const packageName = `${movie.title}${yearStr} - S${sNum} - ${release.quality}`;
    const result = await jdownloaderService.addLinks(directLinks, packageName);
    if (result === 'sent') {
      updateSeasonStatus(season.id, 'downloading');
      // Season-scoped: a show's rows all share its movie_id, so the unscoped
      // update marked every OTHER season's links sent as well.
      updateDownloadStatusBySeason(movie.id, season.season_number, 'sent_to_jd');
      addLogEntry(movie.id, 'sent_to_jdownloader', `${label}: sent ${directLinks.length} link(s) to JDownloader`);
      logger.info(`${label}: sent to JDownloader as "${packageName}"`);
      return 'downloaded';
    }
    if (result === 'offline') {
      // Dead release — blocklist it and reset the season to pending for re-search.
      blocklistDeadOnAdd(movie, release.title);
      updateSeasonStatus(season.id, 'pending', url);
      addLogEntry(movie.id, 'links_offline', `${label}: Release tot — alle Links offline, geblockt, neue Suche folgt`);
      logger.warn(`${label}: all links offline, blocklisted + season reset to pending`);
      return 'pending';
    }
    // JD send failed — reset season to pending so it gets retried, don't mark as done
    updateSeasonStatus(season.id, 'pending', url);
    addLogEntry(movie.id, 'jdownloader_error', `${label}: failed to send links to JDownloader — will retry`);
    logger.warn(`${label}: JDownloader send failed, season reset to pending`);
    return 'pending';
  }

  return 'downloaded';
}

/**
 * Reclaim episodes stuck in 'downloading' whose JD package no longer exists.
 *
 * An episode flips to 'downloading' the moment its links are sent to JD; only a
 * successful file move flips it to 'downloaded'. If the JD package vanishes in
 * between (user deleted it, JD crash, or the crawler produced nothing from the
 * links), NOTHING re-selects the episode: getPendingEpisodes only returns
 * 'pending', the show-level stale-reset resets seasons but historically not
 * their episodes, and libraryReconcile deliberately leaves 'downloading' rows
 * alone. The episode is stranded forever.
 *
 * This checks JD directly (both download list and linkgrabber) and resets only
 * episodes with no matching package — a live in-flight download is never
 * touched, so no captcha budget is wasted on it. JD unreachable or not
 * configured → returns [] (can't tell, wait for the next pass).
 */
async function reclaimOrphanedEpisodes(movie: Movie, season: Season, sLabel: string): Promise<Episode[]> {
  if (!jdownloaderService.isConfigured()) return [];
  const stuck = getEpisodesBySeasonId(season.id).filter(e => e.status === 'downloading');
  if (stuck.length === 0) return [];

  const [dlPkgs, lgPkgs] = await Promise.all([
    jdownloaderService.getDownloadPackages(),
    jdownloaderService.getLinkGrabberPackages(),
  ]);
  // Either query failed → can't distinguish "package gone" from "JD down".
  if (dlPkgs === null || lgPkgs === null) return [];
  const names = [...dlPkgs, ...lgPkgs].map(p => p.name || '');

  // Episode packages are named "Title (Year) - SxxEyy - quality"; JD echoes
  // ':' back as ';'. Match on title prefix + the SxxEyy token.
  const yearStr = movie.year != null ? ` (${movie.year})` : '';
  const titlePrefix = `${movie.title.replace(/:/g, ';')}${yearStr}`;

  let reset = 0;
  for (const ep of stuck) {
    const epToken = ` - S${String(season.season_number).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`;
    const alive = names.some(n => n.startsWith(titlePrefix) && n.includes(epToken));
    if (alive) continue;
    updateEpisodeStatus(ep.id, 'pending');
    reset++;
  }
  if (reset > 0) {
    addLogEntry(movie.id, 'download_stale',
      `${sLabel}: ${reset} Folge(n) hingen in 'downloading' ohne JD-Paket — werden neu geladen`);
    logger.warn(`${sLabel}: reclaimed ${reset} orphaned episode(s) (stuck in 'downloading', no JD package) — reset to pending`);
  }
  return getPendingEpisodes(season.id);
}

/**
 * Narrow a movie's (or season's) download rows to the single most recent release.
 *
 * Download rows are append-only — nothing in the codebase deletes them — so a
 * title that went through two or three releases carries the links of all of them,
 * dead ones included. `release_name` is the grouping key; rows without one are
 * treated as their own (legacy) group. Ties on `created_at` keep insertion order,
 * which is the order the rows were written for a single release.
 */
function downloadsForNewestRelease(downloads: Download[]): Download[] {
  if (downloads.length <= 1) return downloads;
  let newest = downloads[0];
  for (const d of downloads) {
    if (parseUtcDate(d.created_at) > parseUtcDate(newest.created_at)) newest = d;
  }
  // Completed rows belong to a download that already landed — never re-send those.
  const group = downloads.filter(d => d.release_name === newest.release_name && d.status !== 'completed');
  return group.length > 0 ? group : [];
}

/**
 * Retry sending links to JDownloader for movies/seasons stuck in 'found' status
 * (i.e. links were found but JDownloader was offline when we tried to send them)
 *
 * Accepts a pre-fetched movies array so the caller can share it with the rest
 * of the sync — avoids a second `getAllMovies()` round-trip.
 */
async function retryFailedJDownloaderSends(allMoviesArg?: Movie[]): Promise<void> {
  if (!jdownloaderService.isConfigured()) return;

  // --- Movies in 'found' status ---
  // SHOWS are intentionally excluded: a show carries an aggregate movie-level
  // status of 'found' whenever ANY of its seasons is 'found' (set by
  // processShowSeasons). Treating it as a movie here would lump EVERY season's
  // links into one movie-format package ("Title (Year) - quality", no season
  // suffix) AND flip the whole show to 'downloading' — then the per-season retry
  // loop below ALSO sends each season as "Title (Year) - Sxx - quality". addLinks
  // can't dedup the two name shapes against each other, so the show lands in JD
  // 2–3× (the FROM/Threesome duplicate bug). Shows are handled solely by the
  // per-season loop further down.
  const foundMovies = getMoviesByStatus('found').filter(m => m.media_type !== 'show');
  if (foundMovies.length > 0) {
    logger.info(`Retrying JDownloader send for ${foundMovies.length} movie(s) in 'found' status`);
    const downloadsByMovie = getDownloadsByMovieIds(foundMovies.map(m => m.id));

    for (const movie of foundMovies) {
      const allDownloads = downloadsByMovie.get(movie.id) || [];
      if (allDownloads.length === 0) continue;

      // Only the NEWEST release's links. Download rows are never deleted, so the
      // full set accumulates every release ever tried for this title — including
      // ones already proven dead and blocklisted. Re-sending all of them built a
      // single JD package mixing live links with known-offline ones, and named it
      // after whichever row happened to sort first.
      const downloads = downloadsForNewestRelease(allDownloads);
      if (downloads.length === 0) continue;

      const links = downloads.map(d => d.download_url);
      const quality = downloads[0].quality || '';
      const yearStr = movie.year != null ? ` (${movie.year})` : '';
      const packageName = `${movie.title}${yearStr} - ${quality}`;

      const result = await jdownloaderService.addLinks(links, packageName);
      if (result === 'sent') {
        updateMovieStatus(movie.id, 'downloading');
        updateDownloadStatusByMovieId(movie.id, 'sent_to_jd');
        addLogEntry(movie.id, 'sent_to_jdownloader', `Retry: sent ${links.length} link(s) to JDownloader`);
        logger.info(`Retry successful for ${movie.title}`);
      } else if (result === 'offline') {
        // The previously-found links died at the hoster — blocklist + re-search.
        blocklistDeadOnAdd(movie, downloads[0].release_name);
        updateMovieStatus(movie.id, 'pending');
        addLogEntry(movie.id, 'links_offline', `Retry: Release tot — alle Links offline, geblockt, neue Suche folgt`);
        logger.warn(`${movie.title}: retry found all links offline, blocklisted + reset to pending`);
      } else if (movie.last_checked_at) {
        // Reset to pending after 24h stuck in 'found' to allow re-search
        const stuckSince = Date.now() - parseUtcDate(movie.last_checked_at);
        if (stuckSince > 24 * 60 * 60 * 1000) {
          updateMovieStatus(movie.id, 'pending');
          addLogEntry(movie.id, 'auto_reset', `Reset to pending — stuck in 'found' for 24h+ (JDownloader offline)`);
          logger.warn(`${movie.title}: reset to pending after 24h in 'found' status`);
        }
      }
    }
  }

  // --- Show seasons in 'found' status (JD send failed for season pack/episode) ---
  const allMovies = allMoviesArg ?? getAllMovies();
  const shows = allMovies.filter(m => m.media_type === 'show');
  if (shows.length === 0) return;

  const showIds = shows.map(s => s.id);
  const seasonsByShow = getSeasonsByShowIds(showIds);
  const downloadsByShow = getDownloadsByMovieIds(showIds);

  for (const show of shows) {
    const seasons = seasonsByShow.get(show.id) || [];
    const foundSeasons = seasons.filter(s => s.status === 'found');
    if (foundSeasons.length === 0) continue;

    const downloads = downloadsByShow.get(show.id) || [];
    if (downloads.length === 0) continue;

    for (const season of foundSeasons) {
      // Only this season's links — downloads share movie_id across all of a show's
      // seasons, so an unscoped filter would send every season's links under one
      // season's package name (and duplicate them per found-season iteration).
      // ...and only that season's NEWEST release, for the same reason the movie
      // path scopes: older attempts for the same season are still on file and
      // may be blocklisted.
      const seasonDownloads = downloadsForNewestRelease(
        downloads.filter(d => d.download_url && d.season_number === season.season_number),
      );
      if (seasonDownloads.length === 0) continue;

      const links = seasonDownloads.map(d => d.download_url);
      const quality = seasonDownloads[0].quality || '';
      const sNum = String(season.season_number).padStart(2, '0');
      const yearStr = show.year != null ? ` (${show.year})` : '';
      const packageName = `${show.title}${yearStr} - S${sNum} - ${quality}`;

      const result = await jdownloaderService.addLinks(links, packageName);
      if (result === 'sent') {
        updateSeasonStatus(season.id, 'downloading');
        updateDownloadStatusBySeason(show.id, season.season_number, 'sent_to_jd');
        addLogEntry(show.id, 'sent_to_jdownloader', `S${sNum} retry: sent ${links.length} link(s) to JDownloader`);
        logger.info(`${show.title} S${sNum}: JD retry successful`);
      } else if (result === 'offline') {
        // The previously-found season links died at the hoster — blocklist + re-search.
        blocklistDeadOnAdd(show, seasonDownloads[0].release_name);
        updateSeasonStatus(season.id, 'pending');
        addLogEntry(show.id, 'links_offline', `S${sNum}: Release tot — alle Links offline, geblockt, neue Suche folgt`);
        logger.warn(`${show.title} S${sNum}: retry all links offline, blocklisted + reset to pending`);
      } else {
        // After 24h stuck in 'found', reset season to pending for re-search
        const stuckSince = season.last_checked_at
          ? Date.now() - parseUtcDate(season.last_checked_at) : Infinity;
        if (stuckSince > 24 * 60 * 60 * 1000) {
          updateSeasonStatus(season.id, 'pending');
          addLogEntry(show.id, 'auto_reset', `S${sNum}: reset to pending — stuck in 'found' 24h+`);
          logger.warn(`${show.title} S${sNum}: reset to pending after 24h in 'found' status`);
        }
      }
    }
  }
}

/**
 * Check downloaded movies for quality upgrades.
 * If a movie was downloaded in a lower quality than desired/maximum,
 * search again and upgrade if a better release is available.
 */
export async function checkQualityUpgrades(): Promise<void> {
  // Prune upgrade markers whose download already finished/failed (movie no
  // longer 'downloading'), so the set doesn't leak or over-shadow later checks.
  //
  // Runs BEFORE the auto-upgrade early return: with the prune behind it, turning
  // auto-upgrade off stranded every in-flight marker forever, and postprocess
  // skips any movie in this set — so those titles were permanently excluded from
  // the library-folder reconcile and got re-downloaded if they ever went pending.
  const stillDownloading = new Set(getMoviesByStatus('downloading').map(m => m.id));
  for (const id of upgradingMovies) if (!stillDownloading.has(id)) upgradingMovies.delete(id);

  const autoUpgrade = getSetting('quality.auto_upgrade');
  if (autoUpgrade !== 'true') return;

  const cutoff = getSetting('quality.cutoff') || getSetting('quality.maximum') || '2160p';
  const cutoffRank = QUALITY_RANK[cutoff] || 4;

  // Movies only. A show is tracked per season/episode, so a "better" show release
  // is just as likely to be a single episode or a different season — sending it as
  // a movie-style [UPGRADE] package (no season info) would flip the whole show to
  // 'downloading' and leave the post-processor unable to place the file.
  const downloadedMovies = getMoviesByStatus('downloaded').filter(m => m.media_type !== 'show');
  if (downloadedMovies.length === 0) return;

  logger.info(`Quality upgrade check: scanning ${downloadedMovies.length} downloaded movie(s) (cutoff: ${cutoff})`);

  const downloadsByMovie = getDownloadsByMovieIds(downloadedMovies.map(m => m.id));

  for (const movie of downloadedMovies) {
    const downloads = downloadsByMovie.get(movie.id) || [];
    if (downloads.length === 0) continue;

    // Determine the current downloaded quality. Prefer a row that actually
    // completed: rows are written per attempt, so on a DB that already carries a
    // stranded row from a failed upgrade (pre-fix), the newest row would claim a
    // quality that never landed and permanently skip this title.
    const completed = downloads.filter(d => d.status === 'completed');
    const currentQuality = (completed[0] || downloads[0]).quality || '';
    const currentRank = QUALITY_RANK[currentQuality] || 0;

    // Skip if already at or above cutoff
    if (currentRank >= cutoffRank) continue;

    logger.info(`Quality upgrade: ${movie.title} is ${currentQuality}, checking for higher quality...`);

    try {
      let upgradeGermanTitle: string | undefined;
      if (movie.media_type !== 'show' && movie.imdb_id) {
        upgradeGermanTitle = await getGermanTitleFromWikidata(movie.imdb_id) ?? undefined;
      }
      const mediaType = (movie.media_type || 'movie') as 'movie' | 'show';

      // Iterate plugins like processMovie does — first plugin with a
      // higher-quality release wins.
      let releases: ScrapedRelease[] = [];
      let upgradePlugin: SourcePlugin | null = null;
      for (const plugin of pluginRegistry.forMediaType(mediaType)) {
        try {
          const result = await withPluginTimeout('findReleases', PLUGIN_TIMEOUTS.findReleases, plugin.findReleases({
            title: movie.title,
            year: movie.year ?? undefined,
            imdbId: movie.imdb_id ?? undefined,
            mediaType,
            altTitle: upgradeGermanTitle,
          }, { skipLinkResolution: true }));
          if (result.releases.length > 0) {
            releases = result.releases;
            upgradePlugin = plugin;
            break;
          }
        } catch (err: any) {
          logger.debug(`Quality upgrade: plugin "${plugin.id}" failed for ${movie.title}: ${err?.message || err}`);
        }
      }
      if (releases.length === 0) continue;

      // Filter for strictly higher quality than current, up to cutoff — and drop
      // anything already blocklisted.
      //
      // processMovie applies this in three places; the upgrade path did not, so a
      // dead upgrade release was picked again on every scan. Observed on "Run":
      // the identical 1080p→2160p release was sent to JD, found 13/13 links
      // offline, blocklisted, and then chosen again hours later — and each round
      // re-stamped downloaded_at, so the title kept resurfacing under "recently
      // added".
      // Same arguments as the two calls in processMovie. Passing none meant the
      // per-title quality override was ignored here: a film deliberately set to
      // "relaxed" was still judged by the strict global rules when upgrading.
      const betterReleases = filterReleases(releases, 'movie', movie.quality_override)
        .filter(r => !isReleaseBlocklisted(r.title))
        .filter(r => {
          const rRank = QUALITY_RANK[r.quality] || 0;
          return rRank > currentRank && rRank <= cutoffRank;
        });

      if (betterReleases.length === 0) continue;

      const bestRelease = betterReleases[0];
      const enabledHosters = (getSetting('hosters.enabled') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

      // Resolve on demand — only now that we've committed to this upgrade.
      const directLinks = await resolveReleaseLinks(bestRelease, upgradePlugin, enabledHosters);

      if (directLinks.length === 0) continue;

      addLogEntry(movie.id, 'quality_upgrade',
        `Upgrading from ${currentQuality} to ${bestRelease.quality} | ${bestRelease.audio}`);
      logger.info(`Quality upgrade: ${movie.title} — ${currentQuality} → ${bestRelease.quality}`);

      // Send to JDownloader FIRST, and only record the upgrade's download rows
      // once it was accepted.
      //
      // Writing them up front meant a failed send still left a row carrying the
      // higher quality behind. `downloads[0]` is the newest row, so the next scan
      // read the movie as already upgraded (currentRank >= cutoffRank) and skipped
      // it forever — the real file stayed at the old quality and the UI reported
      // the one that never arrived.
      if (jdownloaderService.isConfigured()) {
        const yearStr = movie.year != null ? ` (${movie.year})` : '';
        const packageName = `${movie.title}${yearStr} - ${bestRelease.quality} [UPGRADE]`;
        const result = await jdownloaderService.addLinks(directLinks, packageName);
        if (result === 'sent') {
          for (const link of bestRelease.links.filter(l => (enabledHosters.length === 0 || enabledHosters.includes(l.hoster)))) {
            addDownload({
              movie_id: movie.id,
              release_name: bestRelease.title,
              quality: bestRelease.quality,
              audio: bestRelease.audio,
              hoster: link.hoster,
              download_url: link.url,
            });
          }
          updateMovieStatus(movie.id, 'downloading');
          updateDownloadStatusByMovieId(movie.id, 'sent_to_jd');
          // Mark the upgrade in flight so the library/provider checks don't flip
          // this movie back to 'downloaded' (the old file is still present).
          upgradingMovies.add(movie.id);
          addLogEntry(movie.id, 'sent_to_jdownloader',
            `Quality upgrade: sent ${directLinks.length} link(s) to JDownloader`);
        } else if (result === 'offline') {
          // Upgrade release is dead — blocklist it but keep the existing copy
          // (movie stays 'downloaded'); no status change, no downgrade.
          blocklistDeadOnAdd(movie, bestRelease.title);
          addLogEntry(movie.id, 'links_offline', 'Quality upgrade: Release tot — alle Links offline, geblockt (bestehende Kopie bleibt)');
          logger.warn(`Quality upgrade: ${movie.title} upgrade release all offline, blocklisted (keeping current copy)`);
        } else {
          addLogEntry(movie.id, 'jdownloader_error', 'Quality upgrade: failed to send links to JDownloader');
        }
      }
    } catch (error: any) {
      logger.error(`Quality upgrade error for ${movie.title}: ${error.message}`, { stack: error.stack });
      addLogEntry(movie.id, 'error', `Quality upgrade failed: ${error.message}`);
    }
  }
}

export async function runFullSync(): Promise<{ synced: number; processed: number }> {
  if (isRunning) {
    logger.warn('Sync already running, skipping');
    return { synced: 0, processed: 0 };
  }

  isRunning = true;
  cachedJdPackages = null;
  jdPackageProbeFailed = false;
  libraryPreloaded = false;
  const syncStart = Date.now();
  incrementMetric('syncRuns');
  logger.info('Starting full sync...');
  warnIfLibraryProviderMismatch();
  // hosters.enabled is vestigial: no UI writes it and each source plugin owns its
  // own hoster filtering ("hosters" plugin setting). It's never set in practice,
  // but if someone ever does (manual DB edit / future UI) and it disagrees with the
  // plugin, the host-side filter silently drops already-resolved links. Make that loud.
  if (getSetting('hosters.enabled')) {
    logger.warn('"hosters.enabled" is set on the host, but hoster filtering is owned by each source plugin (its own "hosters" setting). A host value that differs from the plugin silently drops already-resolved links — clear it unless you set it deliberately.');
  }
  addLogEntry(null, 'sync_started', 'Full sync started');
  eventBus.emit('sync:started', { timestamp: new Date().toISOString() });

  try {
    // Step 1: Sync watchlist (Trakt, Plex, or both)
    let synced = 0;
    synced += await syncWatchlistProviders();

    // Step 3 reads getAllMovies() and filters in-memory; pass it down to step 2
    // so the show-seasons retry loop reuses the same snapshot.
    const allMovies = getAllMovies();

    // Step 2: Retry movies in 'found' status where JDownloader was offline
    await retryFailedJDownloaderSends(allMovies);

    // Step 2.5: Backfill missing OMDb/Trakt metadata for movies that never got it
    // (bounded so a large library doesn't hammer OMDb in one run). Best-effort.
    // First resolve imdb ids for rows added without one (e.g. a Telegram pick that
    // matched a plugin candidate carrying no imdb id) — without it there's no
    // poster and metadata can't backfill — then enrich them in the same pass.
    const needImdb = allMovies.filter(m => !m.imdb_id && m.title).slice(0, 25);
    if (needImdb.length > 0) {
      logger.info(`Resolving imdb id for ${needImdb.length} movie(s) added without one`);
      for (const m of needImdb) {
        const resolved = await resolveMovieImdbId(m);
        if (resolved.imdb_id) await enrichMovieMetadata(resolved);
      }
    }
    const needMeta = allMovies.filter(m => !m.metadata_fetched_at && m.imdb_id).slice(0, 50);
    if (needMeta.length > 0) {
      logger.info(`Backfilling metadata for ${needMeta.length} movie(s)`);
      for (const m of needMeta) await enrichMovieMetadata(m);
    }

    // Step 2.7: Endkontrolle — flag episodes an earlier premature move left
    // truncated (size outlier vs season siblings), quarantine them and reset to
    // 'pending' so Step 3 re-downloads them in this same pass. Best-effort.
    try {
      const integrity = runIntegrityCheck();
      if (integrity.flagged.length > 0) {
        addLogEntry(null, 'integrity_check',
          `${integrity.flagged.length} unvollständige Folge(n) erkannt — werden neu geladen`);
      }
    } catch (err: any) {
      logger.debug(`Integrity check failed: ${err.message}`);
    }

    // Step 2.8: Audio-language verification (opt-in, integrity.verify_language).
    // Flags downloaded titles whose audio tracks carry no wanted-language tag —
    // a mislabeled-language release. Warn-only; best-effort, never blocks sync.
    try {
      await runAudioLanguageCheck();
    } catch (err: any) {
      logger.debug(`Audio-language check failed: ${err.message}`);
    }

    // Step 3: Process pending, not_found, and active shows with controlled concurrency
    // Single query, filter in-memory to avoid 4 separate DB queries
    const moviesToProcess = allMovies.filter(m =>
      m.status === 'pending' || m.status === 'not_found' ||
      (m.media_type === 'show' && ['downloaded', 'downloading', 'searching'].includes(m.status))
    );

    logger.info(`Processing ${moviesToProcess.length} movie(s)`);

    let processed = 0;

    const total = moviesToProcess.length;
    await Promise.allSettled(
      moviesToProcess.map(movie =>
        movieQueue(async () => {
          try {
            await processMovie(movie);
            processed++;
            eventBus.emit('sync:progress', { processed, total });
          } catch (error: any) {
            logger.error(`Error processing ${movie.title}: ${error.message}`, { stack: error.stack });
            addLogEntry(movie.id, 'error', error.message);
            processed++;
            eventBus.emit('sync:progress', { processed, total });
          }
        })
      )
    );

    // Step 4: Check for quality upgrades on already-downloaded movies
    await checkQualityUpgrades();

    // Step 5: Mirror progress back to Seerr so its request list reflects
    // reality. Reconcile-style: a push missed here heals on the next cycle.
    await pushSeerrStatus();

    const duration = Date.now() - syncStart;
    setMetric('lastSyncDurationMs', duration);
    setMetric('lastSyncAt', new Date().toISOString());
    addLogEntry(null, 'sync_completed', `Sync done: ${synced} new, ${processed} processed (${Math.round(duration / 1000)}s)`);
    eventBus.emit('sync:completed', { synced, processed, durationMs: duration });
    return { synced, processed };
  } finally {
    isRunning = false;
    cachedJdPackages = null;
    jdPackageProbeFailed = false;
    libraryPreloaded = false;
  }
}

/**
 * Sync watchlist from configured providers (Trakt, Plex, or both)
 */
async function syncWatchlistProviders(): Promise<number> {
  const provider = getSetting('watchlist.provider') || 'trakt';
  let synced = 0;

  if ((provider === 'trakt' || provider === 'both') && traktService.isConfigured()) {
    synced += await traktService.syncWatchlist();
  }
  if ((provider === 'plex' || provider === 'both') && plexService.isConfigured()) {
    synced += await plexService.syncWatchlist();
  }
  if (provider === 'seerr' && seerrService.isConfigured()) {
    synced += await seerrService.syncWatchlist();
    // Viewer reports are checked on the same cadence, so the feature also works
    // for anyone who never set the webhook up. Inert unless switched on.
    try {
      const { processSeerrIssues } = await import('./seerrIssues');
      const handled = await processSeerrIssues();
      if (handled > 0) logger.info(`Seerr: acted on ${handled} viewer report(s)`);
    } catch (error: any) {
      logger.debug(`Seerr issue sweep failed: ${error?.message || error}`);
    }
  }

  if (synced > 0) {
    logger.info(`Synced ${synced} new movie(s) from watchlist`);
  }
  return synced;
}

/**
 * Mirrors dlvault's state back into Seerr's request list.
 *
 * Called after processing rather than during the watchlist pull, because the
 * statuses worth reporting ("downloading", "available") are exactly the ones
 * that changed while this run was working.
 */
async function pushSeerrStatus(): Promise<void> {
  const provider = getSetting('watchlist.provider') || 'trakt';
  if (provider !== 'seerr' || !seerrService.isConfigured()) return;
  try {
    const pushed = await seerrService.pushStatusUpdates();
    if (pushed > 0) logger.info(`Seerr: reported ${pushed} status change(s)`);
  } catch (error: any) {
    // Never let a reporting failure abort a sync that otherwise succeeded.
    logger.debug(`Seerr status push failed: ${error?.message || error}`);
  }
}

/**
 * Runs one watchlist pass on demand.
 *
 * Exposed so the Seerr webhook can act the moment a request is approved instead
 * of waiting out the two-minute poll. Deliberately the *same* routine the timer
 * uses — a push path with its own logic would be a second thing to keep correct.
 */
export async function runWatchlistCheck(): Promise<void> {
  await checkForNewMovies();
}

// Lightweight poll: check watchlist for new movies every 2 minutes
async function checkForNewMovies(): Promise<void> {
  if (isRunning) return;

  const provider = getSetting('watchlist.provider') || 'trakt';
  const hasProvider =
    ((provider === 'trakt' || provider === 'both') && traktService.isConfigured() && traktService.isAuthenticated()) ||
    ((provider === 'plex' || provider === 'both') && plexService.isConfigured()) ||
    (provider === 'seerr' && seerrService.isConfigured());

  if (!hasProvider) return;

  try {
    const newCount = await syncWatchlistProviders();

    // A title can be tracked but never actually processed: if the process stops
    // between the sync that adds it and the tick that would handle it, it sits
    // at 'pending' with last_checked_at NULL — and the early return below then
    // skipped it until the 24h full sync. Up to a day of silence is tolerable
    // for a watchlist; for a request someone just made it is not.
    const pendingMovies = getMoviesByStatus('pending');
    const neverChecked = pendingMovies.filter(m => !m.last_checked_at);
    if (newCount === 0 && neverChecked.length === 0) return;

    if (newCount > 0) {
      logger.info(`Watchlist monitor: ${newCount} new movie(s) detected, processing immediately`);
    } else {
      logger.info(`Watchlist monitor: picking up ${neverChecked.length} title(s) that were queued but never processed`);
    }

    await Promise.allSettled(
      pendingMovies.map(movie =>
        movieQueue(async () => {
          try {
            await processMovie(movie);
          } catch (error: any) {
            logger.error(`Error processing ${movie.title}: ${error.message}`, { stack: error.stack });
            addLogEntry(movie.id, 'error', error.message);
          }
        })
      )
    );
  } catch (error: any) {
    logger.error('Watchlist monitor error:', error.message);
  }
}

let watchlistCheckRunning = false;

async function safeCheckForNewMovies(): Promise<void> {
  // Skip watchlist check while full sync is running to avoid concurrent processMovie() calls
  if (isRunning) {
    logger.debug('Watchlist monitor skipped — full sync is running');
    return;
  }
  if (watchlistCheckRunning) return;
  watchlistCheckRunning = true;
  try {
    await checkForNewMovies();
  } catch (error: any) {
    logger.error('Watchlist monitor unexpected error:', error.message);
  } finally {
    watchlistCheckRunning = false;
  }
}

function startWatchlistMonitor(): void {
  stopWatchlistMonitor();
  // Check every 2 minutes for new watchlist entries (overlap-safe)
  watchlistMonitor = setInterval(() => { safeCheckForNewMovies(); }, 2 * 60 * 1000);
  // Also run once shortly after startup
  watchlistStartupTimer = setTimeout(() => { safeCheckForNewMovies(); }, 10_000);
  logger.info('Watchlist monitor started (checking every 2 min)');
}

function stopWatchlistMonitor(): void {
  if (watchlistMonitor) {
    clearInterval(watchlistMonitor);
    watchlistMonitor = null;
  }
  if (watchlistStartupTimer) {
    clearTimeout(watchlistStartupTimer);
    watchlistStartupTimer = null;
  }
}

/**
 * Re-process pending/not_found titles whose exponential-backoff window has
 * elapsed — far more often than the daily full sync.
 *
 * processMovie's per-movie backoff (1h, 2h, 4h … capped 48h) was written to
 * PACE retries, but nothing fired often enough to honor it: not_found titles
 * were only reprocessed by the 24h sync, so a dead first release (every hoster
 * link offline → blocklisted by the post-processor) left a title looking stuck
 * for up to a day. This monitor activates that backoff design: a freshly-failed
 * title retries within the hour, a
 * persistently-failing one backs off to 48h on its own. The backoff guard
 * inside processMovie does the per-title pacing, so a tick where nothing is due
 * is nearly free (a DB read + cheap skips, no source queries). Active shows and
 * downloads stay on their own cadences — only the genuinely-stuck buckets here.
 */
export async function runRetryMonitor(): Promise<void> {
  if (isRunning) return;            // full sync owns processMovie + the JD cache
  if (retryMonitorRunning) return;  // don't stack ticks
  retryMonitorRunning = true;
  cachedJdPackages = null;          // fresh JD snapshot for this pass
  jdPackageProbeFailed = false;
  try {
    const due = getAllMovies().filter(m => m.status === 'pending' || m.status === 'not_found');
    if (due.length === 0) return;
    await Promise.allSettled(
      due.map(movie =>
        movieQueue(async () => {
          try {
            await processMovie(movie);
          } catch (error: any) {
            logger.error(`Retry monitor: error processing ${movie.title}: ${error.message}`, { stack: error.stack });
            addLogEntry(movie.id, 'error', error.message);
          }
        }),
      ),
    );
  } finally {
    retryMonitorRunning = false;
    cachedJdPackages = null;
    jdPackageProbeFailed = false;
  }
}

export function startScheduler(): void {
  stopScheduler();

  // Reset movies stuck in 'searching' from a previous crash/restart
  const stuckSearching = getMoviesByStatus('searching');
  for (const movie of stuckSearching) {
    updateMovieStatus(movie.id, 'pending');
    logger.info(`Reset stuck movie: ${movie.title} (searching → pending)`);
  }

  // Clamp: `scheduler.interval_hours` reaches us straight from PATCH /api/settings,
  // which only prefix-validates keys. "0" built the cron expression `0 */0 * * *`,
  // which node-cron throws on — and startScheduler() has already called
  // stopScheduler(), so the full sync, watchlist monitor, JD watchdog, retry
  // monitor and canary all stayed dead until the container was restarted.
  const rawInterval = parseInt(getSetting('scheduler.interval_hours') || '24', 10);
  const intervalHours = configuredIntervalHours();
  if (intervalHours !== rawInterval) {
    logger.warn(`scheduler.interval_hours is "${getSetting('scheduler.interval_hours')}" — not a usable interval, falling back to ${intervalHours}h`);
  }
  const enabled = getSetting('scheduler.enabled') !== 'false';

  if (!enabled) {
    logger.info('Scheduler is disabled');
    return;
  }

  // Full sync every N hours (re-checks not_found movies etc.)
  const cronExpression = intervalHours >= 24
    ? '0 3 * * *'  // Daily at 3 AM
    : `0 */${intervalHours} * * *`;

  // Belt and braces alongside the clamp above: a cron expression this function
  // can't schedule must not take every OTHER scheduled task down with it.
  try {
    scheduledTask = cron.schedule(cronExpression, async () => {
      try {
        logger.info('Scheduled full sync triggered');
        await runFullSync();
      } catch (error: any) {
        logger.error('Scheduled sync failed:', error.message);
      }
    });
  } catch (error: any) {
    logger.error(`Could not schedule the full sync with "${cronExpression}": ${error.message} — falling back to daily at 03:00`);
    scheduledTask = cron.schedule('0 3 * * *', async () => {
      try {
        await runFullSync();
      } catch (err: any) {
        logger.error('Scheduled sync failed:', err.message);
      }
    });
  }

  // Start the lightweight watchlist monitor
  startWatchlistMonitor();

  // Periodic health monitor — runs every 15 min, alerts Telegram if captcha
  // or move failure rates spike. Opt-out via scheduler.health_monitor_enabled=false.
  const healthMonitorEnabled = getSetting('scheduler.health_monitor_enabled') !== 'false';
  if (healthMonitorEnabled) {
    // noOverlap: if a prior tick is still active (e.g. event loop blocked by
    // slow plugin resolution), node-cron skips the new tick rather than stacking.
    healthMonitorTask = cron.schedule('*/15 * * * *', async () => {
      try {
        await runHealthMonitor();
      } catch (error: any) {
        logger.error(`Health monitor failed: ${error.message}`);
      }
    }, { noOverlap: true });
  }

  // JD watchdog — every 5 min: update-availability badge, offline alert, and
  // post-recovery auto-resume. Lightweight (one connect + a couple of cheap
  // calls); only does anything when JDownloader is configured.
  jdMonitorTask = cron.schedule('*/5 * * * *', async () => {
    try {
      await runJdMonitor();
    } catch (error: any) {
      logger.error(`JD monitor failed: ${error.message}`);
    }
  }, { noOverlap: true });
  // Populate the dashboard badge shortly after startup instead of waiting 5 min.
  jdMonitorStartupTimer = setTimeout(() => { runJdMonitor().catch(() => { /* logged inside */ }); }, 20_000);

  // Retry monitor — every 30 min: re-process pending/not_found titles whose
  // backoff has elapsed, so a dead first release recovers within the hour
  // instead of waiting for the daily sync. Per-title backoff inside processMovie
  // keeps source load bounded (idle ticks cost only a DB read).
  retryMonitorTask = cron.schedule('*/30 * * * *', async () => {
    try {
      await runRetryMonitor();
    } catch (error: any) {
      logger.error(`Retry monitor failed: ${error.message}`);
    }
  }, { noOverlap: true });

  // Source canary — every 6 h, offset from the 3 AM full sync. Deep-path probe
  // against each plugin's fixed always-available title; no-op for plugins that
  // don't implement canaryCheck. Deliberately NOT run at startup: a container
  // restart shouldn't cost a browser/solver round.
  const canaryEnabled = getSetting('scheduler.canary_enabled') !== 'false';
  if (canaryEnabled) {
    canaryMonitorTask = cron.schedule('20 */6 * * *', async () => {
      try {
        await runCanaryMonitor();
      } catch (error: any) {
        logger.error(`Canary monitor failed: ${error.message}`);
      }
    }, { noOverlap: true });
  }

  logger.info(`Scheduler started: full sync every ${intervalHours}h, watchlist monitor every 2 min, JD monitor every 5 min, retry monitor every 30 min${healthMonitorEnabled ? ', health monitor every 15 min' : ''}${canaryEnabled ? ', source canary every 6 h' : ''}`);
}

export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  if (healthMonitorTask) {
    healthMonitorTask.stop();
    healthMonitorTask = null;
  }
  if (jdMonitorTask) {
    jdMonitorTask.stop();
    jdMonitorTask = null;
  }
  if (jdMonitorStartupTimer) {
    clearTimeout(jdMonitorStartupTimer);
    jdMonitorStartupTimer = null;
  }
  if (retryMonitorTask) {
    retryMonitorTask.stop();
    retryMonitorTask = null;
  }
  if (canaryMonitorTask) {
    canaryMonitorTask.stop();
    canaryMonitorTask = null;
  }
  stopWatchlistMonitor();
  logger.info('Scheduler stopped');
}

/**
 * Check recent activity_log for elevated failure rates and alert Telegram when
 * thresholds are crossed. Scoped to the ACTIONABLE failure modes:
 *   - JDownloader send failures → `jdownloader_error` (pipeline) or
 *     `jdownloader_failed` (manual search UI) — both count toward one threshold
 *   - 2Captcha / link-resolution failures → `captcha_pending`
 *   - source-scrape block (page found, 0 releases readable) → `scrape_blocked`,
 *     counted across DISTINCT titles (early-warning for a CF/token wall)
 *
 * Deliberately does NOT alert on `not_found`: a not-found spike is normal
 * operation (titles not yet released, or simply absent at the source), not a
 * fault the owner can act on — it only produced notification noise. The
 * `scrape_blocked` signal is the deliberate opposite: a title that isn't released
 * yet exits as `not_found` (sourceUrl=null), so it never inflates this counter —
 * only titles whose page WAS reachable but unreadable do.
 *
 * Alerts cool down for one hour per overall status so an ongoing outage
 * notifies once, not every 15 minutes.
 */
export async function runHealthMonitor(): Promise<void> {
  const now = Date.now();
  // Match SQLite's space-separated UTC format so the last-hour window actually
  // matches stored created_at values — see toSqliteUtc().
  const windowStart = toSqliteUtc(new Date(now - 60 * 60 * 1000)); // last hour

  // Count failure-flavoured actions in the last hour.
  //
  // Both JD action names are counted. `jdownloader_failed` is written only by the
  // manual "search & send" UI route; every automated send failure in the pipeline
  // logs `jdownloader_error`. Watching only the first name meant a night where
  // JDownloader refused every single add produced exactly zero alerts.
  const counts = db.prepare(`
    SELECT action, COUNT(*) as count
    FROM activity_log
    WHERE created_at >= ?
      AND action IN ('jdownloader_failed', 'jdownloader_error', 'captcha_pending')
    GROUP BY action
  `).all(windowStart) as { action: string; count: number }[];

  const byAction = Object.fromEntries(counts.map(r => [r.action, r.count])) as Record<string, number>;
  const jdFailed = (byAction.jdownloader_failed || 0) + (byAction.jdownloader_error || 0);
  const captchaPending = byAction.captcha_pending || 0;

  // Scrape-block signature: DISTINCT titles whose source page was found but
  // yielded zero readable releases (CF challenge / token-extraction failure /
  // goto timeout). Counted DISTINCT so one stuck title retrying every cycle
  // can't trip it — a systemic block hits MANY different titles at once, while
  // a not-yet-released title never emits this action (it exits as 'not_found',
  // sourceUrl=null). This is the early-warning the 2026-07 CF outage lacked.
  const blockedTitles = (db.prepare(`
    SELECT COUNT(DISTINCT movie_id) as n
    FROM activity_log
    WHERE created_at >= ? AND action = 'scrape_blocked'
  `).get(windowStart) as { n: number }).n;

  const problems: string[] = [];
  if (jdFailed >= 5) problems.push(`${jdFailed}× jdownloader_failed`);
  if (captchaPending >= 5) problems.push(`${captchaPending}× captcha_pending`);
  // ≥3 DISTINCT titles finding a page but reading no releases = the source is
  // very likely blocking us (challenge/token wall), not "nothing released".
  if (blockedTitles >= 3) problems.push(`${blockedTitles} Titel: Seite gefunden, keine Releases lesbar (Quelle evtl. blockiert)`);

  if (problems.length === 0) {
    // Everything healthy — if we previously alerted, clear the cooldown state so
    // a future recovery-then-regression still alerts promptly.
    lastHealthAlertOverall = null;
    return;
  }

  const severity = problems.length >= 2 ? 'unhealthy' : 'degraded';

  // Rate-limit: skip if we already sent the same severity within the cooldown.
  if (severity === lastHealthAlertOverall && (now - lastHealthAlertAt) < HEALTH_ALERT_COOLDOWN_MS) {
    logger.debug(`Health monitor: ${severity} — suppressed (cooldown active)`);
    return;
  }

  const icon = severity === 'unhealthy' ? '🚨' : '⚠️';
  const text = `${icon} <b>dlvault health</b>\nLast hour: ${problems.join(', ')}.\nCheck logs and <code>/api/health/deep</code>.`;

  logger.warn(`Health monitor: ${severity} — ${problems.join(', ')}`);
  try {
    const { sendTelegramSystemAlert } = await import('./telegram');
    await sendTelegramSystemAlert(text);
    lastHealthAlertAt = now;
    lastHealthAlertOverall = severity;
  } catch (err: any) {
    logger.error(`Failed to send health alert to Telegram: ${err.message}`);
  }
}

/**
 * Deep-path source canary (every 6 h). Plugins may expose canaryCheck(), which
 * exercises the FULL discovery path — search, detail page, release extraction —
 * against a fixed, permanently available title of the plugin's choosing. This
 * closes the gap the cheap healthCheck() leaves: during the 2026-07 challenge
 * wall the search API kept answering while the release path was blocked, and a
 * queue of not-yet-released titles can't tell "nothing to find" from "blocked".
 * The canary title always has releases, so reading zero IS the block signature —
 * a definitive complement to the passive scrape_blocked counter in
 * runHealthMonitor, which needs several real titles to fail first.
 *
 * A failed probe is retried once immediately (a transient challenge-solver
 * hiccup usually clears on a fresh attempt), then alerts Telegram once per
 * outage; the first success afterwards notifies recovery. Opt out via
 * scheduler.canary_enabled=false.
 */
export async function runCanaryMonitor(): Promise<void> {
  if (getSetting('scheduler.canary_enabled') === 'false') return;

  const plugins = pluginRegistry.getAll()
    .filter(p => typeof p.canaryCheck === 'function' && pluginRegistry.isEnabled(p.id));

  for (const plugin of plugins) {
    let outcome: PluginHealthOutcome = { ok: false, critical: true, error: 'not run' };
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        outcome = await withPluginTimeout(
          `${plugin.id}.canaryCheck`,
          PLUGIN_TIMEOUTS.canaryCheck,
          plugin.canaryCheck!(),
        );
      } catch (err: any) {
        outcome = { ok: false, critical: true, error: err?.message || String(err) };
      }
      if (outcome.ok) break;
      if (attempt === 1) {
        logger.warn(`Canary ${plugin.id}: probe failed (${outcome.error}) — retrying once`);
      }
    }

    const prev = canaryStates.get(plugin.id);
    const state: CanaryState = {
      ok: outcome.ok,
      error: outcome.error ?? null,
      detail: outcome.detail ?? null,
      lastRunAt: Date.now(),
      alerted: prev?.alerted ?? false,
    };

    if (!state.ok) {
      logger.warn(`Canary ${plugin.id}: FAILED after retry — ${state.error}`);
      if (!state.alerted) {
        state.alerted = true;
        addLogEntry(null, 'canary_failed', `${plugin.name}: Kontroll-Titel nicht lesbar — ${state.error}`);
        try {
          const { sendTelegramSystemAlert } = await import('./telegram');
          await sendTelegramSystemAlert(
            '🚨 <b>Quelle vermutlich blockiert</b>\n'
            + `${plugin.name}: Der Kontroll-Titel (dauerhaft verfügbar) ist über den kompletten `
            + 'Suchpfad nicht mehr lesbar. Das deutet auf eine neue Sperre der Quelle hin — '
            + `nicht auf fehlende Releases.\nFehler: <code>${state.error}</code>`,
          );
        } catch (err: any) {
          logger.error(`Failed to send canary alert to Telegram: ${err.message}`);
        }
      }
    } else {
      logger.info(`Canary ${plugin.id}: ok (${state.detail ?? 'no detail'})`);
      if (prev?.alerted) {
        state.alerted = false;
        addLogEntry(null, 'canary_recovered', `${plugin.name}: Kontroll-Titel wieder lesbar`);
        try {
          const { sendTelegramSystemAlert } = await import('./telegram');
          await sendTelegramSystemAlert(
            '✅ <b>Quelle wieder lesbar</b>\n'
            + `${plugin.name}: Der Kontroll-Titel ist wieder über den kompletten Suchpfad abrufbar.`,
          );
        } catch (err: any) {
          logger.error(`Failed to send canary recovery to Telegram: ${err.message}`);
        }
      }
    }

    canaryStates.set(plugin.id, state);
  }
}

/**
 * Periodic JD watchdog (every 5 min). Three jobs:
 *   1. Update badge   — surface JD's self-update availability to the dashboard.
 *   2. Offline alert  — Telegram-notify when JD drops offline (e.g. killed by its
 *                       own update), once per outage (cooldown), not every tick.
 *   3. Auto-resume    — when JD comes back from being unreachable in a non-running
 *                       state with a queue intact, kick downloads again. This is
 *                       deliberately recovery-only: a *deliberate* user stop during
 *                       normal operation produces no offline transition, so we
 *                       never override it. Opt out via jdownloader.auto_resume=false.
 *
 * Note: the MyJDownloader API talks *through* a running JD — a fully dead JD can't
 * be started from here (nothing is listening). The offline alert is the realistic
 * version of "start JD for me": it tells the owner to start it; auto-resume then
 * picks the queue back up once it's running again.
 */
export async function runJdMonitor(): Promise<void> {
  if (!jdownloaderService.isConfigured()) return;

  const reachable = await jdownloaderService.connect();
  const wasReachable = jdLastReachable;

  if (!reachable) {
    // Can't know update status while JD is gone — clear the badge so the
    // dashboard doesn't show a stale "update available".
    jdUpdateAvailable = false;
    jdConsecutiveFailures++;
    const now = Date.now();
    // Alert only once the outage has persisted across ≥2 probes (debounce), and
    // only once per outage (jdOfflineAlerted), rate-limited to 1×/hour so a
    // flapping relay can't spam. A lone transient probe timeout never alerts.
    if (
      jdConsecutiveFailures >= JD_OFFLINE_ALERT_THRESHOLD
      && !jdOfflineAlerted
      && (now - jdOfflineAlertedAt) > JD_OFFLINE_ALERT_COOLDOWN_MS
    ) {
      jdOfflineAlertedAt = now;
      jdOfflineAlerted = true;
      logger.warn(`JD monitor: JDownloader is not reachable (${jdConsecutiveFailures} consecutive probe failures)`);
      try {
        const { sendTelegramSystemAlert } = await import('./telegram');
        await sendTelegramSystemAlert(
          '🔌 <b>JDownloader nicht erreichbar</b>\n'
          + 'JDownloader antwortet nicht — evtl. durch ein Update oder einen Absturz beendet. '
          + 'Bitte JD wieder starten; laufende Downloads werden danach automatisch fortgesetzt.',
        );
      } catch (err: any) {
        logger.error(`Failed to send JD-offline alert to Telegram: ${err.message}`);
      }
    } else if (jdConsecutiveFailures < JD_OFFLINE_ALERT_THRESHOLD) {
      logger.debug(`JD monitor: probe failed (${jdConsecutiveFailures}/${JD_OFFLINE_ALERT_THRESHOLD}) — transient, not alerting yet`);
    }
    jdLastReachable = false;
    return;
  }

  const recovered = wasReachable === false; // offline → online transition
  jdConsecutiveFailures = 0;
  jdOfflineAlerted = false;
  jdLastReachable = true;

  // ── 1. Update availability ──
  try {
    const now = Date.now();
    // Force a fresh check after any restart (recovery) or post user-triggered
    // update (jdLastUpdateCheckAt reset to 0) — otherwise JD's stale "update
    // available" flag lingers and the dashboard banner gets stuck. Otherwise
    // just nudge a fresh check a few times a day.
    if (recovered || jdLastUpdateCheckAt === 0 || now - jdLastUpdateCheckAt > JD_UPDATE_CHECK_INTERVAL_MS) {
      await jdownloaderService.runUpdateCheck();
      jdLastUpdateCheckAt = now;
    }
    const available = await jdownloaderService.isUpdateAvailable();
    // Within the post-update grace window, ignore JD's flag — it can read stale
    // true until JD finishes re-evaluating against the new version.
    jdUpdateAvailable = Date.now() < jdUpdateSuppressedUntil ? false : available;
  } catch (err: any) {
    logger.debug(`JD monitor: update check failed: ${err.message}`);
  }

  // ── 3. Auto-resume after recovery ──
  if (recovered && getSetting('jdownloader.auto_resume') !== 'false') {
    try {
      const state = (await jdownloaderService.getCurrentState() || '').toUpperCase();
      if (!state.includes('RUNNING')) {
        const pkgs = await jdownloaderService.getDownloadPackages();
        const hasPending = (pkgs ?? []).some(p => !p.finished);
        if (hasPending) {
          const ok = await jdownloaderService.startDownloads();
          if (ok) {
            logger.info(`JD monitor: JDownloader recovered in "${state || 'unknown'}" state with pending downloads — auto-resumed`);
            addLogEntry(null, 'jdownloader_resumed', 'Downloads nach JD-Neustart automatisch fortgesetzt');
          }
        }
      }
    } catch (err: any) {
      logger.debug(`JD monitor: auto-resume failed: ${err.message}`);
    }
  }
}

export function isSchedulerRunning(): boolean {
  return scheduledTask !== null;
}

export function isSyncRunning(): boolean {
  return isRunning;
}
