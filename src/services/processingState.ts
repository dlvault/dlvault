import { getSetting, setSetting } from '../database/index';

/**
 * In-process guards shared across the scheduler, post-processor and sync
 * services. Kept in a dependency-free module so any of them can import it
 * without creating an import cycle (scheduler ⇄ trakt/plex/postprocess).
 */

/** Movies currently inside processMovie(). Nothing may delete or reconcile them. */
export const processingMovies = new Set<number>();

/**
 * Titles the post-processor is importing right now — from the import check
 * through the copy into the library to the status update. A search started in
 * that window (retry button, "Neu laden", Telegram) found the JD package
 * already gone and sent the same film again.
 */
export const movingMovies = new Set<number>();

/** True while a title's files are being imported — searching it now would download it twice. */
export function isImporting(id: number): boolean {
  return movingMovies.has(id) || importingMovies.has(id);
}

/**
 * Movies with a quality-upgrade download in flight. The OLD (lower-quality) file
 * is still in the library while the better version downloads, so the library/
 * provider "found it → mark downloaded" checks would otherwise flip the movie to
 * 'downloaded' and mark its download row 'completed' — orphaning the [UPGRADE]
 * package (it stops being managed and gets stuck in the LinkGrabber). Those
 * checks skip movies in this set. Pruned each upgrade scan.
 */
export const upgradingMovies = new Set<number>();

/**
 * The upgrade marker has to survive a restart. Lost, the library check found
 * the OLD file and closed the title while its [UPGRADE] package kept running
 * unmanaged — and when the upgrade did land, the size guard (no longer told it
 * was an upgrade) threw away a smaller HEVC file as "worse". An app update in
 * the middle of an upgrade was enough. Stored as a settings value; call
 * persistUpgradingMovies() after every change, restore once at startup.
 */
const UPGRADING_KEY = 'state.upgrading_movies';

export function persistUpgradingMovies(): void {
  try {
    setSetting(UPGRADING_KEY, [...upgradingMovies].join(','));
  } catch { /* best effort — the marker is a guard, not data */ }
}

export function restoreUpgradingMovies(): number {
  try {
    for (const part of (getSetting(UPGRADING_KEY) || '').split(',')) {
      const id = parseInt(part, 10);
      if (Number.isInteger(id) && id > 0) upgradingMovies.add(id);
    }
  } catch { /* nothing to restore */ }
  return upgradingMovies.size;
}

/**
 * Library imports in progress (post-processor copying the finished download to
 * the target drive). JD has already dropped the package by then, so without this
 * the queue card fell back to "Wartet · in JDownloader 0%" for the whole copy —
 * several minutes for a large file copied across devices. Keyed by movie id.
 */
export interface ImportInProgress {
  movieId: number;
  startedAt: number;
  totalBytes: number;
  /** File currently being copied; its on-disk size is the in-flight progress. */
  dest: string;
  /** Bytes of files already fully placed (multi-file show imports). */
  doneBytes?: number;
}
export const importingMovies = new Map<number, ImportInProgress>();
