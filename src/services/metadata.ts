import { getSetting } from '../database/index';
import {
  clearMovieMetadata, getMovieById, getMovieByImdbId, setMovieImdbId, setMovieYear, updateMovieMetadata, type Movie,
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

/** Case/accents/punctuation-insensitive form, so "Stille Wasser – Ein Fall für…" matches "Stille Wasser - Ein Fall fur…". */
function normalizeTitle(t: string): string {
  return t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * A title-only row usually carries the *German* title (Telegram free text, the
 * sources' naming), which OMDb's English title search never finds — such rows
 * stayed id-less (no poster, no metadata) indefinitely. Seerr searches TMDb in
 * the configured language. Only an unambiguous hit counts: exactly one result
 * with the same normalized title (and year, when the row has one) — a loose
 * title match is how a short title gets confused with a longer one.
 */
async function lookupByLocalizedTitle(movie: Movie): Promise<ResolvedIds | null> {
  const type = movie.media_type === 'show' ? 'show' : 'movie';
  const results = await seerrService.searchCatalog(movie.title, { types: [type], limit: 20 });
  const want = normalizeTitle(movie.title);
  const hits = results.filter(r =>
    r.tmdbId != null && normalizeTitle(r.title) === want
    && (!movie.year || !r.year || Math.abs(r.year - movie.year) <= 1));
  if (hits.length !== 1) return null;
  const meta = await seerrService.getMeta(type === 'show' ? 'tv' : 'movie', hits[0].tmdbId!);
  return meta?.imdbId ? { imdbId: meta.imdbId, year: meta.year || hits[0].year || undefined } : null;
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
 * by title is the fallback for rows that have nothing else. A row WITH a tmdb
 * id never goes by title: a new release often has no imdb id at TMDb yet, and
 * the title search then picked a namesake — a stub, a German TV film, a
 * 2-minute short — for four new releases in one library. No
 * id until TMDb has one beats a wrong one, which the {imdbid} name tag then
 * forces on the media server.
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
    const found = movie.tmdb_id
      ? await lookupByTmdbId(movie)
      : (await lookupByLocalizedTitle(movie)) ?? (await lookupByTitle(movie));
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
 * Check a stored imdb id against what the tmdb id says, and correct it. Ids
 * resolved by title before that was ruled out are wrong for some new releases.
 * Returns 'confirmed', the correction, or null when nobody could be asked (or
 * the right id is taken by another row). Metadata fetched for the wrong id is
 * dropped so the next backfill redoes it.
 */
export async function verifyMovieImdbId(movie: Movie): Promise<{ from: string; to: string } | 'confirmed' | null> {
  if (!movie.imdb_id || !movie.tmdb_id) return null;
  try {
    const found = await lookupByTmdbId(movie);
    if (!found) return null;
    if (found.imdbId.toLowerCase() === movie.imdb_id.toLowerCase()) return 'confirmed';
    if (!setMovieImdbId(movie.id, found.imdbId)) {
      const owner = getMovieByImdbId(found.imdbId);
      logger.warn(`${movie.title}: imdb id ${movie.imdb_id} does not match tmdb ${movie.tmdb_id} (${found.imdbId}), but ${found.imdbId} belongs to "${owner?.title}" (#${owner?.id}) — left as is`);
      return null;
    }
    clearMovieMetadata(movie.id);
    logger.warn(`${movie.title}: imdb id ${movie.imdb_id} belonged to another title — corrected to ${found.imdbId} (tmdb ${movie.tmdb_id})`);
    return { from: movie.imdb_id, to: found.imdbId };
  } catch (error: any) {
    logger.debug(`imdb verify failed for ${movie.title}: ${error?.message || error}`);
    return null;
  }
}

/**
 * Complete a missing year from the tmdb id: Seerr's metadata first, else TMDb
 * directly (either one is enough). A Sonarr/Seerr hand-over carries no year and
 * the imdb resolve above only fills it when the imdb id was missing too, so such
 * a show kept year 0 — and a library folder named "(Unknown)".
 * Best-effort: returns the (possibly updated) row.
 */
export async function resolveMovieYear(movie: Movie): Promise<Movie> {
  if (movie.year || !movie.tmdb_id) return movie;
  const type = movie.media_type === 'show' ? 'tv' : 'movie';
  try {
    let year = (await seerrService.getMeta(type, movie.tmdb_id))?.year || 0;
    if (!year && tmdbService.isConfigured()) {
      const date = type === 'tv'
        ? (await tmdbService.getShowAiring(movie.tmdb_id)).firstAir
        : (await tmdbService.getMovieRelease(movie.tmdb_id, tmdbService.region())).theatrical;
      year = Number((date || '').slice(0, 4)) || 0;
    }
    if (!year) return movie;
    setMovieYear(movie.id, year);
    logger.info(`${movie.title}: year completed → ${year}`);
    return getMovieById(movie.id) ?? movie;
  } catch (error: any) {
    logger.debug(`year resolve failed for ${movie.title}: ${error?.message || error}`);
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
