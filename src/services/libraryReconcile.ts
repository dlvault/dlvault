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
 *   (B) Library has an episode we never tracked (e.g. season pack had more files than
 *       Trakt's aired_episodes count, or files were placed manually) → add the row and
 *       mark it 'downloaded' so we don't re-download what already exists.
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
    movie.imdb_id, movie.tmdb_id, movie.title, movie.year,
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

  for (const season of allSeasons) {
    const sNum = season.season_number;
    const libEpsForSeason = libBySeason.get(sNum) ?? new Set<number>();
    const dbEps = getEpisodesBySeasonId(season.id);
    const dbEpNums = new Set(dbEps.map(e => e.episode_number));

    // (A) Downgrade DB 'downloaded' episodes that the library can't see.
    for (const ep of dbEps) {
      if (ep.status === 'downloaded' && !libEpsForSeason.has(ep.episode_number)) {
        updateEpisodeStatus(ep.id, 'pending');
        result.resetCount++;
        const key = episodeKey(sNum, ep.episode_number);
        addLogEntry(movie.id, 'library_reconciled',
          `${key}: marked downloaded in DB but missing in ${providerName} → reset to pending`);
        logger.info(`${movie.title} ${key}: reconcile reset (missing in library)`);
      }
    }

    // (B) Add library episodes the DB has never seen, as 'downloaded'.
    for (const epNum of libEpsForSeason) {
      if (!dbEpNums.has(epNum)) {
        const ep = addEpisode(season.id, epNum);
        updateEpisodeStatus(ep.id, 'downloaded', 'library_reconcile');
        result.addedCount++;
        const key = episodeKey(sNum, epNum);
        addLogEntry(movie.id, 'library_reconciled',
          `${key}: present in ${providerName} but unknown to DB → added as downloaded`);
        logger.info(`${movie.title} ${key}: reconcile added (found in library)`);
      }
    }

    // Re-aggregate season status based on the new episode set.
    const completion = getSeasonCompletionStatus(season.id);
    if (completion.total > 0) {
      if (completion.allDone && season.status !== 'downloaded') {
        updateSeasonStatus(season.id, 'downloaded');
      } else if (!completion.allDone && season.status === 'downloaded') {
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
