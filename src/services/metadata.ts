import { getSetting } from '../database/index';
import {
  getMovieById, getMovieByImdbId, setMovieImdbId, setMovieYear, updateMovieMetadata, type Movie,
} from '../database/services/movies';
import { getMovieDetails, findImdbId, isConfigured as omdbConfigured } from './omdb';
import { seerrService } from './seerr';
import { tmdbService } from './tmdb';
import { traktService } from './trakt';
import { logger } from '../utils/logger';

/** What one lookup found; the year rides along so a row added without one can be completed. */
interface ResolvedIds {
  imdbId: string;
  year?: number;
}

/**
 * A tmdb id is the reliable handle: ask whoever knows the mapping — Seerr
 * (which proxies TMDb, and is what usually created such a row in the first
 * place), then TMDb directly when a key is set. Both are no-ops unconfigured.
 */
async function lookupByTmdbId(movie: Movie): Promise<ResolvedIds | null> {
  if (!movie.tmdb_id) return null;
  const type = movie.media_type === 'show' ? 'tv' : 'movie';
  const meta = await seerrService.getMeta(type, movie.tmdb_id);
  if (meta?.imdbId) return { imdbId: meta.imdbId, year: meta.year || undefined };
  const viaTmdb = await tmdbService.getImdbId(type, movie.tmdb_id);
  if (viaTmdb) return { imdbId: viaTmdb, year: meta?.year || undefined };
  return null;
}

/** A title-only row has nothing better than OMDb's title search. */
async function lookupByTitle(movie: Movie): Promise<ResolvedIds | null> {
  if (!omdbConfigured()) return null;
  const imdbId = await findImdbId(
    movie.title,
    movie.year,
    movie.media_type === 'show' ? 'series' : 'movie',
  );
  return imdbId ? { imdbId } : null;
}

/**
 * Resolve + persist a movie's imdb_id when it was added without one. Without it
 * the row gets no poster (/api/poster needs the id), enrichMovieMetadata can't
 * run, and every source plugin has to search by title instead of by id.
 *
 * Two ways a row ends up id-less: a Telegram free-text pick that matched a
 * plugin candidate carrying no imdb id, and a Seerr hand-over — the Radarr/
 * Sonarr contract sends a tmdbId plus the *localized* title, never an imdbId.
 * The old OMDb-by-title lookup cannot turn a German title into an id, so those
 * rows stayed id-less for good while the nightly backfill failed in silence.
 * Hence the order: a tmdb id is authoritative and is asked about first; OMDb
 * by title is the fallback for rows that have nothing else.
 *
 * A missing year is completed from the same answer (the Sonarr payload carries
 * none, so a show otherwise reads "(0)" everywhere).
 *
 * No-op when already set or without a title. Best-effort: returns the (possibly
 * updated) row.
 */
export async function resolveMovieImdbId(movie: Movie): Promise<Movie> {
  if (movie.imdb_id || !movie.title) return movie;
  try {
    const found = (await lookupByTmdbId(movie)) ?? (await lookupByTitle(movie));
    if (!found) {
      logger.debug(`imdb id unresolved for ${movie.title}${movie.year ? ` (${movie.year})` : ''}`);
      return movie;
    }
    if (!setMovieImdbId(movie.id, found.imdbId)) {
      // The id already belongs to another row: the same title was added twice
      // under two keys. Merging silently would be wrong; name it instead.
      const owner = getMovieByImdbId(found.imdbId);
      logger.warn(`${movie.title}: imdb id ${found.imdbId} already belongs to "${owner?.title}" (#${owner?.id}) — same title added twice, left unresolved`);
      return movie;
    }
    if (!movie.year && found.year) setMovieYear(movie.id, found.year);
    return getMovieById(movie.id) ?? movie;
  } catch (error: any) {
    logger.debug(`imdb resolve failed for ${movie.title}: ${error.message}`);
    return movie;
  }
}

/**
 * Fetch + persist OMDb metadata (plot/genres/rating/runtime/director/studio/
 * country) for a movie or show. When the library language is German, the plot
 * prefers Trakt's German overview (public endpoint, no OAuth) and falls back to
 * OMDb's English plot. No-op when already enriched, no imdb_id, or OMDb is
 * unconfigured. Best-effort: failures leave the row un-enriched.
 *
 * Shared by the detail-panel lazy load (src/api/routes/movies.ts) and the
 * sync-time backfill (runFullSync) so both behave identically.
 */
export async function enrichMovieMetadata(movie: Movie): Promise<Movie> {
  if (movie.metadata_fetched_at || !movie.imdb_id || !omdbConfigured()) return movie;
  try {
    const details = await getMovieDetails(movie.imdb_id);
    if (!details) return movie;
    let plot = details.plot;
    if ((getSetting('quality.language') || 'german') === 'german') {
      try {
        const tr = await traktService.getTranslation(
          movie.imdb_id,
          movie.media_type === 'show' ? 'show' : 'movie',
          'de',
        );
        if (tr?.overview) plot = tr.overview;
      } catch { /* keep OMDb plot */ }
    }
    updateMovieMetadata(movie.id, {
      plot,
      genres: details.genre,
      rating: details.rating,
      runtime: details.runtime,
      director: details.director,
      studio: details.studio,
      country: details.country,
    });
    return getMovieById(movie.id) ?? movie;
  } catch (error: any) {
    logger.debug(`Metadata enrich failed for ${movie.title}: ${error.message}`);
    return movie;
  }
}
