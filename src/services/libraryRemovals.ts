import { fileNamesTitle } from './plexLibrary';
import fs from 'fs';
import type { Movie } from '../database/services/movies';
import { markWatched, setRemovedAt } from '../database/services/movies';
import { addLogEntry, hasRecentActivityEntry } from '../database/services/activityLog';
import type { LibraryProvider, WatchedMovie } from './libraryProvider';
import { logger } from '../utils/logger';

/**
 * A downloaded film whose file is gone: deleted on purpose, or lost?
 *
 * dlvault cannot ask the filesystem why a file disappeared, and the media
 * servers do not record deletions in a usable way. What they do know is watch
 * state — but only while the item exists. So it is snapshotted regularly, and
 * when a file vanishes:
 *
 *   - the films folder is unreadable/empty, or many films vanish at once
 *       → a share/disk problem: ONE warning, nothing else happens;
 *   - the film had been watched or started by anyone
 *       → deleted after watching: marked removed, silently;
 *   - otherwise
 *       → unexplained: listed in the problem center with "Neu laden" /
 *         "Absichtlich gelöscht" — no message, no automatic download.
 *
 * Nothing here downloads anything; a re-download is always the user's click.
 */

const SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastSnapshot = 0;

export function _resetLibraryRemovals(): void { lastSnapshot = 0; }

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

/** Does a watched entry from the media server belong to this row? Ids first, title+year last. */
export function isWatched(movie: Pick<Movie, 'imdb_id' | 'tmdb_id' | 'title' | 'year'>, watched: WatchedMovie[]): boolean {
  return watched.some(w =>
    (!!movie.imdb_id && w.imdbId === movie.imdb_id)
    || (movie.tmdb_id != null && w.tmdbId === String(movie.tmdb_id))
    || (!!movie.year && w.year === movie.year && norm(w.name) === norm(movie.title))
    // The media server misidentified the file — dlvault's own file name still says which film.
    || (!!movie.year && fileNamesTitle(w.files, movie.title, movie.year)));
}

/** Record watch state of films still in the library (every 6 h). */
export async function snapshotWatched(movies: Movie[], provider: LibraryProvider, now = Date.now()): Promise<number> {
  if (now - lastSnapshot < SNAPSHOT_INTERVAL_MS || !provider.isConfigured()) return 0;
  const watched = await provider.getWatchedMovies();
  if (!watched) return 0;           // unknown — try again next pass
  lastSnapshot = now;
  const ids = movies
    .filter(m => m.media_type === 'movie' && m.status === 'downloaded' && !m.watched_at && isWatched(m, watched))
    .map(m => m.id);
  if (ids.length > 0) {
    markWatched(ids);
    logger.debug(`Library: ${ids.length} film(s) newly seen as watched`);
  }
  return ids.length;
}

export interface MissingVerdict {
  /** Share/disk problem — nothing per film was decided. */
  mass: boolean;
  removed: Movie[];
  unexplained: Movie[];
}

/** Films folder present and not empty — an unmounted share reads as an empty dir. */
export function moviesRootHealthy(moviesPath: string | undefined): boolean {
  if (!moviesPath) return false;
  try { return fs.readdirSync(moviesPath).some(n => !n.startsWith('.')); } catch { return false; }
}

/**
 * Sort the films whose files are gone. `downloadedCount` is how many films
 * the library should hold; above max(5, 10 %) missing at once it is treated
 * as a storage problem rather than a run of deletions.
 */
export function classifyMissing(missing: Movie[], downloadedCount: number, rootHealthy: boolean): MissingVerdict {
  const limit = Math.max(5, Math.ceil(downloadedCount * 0.1));
  if (!rootHealthy || missing.length >= limit) return { mass: missing.length > 0 || !rootHealthy, removed: [], unexplained: [] };
  return {
    mass: false,
    removed: missing.filter(m => !!m.watched_at),
    unexplained: missing.filter(m => !m.watched_at),
  };
}

/** Apply a verdict: log, mark, warn. Returns how many entries were written. */
export function applyMissingVerdict(v: MissingVerdict, missingCount: number, notify: (text: string) => void): number {
  let written = 0;
  if (v.mass) {
    if (!hasRecentActivityEntry(null, 'library_mass_missing', 24)) {
      const text = `${missingCount} Filme fehlen gleichzeitig in der Bibliothek — vermutlich ist die Freigabe/Platte nicht erreichbar. dlvault ändert nichts, bis sie wieder da sind.`;
      addLogEntry(null, 'library_mass_missing', text);
      logger.warn(`Library: ${text}`);
      notify(text);
      written++;
    }
    return written;
  }
  for (const m of v.removed) {
    setRemovedAt(m.id, true);
    addLogEntry(m.id, 'library_removed', 'Nach dem Anschauen aus der Bibliothek gelöscht — wird nicht neu geladen');
    logger.info(`Library: "${m.title}" (${m.year}) was watched and is gone — treated as deliberately deleted`);
    written++;
  }
  for (const m of v.unexplained) {
    if (hasRecentActivityEntry(m.id, 'library_missing', 24)) continue;
    addLogEntry(m.id, 'library_missing', 'Datei fehlt in der Bibliothek (nie angeschaut) — im Problem-Center neu laden oder als gelöscht markieren');
    logger.info(`Library: "${m.title}" (${m.year}) is gone and was never watched — listed in the problem center`);
    written++;
  }
  return written;
}
