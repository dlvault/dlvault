import cron, { type ScheduledTask } from 'node-cron';
import pLimit from 'p-limit';
import { getSetting } from '../database/index';
import db from '../database/index';
import { getAllMovies, getMoviesByStatus, getMovieById, updateMovieStatus, updateLastChecked, incrementRetryCount, resetRetryCount, Movie } from '../database/services/movies';
import { addDownload, getDownloadsByMovieId, getDownloadsByMovieIds, updateDownloadStatusByMovieId } from '../database/services/downloads';
import { addLogEntry } from '../database/services/activityLog';
import { getSeasonsByShowId, getSeasonsByShowIds, updateSeasonStatus, updateSeasonLastChecked, updateSeasonEpisodeCount, Season } from '../database/services/seasons';
import { getEpisodesBySeasonId, getPendingEpisodes, addEpisodes, updateEpisodeStatus, getSeasonCompletionStatus } from '../database/services/episodes';
import { traktService } from './trakt';
import { plexService } from './plex';
import type { ScrapedRelease } from '../scraper/constants';
import { QUALITY_RANK } from '../scraper/constants';
import { filterReleases, filterReleasesWithStats } from '../scraper/filter';
import { pluginRegistry } from '../plugins/registry';
import type { SourcePlugin, HosterLink } from '../plugins/types';
import { jdownloaderService } from '../jdownloader/index';
import { getLibraryProvider, getLibraryProviderName } from './libraryProvider';
import { logger } from '../utils/logger';
import { toSqliteUtc, parseUtcDate } from '../utils/datetime';
import { incrementMetric, setMetric } from './metrics';
import { eventBus } from './eventbus';
import { isReleaseBlocklisted } from '../database/services/blocklist';
import { getGermanTitleFromWikidata } from './wikidata';
import { reconcileEpisodesWithLibrary } from './libraryReconcile';

let scheduledTask: ScheduledTask | null = null;
let healthMonitorTask: ScheduledTask | null = null;
let watchlistMonitor: NodeJS.Timeout | null = null;
let watchlistStartupTimer: NodeJS.Timeout | null = null;
let isRunning = false;

// Health monitor state — rate-limit alerts so we don't spam Telegram every 15
// minutes for the same ongoing outage.
let lastHealthAlertAt = 0;
let lastHealthAlertOverall: string | null = null;
const HEALTH_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour per status

/** Test helper — reset cooldown state so tests can exercise multiple alerts. */
export function _resetHealthMonitorState(): void {
  lastHealthAlertAt = 0;
  lastHealthAlertOverall = null;
}

/** Test helper — clear the per-sync caches that otherwise leak between unit tests. */
export function _resetSyncCaches(): void {
  cachedJdPackages = null;
  libraryPreloaded = false;
}
export const processingMovies = new Set<number>();
const movieQueue = pLimit(3); // Shared concurrency limiter for all movie processing

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
 * input — returning those would send raw filecrypt/redirect URLs to JDownloader.
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
  const resolved = validateHosterLinks(await activePlugin.resolveLinks(candidates), activePlugin.id);
  release.links = resolved;
  return resolved.filter(l => allowed(l.hoster)).map(l => l.url);
}

