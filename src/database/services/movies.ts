import db from '../index';

export type MediaType = 'movie' | 'show';

export interface Movie {
  id: number;
  trakt_id: number;
  imdb_id: string | null;
  tmdb_id: number | null;
  title: string;
  year: number | null;
  slug: string | null;
  media_type: MediaType;
  status: 'pending' | 'searching' | 'found' | 'downloading' | 'downloaded' | 'not_found';
  desired_quality: string;
  added_at: string;
  updated_at: string;
  source_url: string | null;
  last_checked_at: string | null;
  last_retry_at: string | null;
  /**
   * Timestamp of the last status-sync run that confirmed this movie's JD package
   * was present (in JDownloader's download list or linkgrabber). Independent of
   * updated_at — moves on every successful JD sighting, not on state changes —
   * so the stale-reset threshold has a meaningful "last JD check" baseline.
   */
  last_jd_check_at: string | null;
  retry_count: number;
  // Media metadata — populated lazily from OMDb on first detail view (null until then).
  plot: string | null;
  genres: string | null;       // comma-separated, e.g. "Crime, Drama"
  rating: number | null;       // 0–10
  runtime: number | null;      // minutes
  director: string | null;
  studio: string | null;
  country: string | null;
  metadata_fetched_at: string | null;
}

export interface MovieMetadata {
  plot: string | null;
  genres: string | null;
  rating: number | null;
  runtime: number | null;
  director: string | null;
  studio: string | null;
  country: string | null;
}

export function getAllMovies(): Movie[] {
  return db.prepare('SELECT * FROM movies ORDER BY added_at DESC').all() as Movie[];
}

export function getMovieById(id: number): Movie | undefined {
  return db.prepare('SELECT * FROM movies WHERE id = ?').get(id) as Movie | undefined;
}

export function getMovieByTraktId(traktId: number): Movie | undefined {
  return db.prepare('SELECT * FROM movies WHERE trakt_id = ?').get(traktId) as Movie | undefined;
}

export function getMovieByImdbId(imdbId: string): Movie | undefined {
  return db.prepare('SELECT * FROM movies WHERE imdb_id = ?').get(imdbId) as Movie | undefined;
}

export function getMovieByTmdbId(tmdbId: number): Movie | undefined {
  return db.prepare('SELECT * FROM movies WHERE tmdb_id = ?').get(tmdbId) as Movie | undefined;
}

export function getMoviesByStatus(status: string): Movie[] {
  return db.prepare('SELECT * FROM movies WHERE status = ? ORDER BY added_at DESC').all(status) as Movie[];
}

type NewMovie = Omit<Movie,
  'id' | 'added_at' | 'updated_at' | 'last_checked_at' | 'last_retry_at' | 'last_jd_check_at'
  | 'source_url' | 'retry_count'
  | 'plot' | 'genres' | 'rating' | 'runtime' | 'director' | 'studio' | 'country' | 'metadata_fetched_at'>;

export function addMovie(movie: NewMovie): Movie {
  // Use null instead of 0 for trakt_id — SQLite UNIQUE allows multiple NULLs
  const traktId = movie.trakt_id || null;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO movies (trakt_id, imdb_id, tmdb_id, title, year, slug, media_type, status, desired_quality)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    traktId, movie.imdb_id, movie.tmdb_id,
    movie.title, movie.year, movie.slug, movie.media_type || 'movie',
    movie.status, movie.desired_quality
  );

  // If INSERT OR IGNORE was ignored (duplicate), lastInsertRowid is unreliable
  if (result.changes === 0) {
    // Fetch by unique keys instead
    const existing = (traktId ? getMovieByTraktId(traktId) : undefined)
      || (movie.imdb_id ? getMovieByImdbId(movie.imdb_id) : undefined)
      || (movie.tmdb_id ? getMovieByTmdbId(movie.tmdb_id) : undefined);
    return existing!;
  }
  return getMovieById(result.lastInsertRowid as number)!;
}

export function updateMovieStatus(id: number, status: Movie['status'], sourceUrl?: string): void {
  if (sourceUrl) {
    db.prepare("UPDATE movies SET status = ?, source_url = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, sourceUrl, id);
  } else {
    db.prepare("UPDATE movies SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);
  }
}

export function updateLastChecked(id: number): void {
  db.prepare("UPDATE movies SET last_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
}

/**
 * Mark that JDownloader has just confirmed this movie's package exists (in its
 * download list or linkgrabber). Deliberately does NOT touch updated_at — that
 * field is reserved for genuine state transitions, while last_jd_check_at is
 * the canonical "JD reachable + package found" timestamp the stale-reset uses.
 */
export function markJdSeen(id: number): void {
  db.prepare("UPDATE movies SET last_jd_check_at = datetime('now') WHERE id = ?").run(id);
}

export function incrementRetryCount(id: number): number {
  db.prepare("UPDATE movies SET retry_count = retry_count + 1, updated_at = datetime('now') WHERE id = ?").run(id);
  const movie = getMovieById(id);
  return movie?.retry_count ?? 0;
}

export function resetRetryCount(id: number): void {
  db.prepare("UPDATE movies SET retry_count = 0, updated_at = datetime('now') WHERE id = ?").run(id);
}

export function updateLastRetryAt(id: number): void {
  db.prepare("UPDATE movies SET last_retry_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
}

export function updateMovieTraktId(id: number, traktId: number): void {
  db.prepare("UPDATE movies SET trakt_id = ?, updated_at = datetime('now') WHERE id = ?").run(traktId, id);
}

export function updateMovieTitle(id: number, title: string): void {
  db.prepare("UPDATE movies SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, id);
}

export function updateMovieMetadata(id: number, meta: MovieMetadata): void {
  db.prepare(`
    UPDATE movies SET
      plot = ?, genres = ?, rating = ?, runtime = ?,
      director = ?, studio = ?, country = ?,
      metadata_fetched_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(
    meta.plot, meta.genres, meta.rating, meta.runtime,
    meta.director, meta.studio, meta.country, id,
  );
}

export function deleteMovie(id: number): void {
  db.prepare('DELETE FROM movies WHERE id = ?').run(id);
}
