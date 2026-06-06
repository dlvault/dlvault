import db from '../index';
import type { Movie, MediaType } from './movies';

/**
 * Titles the user removed from dlvault's queue. The request behind them still
 * exists in Seerr / on the Trakt or Plex watchlist, and the next sync used to
 * add them straight back — "Löschen" did nothing for watchlist titles.
 *
 * A deliberate new request (search, Telegram, a fresh approval in Seerr)
 * clears the entry again.
 */

export interface TitleIds { mediaType: MediaType; tmdbId?: number | null; imdbId?: string | null }

// Never in the way of an add or a delete: a failure here only means a removed
// title may come back once — so every function swallows its own errors.

export function dismissTitle(movie: Pick<Movie, 'media_type' | 'tmdb_id' | 'imdb_id' | 'title'>): void {
  if (!movie.tmdb_id && !movie.imdb_id) return;
  try {
    clearDismissal({ mediaType: movie.media_type, tmdbId: movie.tmdb_id, imdbId: movie.imdb_id });
    db.prepare('INSERT INTO dismissed_titles (media_type, tmdb_id, imdb_id, title) VALUES (?, ?, ?, ?)')
      .run(movie.media_type, movie.tmdb_id ?? null, movie.imdb_id || null, movie.title);
  } catch { /* see above */ }
}

/**
 * `requestedAt`: when the watchlist entry / request was made. One made AFTER
 * the removal is a new wish — it clears the removal instead of being skipped.
 */
export function isDismissed(ids: TitleIds, requestedAt?: string | null): boolean {
  if (!ids.tmdbId && !ids.imdbId) return false;
  try {
  const row = db.prepare(
    `SELECT dismissed_at FROM dismissed_titles WHERE media_type = ?
       AND ((? IS NOT NULL AND tmdb_id = ?) OR (? IS NOT NULL AND ? != '' AND imdb_id = ?)) LIMIT 1`,
  ).get(ids.mediaType, ids.tmdbId ?? null, ids.tmdbId ?? null, ids.imdbId || null, ids.imdbId || '', ids.imdbId || null);
  if (!row) return false;
  const when = requestedAt ? Date.parse(requestedAt) : NaN;
  const dismissedAt = Date.parse(`${(row as { dismissed_at: string }).dismissed_at.replace(' ', 'T')}Z`);
  if (Number.isFinite(when) && Number.isFinite(dismissedAt) && when > dismissedAt) {
    clearDismissal(ids);
    return false;
  }
  return true;
  } catch {
    return false;
  }
}

export function clearDismissal(ids: TitleIds): void {
  if (!ids.tmdbId && !ids.imdbId) return;
  try {
    db.prepare(
      `DELETE FROM dismissed_titles WHERE media_type = ?
         AND ((? IS NOT NULL AND tmdb_id = ?) OR (? IS NOT NULL AND imdb_id = ?))`,
    ).run(ids.mediaType, ids.tmdbId ?? null, ids.tmdbId ?? null, ids.imdbId || null, ids.imdbId || null);
  } catch { /* see above */ }
}

/**
 * Forget removals whose request is gone from the watchlist / Seerr. A removal
 * only means "do not take THIS request again" — once the user deletes the
 * request and asks for the title anew, it must come through. Call only with a
 * COMPLETE list; an empty or failed fetch must not wipe every removal.
 */
export function pruneDismissals(present: TitleIds[]): number {
  if (present.length === 0) return 0;
  try {
    const rows = db.prepare('SELECT id, media_type, tmdb_id, imdb_id FROM dismissed_titles').all() as
      { id: number; media_type: MediaType; tmdb_id: number | null; imdb_id: string | null }[];
    const tmdb = new Set(present.filter(p => p.tmdbId).map(p => `${p.mediaType}:${p.tmdbId}`));
    const imdb = new Set(present.filter(p => p.imdbId).map(p => `${p.mediaType}:${p.imdbId}`));
    const gone = rows.filter(r =>
      !(r.tmdb_id && tmdb.has(`${r.media_type}:${r.tmdb_id}`)) && !(r.imdb_id && imdb.has(`${r.media_type}:${r.imdb_id}`)));
    const del = db.prepare('DELETE FROM dismissed_titles WHERE id = ?');
    for (const r of gone) del.run(r.id);
    return gone.length;
  } catch {
    return 0;
  }
}
