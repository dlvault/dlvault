import { logger } from '../utils/logger';
import { Movie } from '../database/services/movies';
import {
  getSeasonsByShowId,
  addSeason,
  updateSeasonStatus,
} from '../database/services/seasons';
import {
  getEpisodesBySeasonId,
  addEpisode,
  updateEpisodeStatus,
  getSeasonCompletionStatus,
} from '../database/services/episodes';
import { addLogEntry } from '../database/services/activityLog';
import { getSetting } from '../database/index';
import { getLibraryProvider, getLibraryProviderName, episodeKey, type LibraryProvider } from './libraryProvider';
import { libraryEpisodesOnDisk, seKey } from './integrityCheck';
import { parseUtcDate } from '../utils/datetime';

/**
 * How long a freshly delivered episode is exempt from "missing in the media
 * server". The post-processor moves a season in minutes; the media server lists
 * it only after its next scan.
 */
const FRESH_EPISODE_GRACE_MS = 12 * 60 * 60 * 1000;

export interface ReconcileResult {
  /** True if we got episode data from the library (even if empty). */
  reconciled: boolean;
  /** DB episodes that were downgraded from 'downloaded' to 'pending'. */
  resetCount: number;
  /** Library episodes that were unknown to the DB and added as 'downloaded'. */
  addedCount: number;
}

/**
 * Reconcile our episode tracking against what the media library actually contains.
 *
 * Two directions are handled:
 *   (A) DB says 'downloaded' but the library does not have the file → reset to 'pending'
 *       so the next sync picks it up again. This catches: post-processor moved a partial
 *       season pack, user deleted the file, broken/incomplete extract.
 *   (B) Library has an episode the DB hasn't recorded as 'downloaded' → record it as
 *       'downloaded' so we don't re-download what already exists. Covers both the episode
 *       the DB never tracked (season pack had more files than Trakt's aired_episodes count,
 *       or files were placed manually) AND the episode the DB tracks as 'pending'
 *       (e.g. Trakt pre-seeded the whole season as pending before we ever looked at the
 *       library — without this upgrade those rows would download files that already exist).
 *
 * Episodes currently in flight ('downloading') are left alone — we only reconcile the
 * 'downloaded' state.
 *
 * Returns `reconciled: false` when the provider is not configured, unreachable, or the
 * show itself is not in the library — in those cases the caller must not draw any
 * conclusions about DB drift.
 */
