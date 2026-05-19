import { Router, Request, Response } from 'express';
import { runFullSync, isSchedulerRunning, isSyncRunning, startScheduler, stopScheduler } from '../../services/scheduler';
import { getRecentLogs } from '../../database/services/activityLog';
import { getAllMovies } from '../../database/services/movies';
import { getLibraryProvider } from '../../services/libraryProvider';
import { logger } from '../../utils/logger';

const router = Router();

// POST /api/sync/run
router.post('/run', async (_req: Request, res: Response) => {
  if (isSyncRunning()) {
    res.status(409).json({ error: 'Sync already running' });
    return;
  }

  // Run in background
  runFullSync().catch(err => {
    logger.error('Background sync failed:', err.message);
  });
  res.json({ success: true, message: 'Sync started' });
});

// GET /api/sync/status
router.get('/status', (_req: Request, res: Response) => {
  const movies = getAllMovies();
  const stats = {
    schedulerRunning: isSchedulerRunning(),
    syncRunning: isSyncRunning(),
    totalMovies: movies.length,
    libraryTotal: getLibraryProvider().getCachedMovieCount(),
    pending: movies.filter(m => m.status === 'pending').length,
    searching: movies.filter(m => m.status === 'searching').length,
    found: movies.filter(m => m.status === 'found').length,
    downloading: movies.filter(m => m.status === 'downloading').length,
    downloaded: movies.filter(m => m.status === 'downloaded').length,
    notFound: movies.filter(m => m.status === 'not_found').length,
  };
  res.json(stats);
});

// GET /api/sync/logs
router.get('/logs', (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  const logs = getRecentLogs(limit);
  res.json(logs);
});

// POST /api/sync/scheduler/start
router.post('/scheduler/start', (_req: Request, res: Response) => {
  startScheduler();
  res.json({ success: true, running: isSchedulerRunning() });
});

// POST /api/sync/scheduler/stop
router.post('/scheduler/stop', (_req: Request, res: Response) => {
  stopScheduler();
  res.json({ success: true, running: false });
});

export default router;
