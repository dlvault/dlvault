import { Router, Request, Response } from 'express';
import { listTokens, createToken, revokeToken } from '../../mcp/tokens';
import { toolDocs } from '../../mcp/docs';
import { GROUPS, TOOLS } from '../../mcp/tools';

const router = Router();

// GET /api/mcp — tokens (never the secret) and the tool list for the settings page.
router.get('/', (_req: Request, res: Response) => {
  res.json({
    tokens: listTokens().map(({ hash: _h, ...t }) => t),
    groups: Object.entries(GROUPS).map(([id, g]) => ({ id, ...g, tools: TOOLS.filter(t => t.group === id).map(t => ({ name: t.name, write: t.write, description: t.description })) })),
  });
});

// POST /api/mcp/tokens { name, scope } — the clear token is returned once.
router.post('/tokens', (req: Request, res: Response) => {
  const { name, scope } = (req.body || {}) as { name?: string; scope?: string };
  res.json(createToken(String(name || 'KI'), scope === 'write' ? 'write' : 'read'));
});

router.delete('/tokens/:id', (req: Request, res: Response) => {
  if (!revokeToken(String(req.params.id))) { res.status(404).json({ error: 'Nicht gefunden' }); return; }
  res.json({ ok: true });
});

// GET /api/mcp/docs — generated tool documentation (Markdown).
router.get('/docs', (_req: Request, res: Response) => { res.type('text/markdown').send(toolDocs()); });

export default router;
