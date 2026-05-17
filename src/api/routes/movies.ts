import { Router, Request, Response } from 'express';
import { getAllMovies, getMovieById, deleteMovie, updateMovieStatus, resetRetryCount, updateLastRetryAt } from '../../database/services/movies';
import { getDownloadsByMovieId } from '../../database/services/downloads';
import { getLogsByMovieId } from '../../database/services/activityLog';
import { getSeasonsByShowId } from '../../database/services/seasons';
import { processMovie } from '../../services/scheduler';
import { logger } from '../../utils/logger';

const router = Router();

const RETRY_COOLDOWN_MS = 60 * 1000;

// GET /api/movies
router.get('/', (_req: Request, res: Response) => {
  const movies = getAllMovies();
  res.json(movies);
});

// GET /api/movies/:id
router.get('/:id', (req: Request, res: Response) => {
  const movie = getMovieById(Number(req.params.id));
  if (!movie) {
    res.status(404).json({ error: 'Movie not found' });
    return;
  }

  const downloads = getDownloadsByMovieId(movie.id);
  const logs = getLogsByMovieId(movie.id);
  const seasons = movie.media_type === 'show' ? getSeasonsByShowId(movie.id) : undefined;
  res.json({ ...movie, downloads, logs, seasons });
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
