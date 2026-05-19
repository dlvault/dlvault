import { getSetting } from '../database/index';
import { getMovieById, updateMovieMetadata, type Movie } from '../database/services/movies';
import { getMovieDetails, isConfigured as omdbConfigured } from './omdb';
import { traktService } from './trakt';
import { logger } from '../utils/logger';

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
