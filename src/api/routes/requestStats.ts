import { Router, Request, Response } from 'express';
import db from '../../database/index';
import { logger } from '../../utils/logger';

const router = Router();

// GET /api/stats/requests — how many source searches dlvault started: the last
// hour, 24 hours, 7 days, and per day. The numbers an operator needs to tune
// scheduler.max_searches_per_hour / min_days_between_searches without guessing.
router.get('/requests', (_req: Request, res: Response) => {
  try {
    const count = (modifier: string) => (db.prepare(
      "SELECT COUNT(*) AS c FROM activity_log WHERE action = 'search_started' AND created_at >= datetime('now', ?)",
    ).get(modifier) as { c: number }).c;
    const perDay = db.prepare(
      "SELECT date(created_at) AS day, COUNT(*) AS c FROM activity_log WHERE action = 'search_started' AND created_at >= datetime('now', '-7 days') GROUP BY day ORDER BY day DESC",
    ).all() as { day: string; c: number }[];
    res.json({ lastHour: count('-1 hour'), last24h: count('-24 hours'), last7d: count('-7 days'), perDay });
  } catch (err: any) {
    logger.error('Request stats failed:', err.message);
    res.status(500).json({ error: 'Statistik konnte nicht ermittelt werden' });
  }
});

export default router;
