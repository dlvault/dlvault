import { Router, Request, Response } from 'express';
import { getAllMovies, getMovieById, deleteMovie, updateMovieStatus, resetRetryCount, updateLastRetryAt, updateMovieMetadata } from '../../database/services/movies';
import type { Movie } from '../../database/services/movies';
import { getDownloadsByMovieId } from '../../database/services/downloads';
import { getLogsByMovieId } from '../../database/services/activityLog';
import { getSeasonsByShowId } from '../../database/services/seasons';
import { processMovie } from '../../services/scheduler';
import { getMovieDetails, isConfigured as omdbConfigured } from '../../services/omdb';
import { logger } from '../../utils/logger';

const router = Router();

const RETRY_COOLDOWN_MS = 60 * 1000;

// A "candidate" is a source release the pipeline considered for this movie —
// every download row is a found release, every not_found log a miss. The detail
// panel groups these into a search-results list. `at` is raw UTC; the client
// renders it relative.
interface SearchCandidate {
  name: string;
  source: string;
  found: boolean;
  at: string;
}

function buildCandidates(movieId: number): SearchCandidate[] {
  const downloads = getDownloadsByMovieId(movieId);
  const logs = getLogsByMovieId(movieId);
  const candidates: SearchCandidate[] = [];

  for (const d of downloads) {
    candidates.push({
      name: d.release_name || d.download_url || 'Unbekanntes Release',
      source: d.hoster || '',
      found: true,
      at: d.created_at,
    });
  }
  for (const log of logs) {
    if (log.action === 'not_found') {
      candidates.push({
        name: log.details || 'Keine passende Quelle',
        source: '',
        found: false,
        at: log.created_at,
      });
    }
  }
  // Newest first.
  return candidates.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

// Lazily backfill OMDb metadata (plot/genres/rating/...) on first detail view.
// Best-effort: failures leave the movie un-enriched and the panel hides those
// sections gracefully.
async function ensureMetadata(movie: Movie): Promise<Movie> {
  if (movie.metadata_fetched_at || !movie.imdb_id || !omdbConfigured()) return movie;
  try {
    const details = await getMovieDetails(movie.imdb_id);
    if (details) {
      updateMovieMetadata(movie.id, {
        plot: details.plot,
        genres: details.genre,
        rating: details.rating,
        runtime: details.runtime,
        director: details.director,
        studio: details.studio,
        country: details.country,
      });
      return getMovieById(movie.id) ?? movie;
    }
  } catch (error: any) {
    logger.debug(`Metadata enrich failed for ${movie.title}: ${error.message}`);
  }
  return movie;
}

// GET /api/movies
router.get('/', (_req: Request, res: Response) => {
  const movies = getAllMovies();
  res.json(movies);
});

// GET /api/movies/:id
router.get('/:id', async (req: Request, res: Response) => {
  let movie = getMovieById(Number(req.params.id));
  if (!movie) {
    res.status(404).json({ error: 'Movie not found' });
    return;
  }

  movie = await ensureMetadata(movie);

  const downloads = getDownloadsByMovieId(movie.id);
  const logs = getLogsByMovieId(movie.id);
  const seasons = movie.media_type === 'show' ? getSeasonsByShowId(movie.id) : undefined;
  const candidates = buildCandidates(movie.id);
  res.json({ ...movie, downloads, logs, seasons, candidates });
});

// DELETE /api/movies/:id
router.delete('/:id', (req: Request, res: Response) => {
  try {
    deleteMovie(Number(req.params.id));
    res.json({ success: true });
  } catch (error: any) {
    logger.error(`Failed to delete movie ${req.params.id}:`, error.message);
    res.status(500).json({ error: 'Failed to delete movie' });
  }
});

// POST /api/movies/:id/retry
router.post('/:id/retry', async (req: Request, res: Response) => {
  const movie = getMovieById(Number(req.params.id));
  if (!movie) {
    res.status(404).json({ error: 'Movie not found' });
    return;
  }

  // Don't retry if already downloading
  if (movie.status === 'downloading') {
    res.json({ success: false, message: 'Movie is already downloading' });
    return;
  }

  // Rate limit: prevent spamming retries (60s cooldown per movie, persisted in DB)
  if (movie.last_retry_at) {
    const lastRetryMs = new Date(movie.last_retry_at + 'Z').getTime();
    const elapsed = Date.now() - lastRetryMs;
    if (elapsed < RETRY_COOLDOWN_MS) {
      const remainingSec = Math.ceil((RETRY_COOLDOWN_MS - elapsed) / 1000);
      res.status(429).json({ success: false, message: `Bitte warte ${remainingSec}s vor dem nächsten Retry` });
      return;
    }
  }
  updateLastRetryAt(movie.id);

  updateMovieStatus(movie.id, 'pending');
  resetRetryCount(movie.id);
  logger.info(`Manual retry for: ${movie.title}`);

  // Re-fetch movie with updated status so processMovie sees 'pending'
  const updatedMovie = getMovieById(movie.id);
  if (!updatedMovie) {
    res.status(404).json({ error: 'Movie was deleted during retry' });
    return;
  }

  // Process immediately in background
  processMovie(updatedMovie).catch(err => {
    logger.error(`Retry error for ${movie.title}:`, err.message);
  });

  res.json({ success: true, message: 'Retry started' });
});

export default router;
