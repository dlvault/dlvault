import { Router, Request, Response } from 'express';
import { getAllMovies, getMovieById, deleteMovie, updateMovieStatus, resetRetryCount, updateLastRetryAt } from '../../database/services/movies';
import { getDownloadsByMovieId } from '../../database/services/downloads';
import { getLogsByMovieId } from '../../database/services/activityLog';
import { getSeasonsByShowId } from '../../database/services/seasons';
import { getEpisodesBySeasonId } from '../../database/services/episodes';
import { processMovie } from '../../services/scheduler';
import { enrichMovieMetadata } from '../../services/metadata';
import { logger } from '../../utils/logger';
import { parseUtcDate } from '../../utils/datetime';

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

// GET /api/movies — optional ?status= and ?media_type= filters (no param = all)
router.get('/', (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const mediaType = typeof req.query.media_type === 'string' ? req.query.media_type : undefined;
  let movies = getAllMovies();
  if (status) movies = movies.filter(m => m.status === status);
  if (mediaType) movies = movies.filter(m => m.media_type === mediaType);
  res.json(movies);
});

// GET /api/movies/:id
router.get('/:id', async (req: Request, res: Response) => {
  let movie = getMovieById(Number(req.params.id));
  if (!movie) {
    res.status(404).json({ error: 'Movie not found' });
    return;
  }

  movie = await enrichMovieMetadata(movie);

  const downloads = getDownloadsByMovieId(movie.id);
  const logs = getLogsByMovieId(movie.id);
  // For shows, enrich each season with availability derived from the episodes
  // table: how many aired episodes are actually present (status 'downloaded',
  // kept in sync with the media server by the reconcile loop) vs. missing, plus
  // how many of the full season hasn't aired yet. The detail panel renders this
  // as a per-season "X/Y present + which episodes are missing" overview.
  const seasons = movie.media_type === 'show'
    ? getSeasonsByShowId(movie.id).map((s) => {
        const eps = getEpisodesBySeasonId(s.id);
        const downloaded = eps.filter((e) => e.status === 'downloaded').length;
        // Episode rows exist for aired episodes; aired_episodes is Trakt's count.
        const aired = Math.max(eps.length, s.aired_episodes ?? 0);
        const full = Math.max(aired, s.episode_count ?? 0);
        return {
          season_number: s.season_number,
          status: s.status,
          episodes_downloaded: downloaded,
          episodes_aired: aired,
          episodes_total: full,
          episodes_not_yet_aired: Math.max(0, full - aired),
          episodes_missing: eps.filter((e) => e.status !== 'downloaded').map((e) => e.episode_number),
          episodes_complete: aired > 0 && downloaded >= aired,
        };
      })
    : undefined;
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

  // Note: we used to refuse retry while status === 'downloading'. That left a
  // movie permanently stuck whenever its JD download was removed/lost out from
  // under it (the status stayed 'downloading' with no package and no UI way to
  // restart). An explicit user-initiated retry now always resets + re-searches;
  // JDownloader's addLinks dedup skips a genuine duplicate if the package is in
  // fact still present, so this can't double-download an active one.

  // Rate limit: prevent spamming retries (60s cooldown per movie, persisted in DB)
  if (movie.last_retry_at) {
    const lastRetryMs = parseUtcDate(movie.last_retry_at);
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
