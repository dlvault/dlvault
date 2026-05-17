import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { jdownloaderService, JDPackage, JDExtractionItem } from '../../jdownloader/index';
import { logger } from '../../utils/logger';

const router = Router();

/**
 * Quick non-recursive scan for active extraction temp files.
 * Checks for JD-specific markers (.extracting, .tmp) and recently-modified
 * archive parts. Old completed archives are ignored to avoid permanent
 * false-posititives when JD is configured to keep extracted files.
 */
async function hasExtractionTempFiles(dirPath: string): Promise<boolean> {
  const EXTRACTION_MARKER_RE = /\.(extracting|tmp)$/i;
  const ARCHIVE_PART_RE = /\.(part\d+|r\d{2}|[0-9]{3}|rev)$/i;
  const RECENT_MS = 5 * 60 * 1000; // 5 minutes

  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const now = Date.now();

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Check for temp directories or recently-modified subdirs
        try {
          const subEntries = await fs.promises.readdir(fullPath, { withFileTypes: true });
          for (const sub of subEntries) {
            const subPath = path.join(fullPath, sub.name);
            if (EXTRACTION_MARKER_RE.test(sub.name)) return true;
            if (ARCHIVE_PART_RE.test(sub.name)) {
              try {
                const stat = await fs.promises.stat(subPath);
                if (now - stat.mtimeMs < RECENT_MS) return true;
              } catch { /* ignore */ }
            }
          }
        } catch {
          /* ignore unreadable subdirs */
        }
      } else {
        if (EXTRACTION_MARKER_RE.test(entry.name)) return true;
        if (ARCHIVE_PART_RE.test(entry.name)) {
          try {
            const stat = await fs.promises.stat(fullPath);
            if (now - stat.mtimeMs < RECENT_MS) return true;
          } catch { /* ignore */ }
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Cross-reference packages with JD's extraction extension queue.
 * JD marks packages `finished:true` as soon as the download completes — extraction
 * is a separate extension. Without this lookup the UI flips to "Fertig" mid-extract.
 */
function annotateExtractionFromQueue(packages: JDPackage[], queue: JDExtractionItem[]): void {
  if (!queue.length) return;

  const active = queue.filter(item => {
    const s = String(item.controllerStatus || '').toUpperCase();
    // Anything not explicitly idle/finished counts as in-progress
    return s && s !== 'IDLE' && s !== 'FINISHED' && s !== 'SUCCESSFUL';
  });
  if (!active.length) return;

  for (const pkg of packages) {
    const saveTo = pkg.saveTo ? path.normalize(pkg.saveTo) : '';
    const pkgName = (pkg.name || '').toLowerCase();

    const match = active.some(item => {
      const candidates: string[] = [];
      if (item.archiveId) candidates.push(item.archiveId);
      if (item.name) candidates.push(item.name);
      if (Array.isArray(item.archiveFiles)) candidates.push(...item.archiveFiles);

      for (const c of candidates) {
        if (!c) continue;
        const norm = path.normalize(c);
        if (saveTo && norm.startsWith(saveTo)) return true;
        if (pkgName && c.toLowerCase().includes(pkgName)) return true;
      }
      return false;
    });

    if (match) {
      (pkg as any).isExtracting = true;
      const item = active.find(it => {
        const saveToN = saveTo;
        return (it.archiveId && path.normalize(it.archiveId).startsWith(saveToN)) ||
               (Array.isArray(it.archiveFiles) && it.archiveFiles.some(f => path.normalize(f).startsWith(saveToN)));
      });
      if (item && typeof item.progress === 'number') {
        (pkg as any).extractionProgress = item.progress;
      }
    }
  }
}

// GET /api/downloads/packages — active downloads
router.get('/packages', async (_req: Request, res: Response) => {
  if (!jdownloaderService.isConfigured()) {
    res.json({ connected: false, packages: [] });
    return;
  }

  try {
    const [packages, extractionQueue] = await Promise.all([
      jdownloaderService.getDownloadPackages(),
      jdownloaderService.getExtractionQueue().catch(() => [] as JDExtractionItem[]),
    ]);

    // 1. Primary: ask JD's extraction extension which packages are being extracted.
    annotateExtractionFromQueue(packages, extractionQueue);

    // 2. Fallback: filesystem scan for finished packages.
    //    - saveTo exists with extraction temp files → still extracting
    //    - saveTo missing entirely → post-processor moved the source folder away
    for (const pkg of packages) {
      if ((pkg as any).isExtracting) continue;
      if (!pkg.finished || !pkg.saveTo) continue;
      try {
        await fs.promises.access(pkg.saveTo);
        if (await hasExtractionTempFiles(pkg.saveTo)) {
          (pkg as any).isExtracting = true;
        }
      } catch {
        // saveTo no longer exists — the post-processor moved the file into the
        // library and removed the source folder. Flag as "moved" so the UI can
        // transition out of the "Entpacken" state instead of getting stuck.
        (pkg as any).isMoved = true;
      }
    }

    res.json({ connected: true, packages });
  } catch (error: any) {
    logger.error('Failed to get download packages:', error.message);
    res.json({ connected: false, packages: [] });
  }
});

// GET /api/downloads/links — individual download links
router.get('/links', async (_req: Request, res: Response) => {
  try {
    const links = await jdownloaderService.getDownloadLinks();
    res.json(links);
  } catch (error: any) {
    logger.error('Failed to get download links:', error.message);
    res.status(500).json({ error: 'Failed to fetch links' });
  }
});

// GET /api/downloads/linkgrabber — queued packages in linkgrabber
router.get('/linkgrabber', async (_req: Request, res: Response) => {
  try {
    const packages = await jdownloaderService.getLinkGrabberPackages();
    res.json(packages);
  } catch (error: any) {
    logger.error('Failed to get linkgrabber:', error.message);
    res.status(500).json({ error: 'Failed to fetch linkgrabber' });
  }
});

// GET /api/downloads/state — download controller state
router.get('/state', async (_req: Request, res: Response) => {
  try {
    const state = await jdownloaderService.getSpeed();
    res.json({ state });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to get state' });
  }
});

// POST /api/downloads/start
router.post('/start', async (_req: Request, res: Response) => {
  try {
    const success = await jdownloaderService.startDownloads();
    res.json({ success });
  } catch (error: any) {
    logger.error('Failed to start downloads:', error.message);
    res.status(500).json({ error: 'Failed to start downloads' });
  }
});

// POST /api/downloads/stop
router.post('/stop', async (_req: Request, res: Response) => {
  try {
    const success = await jdownloaderService.stopDownloads();
    res.json({ success });
  } catch (error: any) {
    logger.error('Failed to stop downloads:', error.message);
    res.status(500).json({ error: 'Failed to stop downloads' });
  }
});

// POST /api/downloads/pause
router.post('/pause', async (req: Request, res: Response) => {
  try {
    const { pause } = req.body;
    const success = await jdownloaderService.pauseDownloads(pause !== false);
    res.json({ success });
  } catch (error: any) {
    logger.error('Failed to pause downloads:', error.message);
    res.status(500).json({ error: 'Failed to pause downloads' });
  }
});

// DELETE /api/downloads/packages/:ids
router.delete('/packages/:ids', async (req: Request, res: Response) => {
  try {
    const ids = String(req.params.ids).split(',').map(Number).filter(id => Number.isInteger(id) && id > 0);
    if (ids.length === 0 || ids.length > 100) {
      res.status(400).json({ error: 'Invalid package IDs' });
      return;
    }
    const success = await jdownloaderService.removePackages(ids);
    res.json({ success });
  } catch (error: any) {
    logger.error('Failed to remove packages:', error.message);
    res.status(500).json({ error: 'Failed to remove packages' });
  }
});

// DELETE /api/downloads/linkgrabber/:ids
router.delete('/linkgrabber/:ids', async (req: Request, res: Response) => {
  try {
    const ids = String(req.params.ids).split(',').map(Number).filter(id => Number.isInteger(id) && id > 0);
    if (ids.length === 0 || ids.length > 100) {
      res.status(400).json({ error: 'Invalid package IDs' });
      return;
    }
    const success = await jdownloaderService.removeLinkGrabberPackages(ids);
    res.json({ success });
  } catch (error: any) {
    logger.error('Failed to remove linkgrabber packages:', error.message);
    res.status(500).json({ error: 'Failed to remove linkgrabber packages' });
  }
});

// POST /api/downloads/linkgrabber/move — move queued linkgrabber packages into the download list
router.post('/linkgrabber/move', async (req: Request, res: Response) => {
  try {
    const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = raw.map((n: unknown) => Number(n)).filter((id: number) => Number.isInteger(id) && id > 0);
    if (ids.length === 0 || ids.length > 100) {
      res.status(400).json({ error: 'Invalid package IDs' });
      return;
    }
    const success = await jdownloaderService.moveLinkGrabberToDownloadlist(ids);
    res.json({ success });
  } catch (error: any) {
    logger.error('Failed to move linkgrabber packages:', error.message);
    res.status(500).json({ error: 'Failed to move linkgrabber packages' });
  }
});

// GET /api/downloads/speed-limit
router.get('/speed-limit', async (_req: Request, res: Response) => {
  try {
    const [limit, enabled] = await Promise.all([
      jdownloaderService.getSpeedLimit(),
      jdownloaderService.isSpeedLimited(),
    ]);
    res.json({ enabled, limitKbps: limit });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to get speed limit' });
  }
});

// POST /api/downloads/speed-limit
router.post('/speed-limit', async (req: Request, res: Response) => {
  const { enabled, limitKbps } = req.body;

  try {
    if (typeof limitKbps === 'number') {
      await jdownloaderService.setSpeedLimit(limitKbps);
    }
    if (typeof enabled === 'boolean') {
      await jdownloaderService.setSpeedLimitEnabled(enabled);
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to set speed limit' });
  }
});

export default router;
