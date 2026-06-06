import { Router, Request, Response } from 'express';
import { collectProblems } from '../../services/problems';
import { logger } from '../../utils/logger';

const router = Router();

// GET /api/problems — everything that needs attention, most severe first.
router.get('/', (_req: Request, res: Response) => {
  try {
    const problems = collectProblems();
    const counts = { error: 0, warning: 0, info: 0 };
    for (const p of problems) counts[p.severity]++;
    res.json({ problems, counts });
  } catch (err: any) {
    logger.error('Problems: collection failed:', err.message);
    res.status(500).json({ error: 'Probleme konnten nicht ermittelt werden' });
  }
});

export default router;