export async function reconcileEpisodesWithLibrary(movie: Movie): Promise<ReconcileResult> {
  const result: ReconcileResult = { reconciled: false, resetCount: 0, addedCount: 0 };

  if (movie.media_type !== 'show') return result;

  const enabled = getSetting('library.reconcile_episodes') !== 'false';
  if (!enabled) return result;

  const provider: LibraryProvider = getLibraryProvider();
  if (!provider.isConfigured()) return result;

  const libResult = await provider.getShowEpisodes(
    movie.imdb_id, movie.tmdb_id, movie.title, movie.year, movie.tvdb_id,
  );
  if (libResult === null) {
    // Provider error — preserve DB state, nothing to do.
    return result;
  }
  if (!libResult.found) {
    // Show simply isn't in the library yet — first download still pending. Don't
    // treat existing DB 'downloaded' rows as drift; the post-processor may not have
    // moved them in yet and Plex/Jellyfin may not have rescanned.
    return result;
  }

  result.reconciled = true;
  const libEpisodes = libResult.episodes;

  // Group library episodes by season for fast per-season lookup.
  const libBySeason = new Map<number, Set<number>>();
  for (const key of libEpisodes) {
    const m = key.match(/^S(\d+)E(\d+)$/);
    if (!m) continue;
    const sNum = parseInt(m[1], 10);
    const eNum = parseInt(m[2], 10);
    if (sNum === 0) continue; // skip specials
    if (!libBySeason.has(sNum)) libBySeason.set(sNum, new Set());
    libBySeason.get(sNum)!.add(eNum);
  }

  const providerName = getLibraryProviderName();
  const seasons = getSeasonsByShowId(movie.id);
  const knownSeasonNums = new Set(seasons.map(s => s.season_number));

  // (B') Library has a season we don't even know about → create it.
  const quality = movie.desired_quality || getSetting('quality.minimum') || '1080p';
  for (const [sNum, _eps] of libBySeason) {
    if (!knownSeasonNums.has(sNum)) {
      addSeason(movie.id, sNum, quality);
      addLogEntry(movie.id, 'library_reconciled',
        `S${String(sNum).padStart(2, '0')}: season discovered in ${providerName} library`);
      logger.info(`${movie.title}: library reconcile — added unknown S${String(sNum).padStart(2, '0')}`);
    }
  }

  // Re-fetch after potential addSeason() inserts.
  const allSeasons = getSeasonsByShowId(movie.id);
  let onDisk: Set<string> | null | undefined; // read lazily, only when needed

  for (const season of allSeasons) {
    const sNum = season.season_number;
    const libEpsForSeason = libBySeason.get(sNum) ?? new Set<number>();
    const dbEps = getEpisodesBySeasonId(season.id);

    // (A) Downgrade DB 'downloaded' episodes that the library can't see.
    //
    // "The media server can't see it" is not "it is gone": right after a move the
    // server has not scanned yet. A show pass in that window reset a season that
    // had landed 28 minutes earlier and downloaded all of it a second time. A file
    // on disk, or a delivery within the grace period, keeps the episode.
    for (const ep of dbEps) {
      if (ep.status === 'downloaded' && !libEpsForSeason.has(ep.episode_number)) {
        if (onDisk === undefined) onDisk = libraryEpisodesOnDisk(movie);
        if (onDisk?.has(seKey(sNum, ep.episode_number))) continue;
        const delivered = ep.updated_at ? parseUtcDate(ep.updated_at) : 0;
        if (delivered && Date.now() - delivered < FRESH_EPISODE_GRACE_MS) continue;
        updateEpisodeStatus(ep.id, 'pending');
        result.resetCount++;
        const key = episodeKey(sNum, ep.episode_number);
        addLogEntry(movie.id, 'library_reconciled',
          `${key}: marked downloaded in DB but missing in ${providerName} → reset to pending`);
        logger.info(`${movie.title} ${key}: reconcile reset (missing in library)`);
      }
    }

    // (B) Mark library-present episodes as 'downloaded'.
    //   - unknown to the DB        → add the row as 'downloaded'
    //   - tracked as 'pending'    → upgrade to 'downloaded'; the file is physically
    //     in the library, so it doesn't need (re)downloading.
    //   - 'downloading' rows are left alone: they're in flight and the post-processor
    //     owns that transition once the files actually land.
    const dbByNum = new Map(dbEps.map(e => [e.episode_number, e]));
    for (const epNum of libEpsForSeason) {
      const existing = dbByNum.get(epNum);
      const key = episodeKey(sNum, epNum);
      if (!existing) {
        const ep = addEpisode(season.id, epNum);
        updateEpisodeStatus(ep.id, 'downloaded', 'library_reconcile');
        result.addedCount++;
        addLogEntry(movie.id, 'library_reconciled',
          `${key}: present in ${providerName} but unknown to DB → added as downloaded`);
        logger.info(`${movie.title} ${key}: reconcile added (found in library)`);
      } else if (existing.status === 'pending') {
        // A 'pending' episode of a title under repair was reset ON PURPOSE (a
        // cut-off file, a wrong audio track) — its library entry is the broken
        // copy. And the media server keeps listing a quarantined file until its
        // next scan. Upgrading on that undid every repair within the minute.
        if (movie.repair === 1) continue;
        if (onDisk === undefined) onDisk = libraryEpisodesOnDisk(movie);
        if (onDisk && !onDisk.has(seKey(sNum, epNum))) continue;
        updateEpisodeStatus(existing.id, 'downloaded', 'library_reconcile');
        result.addedCount++;
        addLogEntry(movie.id, 'library_reconciled',
          `${key}: present in ${providerName}, was pending → marked downloaded`);
        logger.info(`${movie.title} ${key}: reconcile upgraded pending→downloaded (found in library)`);
      }
    }

    // Re-aggregate season status based on the new episode set.
    const completion = getSeasonCompletionStatus(season.id);
    if (completion.total > 0) {
      if (completion.allDone && season.status !== 'downloaded') {
        updateSeasonStatus(season.id, 'downloaded');
      } else if (!completion.rowsDone && season.status === 'downloaded') {
        // We just downgraded at least one episode — reopen the season so the
        // scheduler will retry the missing file(s).
        updateSeasonStatus(season.id, 'pending');
      }
    }
  }

  if (result.resetCount > 0 || result.addedCount > 0) {
    logger.info(`${movie.title}: library reconcile — reset ${result.resetCount}, added ${result.addedCount}`);
  }
  return result;
}
