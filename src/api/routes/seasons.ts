import { Router, Request, Response } from 'express';
import { getMovieById } from '../../database/services/movies';
import { getSeasonsByShowId, addSeason, addSeasons, updateSeasonStatus, deleteSeason, getSeason } from '../../database/services/seasons';
import { getEpisodesBySeasonId, addEpisodes, updateEpisodeStatus, getSeasonCompletionStatus } from '../../database/services/episodes';
import { addLogEntry } from '../../database/services/activityLog';
import { logger } from '../../utils/logger';

const router = Router();

// GET /api/seasons/:movieId — get all seasons for a show (with episode stats)
router.get('/:movieId', (req: Request, res: Response) => {
  const movieId = Number(req.params.movieId);
  const movie = getMovieById(movieId);

  if (!movie) {
    res.status(404).json({ error: 'Show not found' });
    return;
  }

  if (movie.media_type !== 'show') {
    res.status(400).json({ error: 'Not a show' });
    return;
  }

  const seasons = getSeasonsByShowId(movieId).map(s => {
    const completion = getSeasonCompletionStatus(s.id);
    return {
      ...s,
      episodes_total: completion.total,
      episodes_downloaded: completion.downloaded,
      episodes_complete: completion.allDone,
    };
  });
  res.json({ show: movie, seasons });
});

// POST /api/seasons/:movieId — add season(s) to a show
router.post('/:movieId', (req: Request, res: Response) => {
  const movieId = Number(req.params.movieId);
  const movie = getMovieById(movieId);

  if (!movie) {
    res.status(404).json({ error: 'Show not found' });
    return;
  }

  const { seasonNumber, seasonNumbers, quality } = req.body;

  if (seasonNumbers && Array.isArray(seasonNumbers)) {
    const valid = seasonNumbers.filter((n: number) => Number.isInteger(n) && n > 0);
    if (valid.length === 0) {
      res.status(400).json({ error: 'Invalid season numbers' });
      return;
    }
    const seasons = addSeasons(movieId, valid, quality);
    addLogEntry(movieId, 'seasons_added', `Added seasons ${valid.join(', ')} for ${movie.title}`);
    res.json({ seasons });
  } else if (seasonNumber && Number.isInteger(seasonNumber) && seasonNumber > 0) {
    const season = addSeason(movieId, seasonNumber, quality);
    addLogEntry(movieId, 'season_added', `Added season ${seasonNumber} for ${movie.title}`);
    res.json({ season });
  } else {
    res.status(400).json({ error: 'seasonNumber or seasonNumbers required' });
  }
});

// PUT /api/seasons/:movieId/:seasonNumber — update season status
router.put('/:movieId/:seasonNumber', (req: Request, res: Response) => {
  const movieId = Number(req.params.movieId);
  const seasonNumber = Number(req.params.seasonNumber);
  const season = getSeason(movieId, seasonNumber);

  if (!season) {
    res.status(404).json({ error: 'Season not found' });
    return;
  }

  const { status } = req.body;
  if (!status) {
    res.status(400).json({ error: 'status required' });
    return;
  }

  try {
    updateSeasonStatus(season.id, status);
    res.json({ success: true });
  } catch (error: any) {
    logger.error(`Failed to update season status:`, error.message);
    res.status(500).json({ error: 'Failed to update season' });
  }
});

// DELETE /api/seasons/:movieId/:seasonNumber — remove a season
router.delete('/:movieId/:seasonNumber', (req: Request, res: Response) => {
  const movieId = Number(req.params.movieId);
  const seasonNumber = Number(req.params.seasonNumber);
  const season = getSeason(movieId, seasonNumber);

  if (!season) {
    res.status(404).json({ error: 'Season not found' });
    return;
  }

  try {
    deleteSeason(season.id);
    logger.info(`Deleted season ${seasonNumber} from show ${movieId}`);
    res.json({ success: true });
  } catch (error: any) {
    logger.error(`Failed to delete season:`, error.message);
    res.status(500).json({ error: 'Failed to delete season' });
  }
});

// GET /api/seasons/:movieId/:seasonNumber/episodes — list episodes for a season
router.get('/:movieId/:seasonNumber/episodes', (req: Request, res: Response) => {
  const movieId = Number(req.params.movieId);
  const seasonNumber = Number(req.params.seasonNumber);
  const season = getSeason(movieId, seasonNumber);

  if (!season) {
    res.status(404).json({ error: 'Season not found' });
    return;
  }

  const episodes = getEpisodesBySeasonId(season.id);
  const completion = getSeasonCompletionStatus(season.id);
  res.json({ season, episodes, completion });
});

// PUT /api/seasons/:movieId/:seasonNumber/episodes/:episodeNumber — update episode status
router.put('/:movieId/:seasonNumber/episodes/:episodeNumber', (req: Request, res: Response) => {
  const movieId = Number(req.params.movieId);
  const seasonNumber = Number(req.params.seasonNumber);
  const episodeNumber = Number(req.params.episodeNumber);
  const season = getSeason(movieId, seasonNumber);

  if (!season) {
    res.status(404).json({ error: 'Season not found' });
    return;
  }

  const episodes = getEpisodesBySeasonId(season.id);
  const episode = episodes.find(e => e.episode_number === episodeNumber);

  if (!episode) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }

  const { status } = req.body;
  if (!status) {
    res.status(400).json({ error: 'status required' });
    return;
  }

  try {
    updateEpisodeStatus(episode.id, status);
    res.json({ success: true });
  } catch (error: any) {
    logger.error(`Failed to update episode status:`, error.message);
    res.status(500).json({ error: 'Failed to update episode' });
  }
});

export default router;
