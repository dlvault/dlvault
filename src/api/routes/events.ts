import { Router, Request, Response } from 'express';
import { eventBus } from '../../services/eventbus';

const router = Router();

// GET /api/events — SSE stream
router.get('/', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ event: 'connected', data: {} })}\n\n`);

  const accepted = eventBus.addClient(res);
  if (!accepted) {
    res.write(`data: ${JSON.stringify({ event: 'error', data: { message: 'Too many connections' } })}\n\n`);
    res.end();
    return;
  }

  // Keepalive ping every 30 seconds
  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepalive);
    }
  }, 30000);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    eventBus.removeClient(res);
  });
});

export default router;