// Per-sync caches — populated once at sync start, cleared at end
let cachedJdPackages: { name: string; bytesTotal?: number; childCount?: number }[] | null = null;
let libraryPreloaded = false;

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

  // Skip movies that have been retried too many times (max 10 retries)
  const MAX_RETRIES = 10;
  if (freshMovie.retry_count >= MAX_RETRIES) {
    logger.debug(`Skipping ${freshMovie.title} - max retries reached (${freshMovie.retry_count})`);
    processingMovies.delete(movie.id);
    return;
  }

  // Exponential backoff: skip if not enough time has passed since last check
  if (freshMovie.retry_count > 0 && freshMovie.last_checked_at) {
    const lastChecked = parseUtcDate(freshMovie.last_checked_at);
    const backoffHours = Math.min(Math.pow(2, freshMovie.retry_count - 1), 48); // 1h, 2h, 4h, 8h, ... max 48h
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
    if (inLibrary) {
      const providerName = getLibraryProviderName();
      updateMovieStatus(movie.id, 'downloaded');
      addLogEntry(movie.id, 'already_in_library', `${movie.title} already exists in ${providerName}`);
      logger.info(`Skipping ${movie.title} — already in ${providerName} library`);
      processingMovies.delete(movie.id);
      return;
    }
  }

  // Skip if movie already has a package in JDownloader (uses cached package list)
  if (jdownloaderService.isConfigured()) {
    try {
      // JD rewrites ":" to ";" in package names — match what JD echoes back.
      const packageName = `${movie.title.replace(/:/g, ';')} (${movie.year})`;
      if (!cachedJdPackages) {
        const [dlPkgs, lgPkgs] = await Promise.all([
          jdownloaderService.getDownloadPackages(),
          jdownloaderService.getLinkGrabberPackages(),
        ]);
        // Cache only if BOTH queries succeeded — a partial result risks treating
        // a transiently-missing package as "no duplicate" and re-sending.
        cachedJdPackages = (dlPkgs !== null && lgPkgs !== null) ? [...dlPkgs, ...lgPkgs] : null;
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
    // Don't flip already-downloaded shows to 'searching' — they're just being re-checked for
    // new episodes. Changing the status confuses the UI and can cause orphaned 'searching' state
    // if the re-check short-circuits (no pending seasons).
    if (!isShow || freshMovie.status !== 'downloaded') {
      updateMovieStatus(movie.id, 'searching');
      eventBus.emit('movie:updated', { id: movie.id, title: movie.title, status: 'searching' });
    }

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
        result = await plugin.findReleases(
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
        );
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
      // user's quality filter. Otherwise a source that returns only junk (e.g.
      // a single 'complete' disc rip below the quality floor) would pre-empt a
      // later source that actually has the wanted release — the bug that left
      // well-seeded titles "not found". We still remember the first non-empty
      // set as a fallback so the UI keeps a source link and the failure log can
      // report an honest quality breakdown.
      const survivors = filterReleases(result.releases, mediaType);
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
      updateMovieStatus(movie.id, 'not_found');
      updateLastChecked(movie.id);
      const retries = incrementRetryCount(movie.id);
      addLogEntry(movie.id, 'not_found', `${movie.title} not found (retry ${retries}/${MAX_RETRIES})`);
      eventBus.emit('movie:updated', { id: movie.id, title: movie.title, status: 'not_found' });
      return;
    }

    // Step 3: Filter by quality/audio/language, then exclude blocklisted releases.
    // Pure ScrapedRelease[] in / out — no source-specific knowledge.
    const { releases: filteredRaw, stats } = filterReleasesWithStats(releases, mediaType);
    const filtered = filteredRaw.filter(r => !isReleaseBlocklisted(r.title));

    if (filtered.length === 0) {
      updateMovieStatus(movie.id, 'not_found', url);
      updateLastChecked(movie.id);
      incrementRetryCount(movie.id);
      const availableHosters = [...new Set(releases.flatMap(r => r.links.map(l => l.hoster)))].join(', ') || 'none';
      const qualitySummary = releases.map(r => `${r.quality}/${r.audio}/${r.language}`).join(', ');

      // Pinpoint the dominant failure reason so the log doesn't always blame
      // "quality" when the real cause is e.g. a hoster resolver bailing out
      // and every release returning with `links: []`.
      const allFailedOnLinks = stats.noLinksFail === stats.total && stats.total > 0;
      const reasonParts: string[] = [];
      if (stats.noLinksFail)  reasonParts.push(`${stats.noLinksFail} ohne Links`);
      if (stats.qualityFail)  reasonParts.push(`${stats.qualityFail} unter Qualitäts-Mindest`);
      if (stats.audioFail)    reasonParts.push(`${stats.audioFail} unter Audio-Mindest`);
      if (stats.languageFail) reasonParts.push(`${stats.languageFail} falsche Sprache`);
      if (stats.typeFail)     reasonParts.push(`${stats.typeFail} ausgeschlossener Release-Typ`);
      if (stats.dvFail)       reasonParts.push(`${stats.dvFail} Dolby Vision (ausgeschlossen)`);
      const reasonSummary = reasonParts.join(', ') || 'unbekannt';
      const headline = allFailedOnLinks
        ? 'alle Releases ohne auflösbare Hoster-Links — Plugin-Resolver blockiert?'
        : 'kein Release erfüllt alle Filter-Kriterien';

      logger.info(`${movie.title}: ${releases.length} release(s) — ${headline} (${reasonSummary}) · gefunden: ${qualitySummary} [hosters: ${availableHosters}]`);
      addLogEntry(
        movie.id,
        allFailedOnLinks ? 'no_hoster' : 'quality_mismatch',
        allFailedOnLinks
          ? `Alle ${releases.length} Release(s) ohne auflösbare Hoster-Links`
          : `Found ${releases.length} release(s) but none match quality requirements (${reasonSummary})`,
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
      const success = await jdownloaderService.addLinks(directLinks, packageName);

      if (success) {
        updateMovieStatus(movie.id, 'downloading');
        updateDownloadStatusByMovieId(movie.id, 'sent_to_jd');
        addLogEntry(movie.id, 'sent_to_jdownloader',
          `Sent ${directLinks.length} direct link(s) to JDownloader`);
        eventBus.emit('movie:updated', { id: movie.id, title: movie.title, status: 'downloading' });
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

  // Phase 2: Auto-discover new seasons from releases (fallback for Trakt gaps)
  let seasons = getSeasonsByShowId(movie.id);
  const existingNumbers = new Set(seasons.map(s => s.season_number));
  const quality = movie.desired_quality || getSetting('quality.minimum') || '1080p';

  for (const seasonNum of availableSeasons) {
    if (seasonNum === 0) continue; // Never auto-add Specials (season 0) — Trakt intentionally excludes them
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
  const pendingSeasons = seasons.filter(s => ['pending', 'not_found'].includes(s.status));

  // Re-process seasons that still have 'pending' episodes to fetch:
  //  - 'downloaded' seasons that gained new episodes (weekly releases)
  //  - 'downloading' seasons whose earlier pass couldn't resolve every episode
  //    (only the gaps are filled; episodes already sent to JD stay untouched)
  for (const season of seasons) {
    if (pendingSeasons.some(p => p.id === season.id)) continue;
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
      const newPending = refreshedSeasons.filter(s => ['pending', 'not_found'].includes(s.status));
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
        // Links not resolved yet — don't fall through to episodes, wait for retry
        continue;
      }
      // result === 'no_links' — try episode fallback
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
      updateSeasonStatus(season.id, 'not_found', url);
      updateSeasonLastChecked(season.id);
      addLogEntry(movie.id, 'not_found', `${sLabel}: no release found`);
      continue;
    }

    if (seasonEpisodes.length > 0) {
      const pending = getPendingEpisodes(season.id);
      if (pending.length === 0) {
        // All episodes already downloaded — season complete
        updateSeasonStatus(season.id, 'downloaded', url);
        continue;
      }

      let episodesProcessed = 0;
      for (const ep of pending) {
        const epRelease = seasonEpisodes.find(r => r.episode === ep.episode_number);
        if (!epRelease) continue;

        const eLabel = `${sLabel}E${String(ep.episode_number).padStart(2, '0')}`;
        let directLinks = epRelease.links
          .filter(l => (enabledHosters.length === 0 || enabledHosters.includes(l.hoster)))
          .map(l => l.url);

        // On-demand resolution: let the active plugin refine the link list
        // (no-op for plugins that already return direct URLs from findReleases).
        if (directLinks.length === 0 && activePlugin) {
          const candidates = epRelease.links.filter(l => (enabledHosters.length === 0 || enabledHosters.includes(l.hoster)));
          if (candidates.length > 0) {
            addLogEntry(movie.id, 'resolving_links', `${eLabel}: resolving download links...`);
            const resolved = validateHosterLinks(await activePlugin.resolveLinks(candidates), activePlugin.id);
            if (resolved.length > 0) {
              epRelease.links = resolved;
              directLinks = resolved.filter(l => (enabledHosters.length === 0 || enabledHosters.includes(l.hoster))).map(l => l.url);
            }
          }
        }

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
          const packageName = `${movie.title} (${movie.year}) - S${String(sNum).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')} - ${epRelease.quality}`;
          const success = await jdownloaderService.addLinks(directLinks, packageName);
          if (success) {
            addLogEntry(movie.id, 'sent_to_jdownloader', `${eLabel}: sent ${directLinks.length} link(s) to JDownloader`);
            logger.info(`${eLabel}: sent to JDownloader as "${packageName}"`);
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

  // Phase 4: Update aggregate show status
  const updatedSeasons = getSeasonsByShowId(movie.id);
  let newStatus: 'pending' | 'searching' | 'found' | 'downloading' | 'downloaded' | 'not_found';
  if (updatedSeasons.every(s => s.status === 'downloaded')) {
    newStatus = 'downloaded';
  } else if (updatedSeasons.some(s => s.status === 'downloading')) {
    newStatus = 'downloading';
  } else if (updatedSeasons.some(s => s.status === 'found')) {
    newStatus = 'found';
  } else {
    newStatus = 'pending';
  }
  updateMovieStatus(movie.id, newStatus, url);
  updateLastChecked(movie.id);
  if (anyProcessed) {
    resetRetryCount(movie.id);
    incrementMetric('moviesProcessed');
  }
  eventBus.emit('movie:updated', { id: movie.id, title: movie.title, status: newStatus });
}

/**
 * Try to download a release for a season. Returns:
 * - 'downloaded' if links sent to JDownloader
 * - 'pending' if release found but links not resolved (captcha pending)
 * - 'no_links' if no usable links at all
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
  // container/redirect URLs (e.g. ad-bypass landing links from the source), not
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
    addLogEntry(movie.id, 'captcha_pending', `${label}: links not resolved — will retry${diagSuffix}`);
    logger.info(`${label}: links not resolved, will retry${diagSuffix}`);
    return 'pending';
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
    const success = await jdownloaderService.addLinks(directLinks, packageName);
    if (success) {
      updateSeasonStatus(season.id, 'downloading');
      updateDownloadStatusByMovieId(movie.id, 'sent_to_jd');
      addLogEntry(movie.id, 'sent_to_jdownloader', `${label}: sent ${directLinks.length} link(s) to JDownloader`);
      logger.info(`${label}: sent to JDownloader as "${packageName}"`);
      return 'downloaded';
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
 * Retry sending links to JDownloader for movies/seasons stuck in 'found' status
 * (i.e. links were found but JDownloader was offline when we tried to send them)
 *
 * Accepts a pre-fetched movies array so the caller can share it with the rest
 * of the sync — avoids a second `getAllMovies()` round-trip.
 */
async function retryFailedJDownloaderSends(allMoviesArg?: Movie[]): Promise<void> {
  if (!jdownloaderService.isConfigured()) return;

  // --- Movies in 'found' status ---
  const foundMovies = getMoviesByStatus('found');
  if (foundMovies.length > 0) {
    logger.info(`Retrying JDownloader send for ${foundMovies.length} movie(s) in 'found' status`);
    const downloadsByMovie = getDownloadsByMovieIds(foundMovies.map(m => m.id));

    for (const movie of foundMovies) {
      const downloads = downloadsByMovie.get(movie.id) || [];
      if (downloads.length === 0) continue;

      const links = downloads.map(d => d.download_url);
      const quality = downloads[0].quality || '';
      const yearStr = movie.year != null ? ` (${movie.year})` : '';
      const packageName = `${movie.title}${yearStr} - ${quality}`;

      const success = await jdownloaderService.addLinks(links, packageName);
      if (success) {
        updateMovieStatus(movie.id, 'downloading');
        updateDownloadStatusByMovieId(movie.id, 'sent_to_jd');
        addLogEntry(movie.id, 'sent_to_jdownloader', `Retry: sent ${links.length} link(s) to JDownloader`);
        logger.info(`Retry successful for ${movie.title}`);
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
      const seasonDownloads = downloads.filter(d => d.download_url && d.season_number === season.season_number);
      if (seasonDownloads.length === 0) continue;

      const links = seasonDownloads.map(d => d.download_url);
      const quality = seasonDownloads[0].quality || '';
      const sNum = String(season.season_number).padStart(2, '0');
      const yearStr = show.year != null ? ` (${show.year})` : '';
      const packageName = `${show.title}${yearStr} - S${sNum} - ${quality}`;

      const success = await jdownloaderService.addLinks(links, packageName);
      if (success) {
        updateSeasonStatus(season.id, 'downloading');
        updateDownloadStatusByMovieId(show.id, 'sent_to_jd');
        addLogEntry(show.id, 'sent_to_jdownloader', `S${sNum} retry: sent ${links.length} link(s) to JDownloader`);
        logger.info(`${show.title} S${sNum}: JD retry successful`);
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

    // Determine the current downloaded quality
    const currentQuality = downloads[0].quality || '';
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
          const result = await plugin.findReleases({
            title: movie.title,
            year: movie.year ?? undefined,
            imdbId: movie.imdb_id ?? undefined,
            mediaType,
            altTitle: upgradeGermanTitle,
          }, { skipLinkResolution: true });
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

      // Filter for releases with strictly higher quality than current, up to cutoff
      const betterReleases = filterReleases(releases).filter(r => {
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

      // Add new download entries
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

      // Send to JDownloader
      if (jdownloaderService.isConfigured()) {
        const packageName = `${movie.title} (${movie.year}) - ${bestRelease.quality} [UPGRADE]`;
        const success = await jdownloaderService.addLinks(directLinks, packageName);
        if (success) {
          updateMovieStatus(movie.id, 'downloading');
          updateDownloadStatusByMovieId(movie.id, 'sent_to_jd');
          addLogEntry(movie.id, 'sent_to_jdownloader',
            `Quality upgrade: sent ${directLinks.length} link(s) to JDownloader`);
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
  libraryPreloaded = false;
  const syncStart = Date.now();
  incrementMetric('syncRuns');
  logger.info('Starting full sync...');
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

    const duration = Date.now() - syncStart;
    setMetric('lastSyncDurationMs', duration);
    setMetric('lastSyncAt', new Date().toISOString());
    addLogEntry(null, 'sync_completed', `Sync done: ${synced} new, ${processed} processed (${Math.round(duration / 1000)}s)`);
    eventBus.emit('sync:completed', { synced, processed, durationMs: duration });
    return { synced, processed };
  } finally {
    isRunning = false;
    cachedJdPackages = null;
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

  if (synced > 0) {
    logger.info(`Synced ${synced} new movie(s) from watchlist`);
  }
  return synced;
}

// Lightweight poll: check watchlist for new movies every 2 minutes
async function checkForNewMovies(): Promise<void> {
  if (isRunning) return;

  const provider = getSetting('watchlist.provider') || 'trakt';
  const hasProvider =
    ((provider === 'trakt' || provider === 'both') && traktService.isConfigured() && traktService.isAuthenticated()) ||
    ((provider === 'plex' || provider === 'both') && plexService.isConfigured());

  if (!hasProvider) return;

  try {
    const newCount = await syncWatchlistProviders();
    if (newCount === 0) return;

    logger.info(`Watchlist monitor: ${newCount} new movie(s) detected, processing immediately`);

    const pendingMovies = getMoviesByStatus('pending');
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

export function startScheduler(): void {
  stopScheduler();

  // Reset movies stuck in 'searching' from a previous crash/restart
  const stuckSearching = getMoviesByStatus('searching');
  for (const movie of stuckSearching) {
    updateMovieStatus(movie.id, 'pending');
    logger.info(`Reset stuck movie: ${movie.title} (searching → pending)`);
  }

  const intervalHours = parseInt(getSetting('scheduler.interval_hours') || '24', 10);
  const enabled = getSetting('scheduler.enabled') !== 'false';

  if (!enabled) {
    logger.info('Scheduler is disabled');
    return;
  }

  // Full sync every N hours (re-checks not_found movies etc.)
  const cronExpression = intervalHours >= 24
    ? '0 3 * * *'  // Daily at 3 AM
    : `0 */${intervalHours} * * *`;

  scheduledTask = cron.schedule(cronExpression, async () => {
    try {
      logger.info('Scheduled full sync triggered');
      await runFullSync();
    } catch (error: any) {
      logger.error('Scheduled sync failed:', error.message);
    }
  });

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

  logger.info(`Scheduler started: full sync every ${intervalHours}h, watchlist monitor every 2 min${healthMonitorEnabled ? ', health monitor every 15 min' : ''}`);
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
  stopWatchlistMonitor();
  logger.info('Scheduler stopped');
}

/**
 * Check recent activity_log for elevated failure rates and alert Telegram when
 * thresholds are crossed. Covers the failure modes we actually saw today:
 *   - 2Captcha / link-resolution failures → `jdownloader_failed` or `captcha_pending`
 *   - Post-processor move loops → repeated `not_found` on already-downloaded items
 *   - Search regressions → `not_found` spike across many movies
 *
 * Alerts cool down for one hour per overall status so an ongoing outage
 * notifies once, not every 15 minutes.
 */
export async function runHealthMonitor(): Promise<void> {
  const now = Date.now();
  // Match SQLite's space-separated UTC format so the last-hour window actually
  // matches stored created_at values — see toSqliteUtc().
  const windowStart = toSqliteUtc(new Date(now - 60 * 60 * 1000)); // last hour

  // Count failure-flavoured actions in the last hour
  const counts = db.prepare(`
    SELECT action, COUNT(*) as count
    FROM activity_log
    WHERE created_at >= ?
      AND action IN ('jdownloader_failed', 'captcha_pending', 'not_found', 'error', 'jdownloader_error', 'quality_mismatch')
    GROUP BY action
  `).all(windowStart) as { action: string; count: number }[];

  const byAction = Object.fromEntries(counts.map(r => [r.action, r.count])) as Record<string, number>;
  const jdFailed = byAction.jdownloader_failed || 0;
  const captchaPending = byAction.captcha_pending || 0;
  const notFound = byAction.not_found || 0;

  const problems: string[] = [];
  if (jdFailed >= 5) problems.push(`${jdFailed}× jdownloader_failed`);
  if (captchaPending >= 5) problems.push(`${captchaPending}× captcha_pending`);
  if (notFound >= 10) problems.push(`${notFound}× not_found`);

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

export function isSchedulerRunning(): boolean {
  return scheduledTask !== null;
}

export function isSyncRunning(): boolean {
  return isRunning;
}
