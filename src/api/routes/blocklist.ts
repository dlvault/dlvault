import { Router, Request, Response } from 'express';
import { getBlocklist, addBlocklistEntry, removeBlocklistEntry, clearBlocklist } from '../../database/services/blocklist';
import { logger } from '../../utils/logger';

const router = Router();

// GET /api/blocklist
router.get('/', (_req: Request, res: Response) => {
  res.json(getBlocklist());
});

// POST /api/blocklist
router.post('/', (req: Request, res: Response) => {
  const { release_name, title, reason, movie_id } = req.body;
  if (!release_name || typeof release_name !== 'string') {
    res.status(400).json({ error: 'release_name is required' });
    return;
  }
  const entry = addBlocklistEntry({ release_name, title, reason, movie_id });
  logger.info(`Blocklist: added "${release_name}"`);
  res.json(entry);
});

// DELETE /api/blocklist/:id
router.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  const removed = removeBlocklistEntry(id);
  if (removed) {
    logger.info(`Blocklist: removed entry #${id}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Entry not found' });
  }
});

// DELETE /api/blocklist
router.delete('/', (_req: Request, res: Response) => {
  const count = clearBlocklist();
  logger.info(`Blocklist: cleared ${count} entries`);
  res.json({ cleared: count });
});

export default router;
