import express, { Request, Response, NextFunction } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { initDatabase, closeDatabase } from './database/index';
import { getSetting } from './database/index';
import db from './database/index';
import { startScheduler, stopScheduler, isSyncRunning, isSchedulerRunning } from './services/scheduler';
import { startPostProcessor, stopPostProcessor } from './services/postprocess';
import { startBandwidthScheduler, stopBandwidthScheduler } from './services/bandwidth';
import { startTelegramBot } from './services/telegram';
import { startBackupScheduler, stopBackupScheduler } from './services/backup';
import { jdownloaderService } from './jdownloader/index';
import { pluginRegistry } from './plugins/registry';
import { loadDynamicPlugins } from './plugins/bootstrap';
import { logger } from './utils/logger';
import { getMetrics } from './services/metrics';
import fs from 'fs';
import { execFileSync } from 'child_process';
import settingsRoutes from './api/routes/settings';
import moviesRoutes from './api/routes/movies';
import syncRoutes from './api/routes/sync';
import downloadsRoutes from './api/routes/downloads';
import libraryRoutes from './api/routes/library';
import eventsRoutes from './api/routes/events';
import searchRoutes from './api/routes/search';
import seasonsRoutes from './api/routes/seasons';
import blocklistRoutes from './api/routes/blocklist';
import healthRoutes, { runDeepHealthCheck, logDeepHealth } from './api/routes/health';
import posterRoutes from './api/routes/poster';
import updateRoutes from './api/routes/update';
import pluginsRoutes from './api/routes/plugins';

// Load user-installed plugins from data/plugins/ before middleware so their
// CSP domains are known when helmet's CSP directives are evaluated below.
// dlvault ships zero bundled sources — the core is a plugin host and users
// install the sources they want via the Plugin settings UI.
const dynamicLoad = loadDynamicPlugins();
if (dynamicLoad.loaded.length || dynamicLoad.pending.length || dynamicLoad.errors.length) {
  logger.info(`Plugin loader: ${dynamicLoad.loaded.length} loaded, ${dynamicLoad.pending.length} pending, ${dynamicLoad.errors.length} errors`);
}

const app = express();
const PORT = process.env.PORT || 3000;
const startTime = new Date().toISOString();

// Compression — skip Server-Sent Events. gzip buffers until a compression
// block fills, which breaks the streaming guarantee EventSource depends on:
// short bursts of events would never reach the browser until the buffer
// fills (often "never" for sub-second update flows).
app.use(compression({
  filter: (req, res) => {
    if (res.getHeader('Content-Type')?.toString().startsWith('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));

// Security middleware. imgSrc is built from each registered plugin's
// declared CSP domains plus the always-allowed schemes — this keeps the
// core source-agnostic.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", ...pluginRegistry.getCspDomains()],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  hsts: false,
}));
const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors({
  origin: corsOrigin || false,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api/', apiLimiter);

// Stricter rate limit for sync trigger
const syncLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 5,
  message: { error: 'Zu viele Sync-Anfragen. Bitte kurz warten.' },
});
app.use('/api/sync/run', syncLimiter);

// Optional API token auth (set API_TOKEN env var to enable)
// Browser UI requests (no Authorization header) pass through.
// External API calls (Lexi etc.) must send: Authorization: Bearer <token>
const API_TOKEN = process.env.API_TOKEN;
if (API_TOKEN) {
  const expectedToken = Buffer.from(API_TOKEN, 'utf-8');
  app.use('/api/', (req, res, next) => {
    const authHeader = req.headers.authorization;
    // No Authorization header = browser UI request, allow through
    if (!authHeader) return next();
    // Validate the provided token
    const token = authHeader.replace('Bearer ', '');
    const providedToken = Buffer.from(token, 'utf-8');
    if (providedToken.length !== expectedToken.length ||
        !crypto.timingSafeEqual(providedToken, expectedToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });
  logger.info('API token authentication enabled');
}

// Health check endpoint with metrics
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    scheduler: isSchedulerRunning(),
    syncRunning: isSyncRunning(),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    metrics: getMetrics(),
    version: process.env.GIT_COMMIT || 'dev',
    startedAt: startTime,
  });
});

// Detailed health check — service connections + disk space
// /api/health/detailed combines fast snapshots (uptime, memory, DB counts) with
// slow network probes (JD/Jellyfin/Plex testConnection, plugin sentinel HTTP
// calls). The slow part is identical between requests within a 30-second
// window — caching it cuts dashboard hard-reloads from ~4 s to ~10 ms on a
// warm cache. Pass ?force=true to skip the cache (e.g. after changing
// credentials).
interface HealthSnapshot {
  services: Record<string, { configured: boolean; connected: boolean; error?: string }>;
  plugins: Array<{ id: string; name: string; ok: boolean; critical: boolean; detail?: string; error?: string }>;
  disk: Record<string, { path: string; totalGB: number; freeGB: number; usedPercent: number } | { path: string; error: string }>;
}
let healthSnapshotCache: { ts: number; data: HealthSnapshot } | null = null;
const HEALTH_CACHE_TTL_MS = 30_000;

/**
 * Disk usage for a path. Primary path is fs.statfsSync — cross-platform
 * (Linux/macOS/Windows), no subprocess. Falls back to the `df` shell command
 * only if statfs is unavailable or throws. `df` does not exist on Windows, so
 * statfs is what keeps the disk panel working there. Returns null if both fail.
 */
function readDiskUsage(p: string): { totalGB: number; freeGB: number; usedPercent: number } | null {
  const toGB = (bytes: number) => Math.round(bytes / 1073741824 * 10) / 10;

  try {
    const s = fs.statfsSync(p);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    const usedBytes = (s.blocks - s.bfree) * s.bsize;
    return {
      totalGB: toGB(totalBytes),
      freeGB: toGB(freeBytes),
      usedPercent: totalBytes > 0 ? Math.round(usedBytes / totalBytes * 100) : 0,
    };
  } catch { /* fall through to df */ }

  try {
    // execFile avoids shell interpolation — paths from settings are user config.
    const output = execFileSync('df', ['-k', p], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = output.trim().split('\n');
    const parts = lines[lines.length - 1].split(/\s+/);
    if (parts.length >= 4) {
      const totalKB = parseInt(parts[1], 10);
      const usedKB = parseInt(parts[2], 10);
      const freeKB = parseInt(parts[3], 10);
      return {
        totalGB: Math.round(totalKB / 1048576 * 10) / 10,
        freeGB: Math.round(freeKB / 1048576 * 10) / 10,
        usedPercent: totalKB > 0 ? Math.round(usedKB / totalKB * 100) : 0,
      };
    }
  } catch { /* both failed */ }

  return null;
}

async function computeHealthSnapshot(): Promise<HealthSnapshot> {
  const pathKeys = ['paths.downloads', 'paths.movies', 'paths.series'] as const;
  const diskInfo: HealthSnapshot['disk'] = {};

  for (const key of pathKeys) {
    const p = getSetting(key);
    if (!p || !fs.existsSync(p)) {
      diskInfo[key] = { path: p || '', error: 'Pfad nicht verfügbar' };
      continue;
    }
    const usage = readDiskUsage(p);
    diskInfo[key] = usage
      ? { path: p, ...usage }
      : { path: p, error: 'Konnte Speicherplatz nicht lesen' };
  }

  // Service connection checks (parallel)
  const services: Record<string, { configured: boolean; connected: boolean; error?: string }> = {};

  const checks = await Promise.allSettled([
    // JDownloader
    (async () => {
      if (!jdownloaderService.isConfigured()) return { name: 'jdownloader', configured: false, connected: false };
      try {
        const connected = await jdownloaderService.connect();
        return { name: 'jdownloader', configured: true, connected };
      } catch (e: any) {
        return { name: 'jdownloader', configured: true, connected: false, error: e.message };
      }
    })(),
    // Trakt
    (async () => {
      const { traktService } = await import('./services/trakt');
      return { name: 'trakt', configured: traktService.isConfigured(), connected: traktService.isAuthenticated() };
    })(),
    // Telegram
    (async () => {
      const enabled = getSetting('telegram.enabled') === 'true';
      const configured = !!getSetting('telegram.bot_token');
      return { name: 'telegram', configured: enabled && configured, connected: enabled && configured };
    })(),
    // Jellyfin
    (async () => {
      const { jellyfinService } = await import('./services/jellyfin');
      if (!jellyfinService.isConfigured()) return { name: 'jellyfin', configured: false, connected: false };
      try {
        const result = await jellyfinService.testConnection();
        return { name: 'jellyfin', configured: true, connected: result.success };
      } catch (e: any) {
        return { name: 'jellyfin', configured: true, connected: false, error: e.message };
      }
    })(),
    // Plex
    (async () => {
      const { plexLibraryService } = await import('./services/plexLibrary');
      if (!plexLibraryService.isConfigured()) return { name: 'plex', configured: false, connected: false };
      try {
        const result = await plexLibraryService.testConnection();
        return { name: 'plex', configured: true, connected: result.success };
      } catch (e: any) {
        return { name: 'plex', configured: true, connected: false, error: e.message };
      }
    })(),
  ]);

  for (const result of checks) {
    if (result.status === 'fulfilled') {
      const { name, ...rest } = result.value;
      services[name] = rest;
    }
  }

  // Plugin health — each registered plugin that implements healthCheck() reports
  // its own liveness. Aggregated into the dashboard so the user can see at a
  // glance which plugin is misbehaving.
  let plugins: Array<{ id: string; name: string; ok: boolean; critical: boolean; detail?: string; error?: string }> = [];
  try {
    const pluginHealth = await pluginRegistry.runHealthChecks();
    plugins = Object.entries(pluginHealth).map(([id, outcome]) => {
      const p = pluginRegistry.getById(id);
      return { id, name: p?.name || id, ...outcome };
    });
  } catch {
    // Plugin health failures are non-fatal — leave the array empty.
  }

  return { services, plugins, disk: diskInfo };
}

app.get('/api/health/detailed', async (req, res) => {
  const force = req.query.force === 'true';
  const now = Date.now();

  let snapshot: HealthSnapshot;
  let cached = false;
  if (!force && healthSnapshotCache && now - healthSnapshotCache.ts < HEALTH_CACHE_TTL_MS) {
    snapshot = healthSnapshotCache.data;
    cached = true;
  } else {
    snapshot = await computeHealthSnapshot();
    healthSnapshotCache = { ts: now, data: snapshot };
  }

  // Fast/dynamic fields stay outside the cache — uptime, memory, DB counts
  // change every second, so caching them would be misleading.
  const movieCount = (db.prepare('SELECT COUNT(*) as c FROM movies').get() as { c: number }).c;
  const downloadCount = (db.prepare('SELECT COUNT(*) as c FROM downloads').get() as { c: number }).c;
  const blocklistCount = (db.prepare('SELECT COUNT(*) as c FROM blocklist').get() as { c: number }).c;

  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    scheduler: isSchedulerRunning(),
    syncRunning: isSyncRunning(),
    version: process.env.GIT_COMMIT || 'dev',
    services: snapshot.services,
    plugins: snapshot.plugins,
    disk: snapshot.disk,
    database: { movies: movieCount, downloads: downloadCount, blocklist: blocklistCount },
    metrics: getMetrics(),
    cached,
  });
});

// Update check — compares running GIT_COMMIT against latest GitHub commit
// (cached 5 min). Pre-eff4ccf there was an image-SHA cross-check here as a
// backstop for the buildx-cache OCI-drift loop; that backstop is gone now
// because (a) the source bug is fixed at build time, and (b) the check
// compared against the *local* :latest tag — which is stale until the user
// actually pulls the new image, suppressing real updates as false negatives.
let updateCache: { ts: number; latest: string | null; current: string; updateAvailable: boolean } = { ts: 0, latest: null, current: '', updateAvailable: false };

app.get('/api/update-check', async (req, res) => {
  const current = process.env.GIT_COMMIT || 'dev';
  const now = Date.now();
  const force = req.query.force === 'true';

  if (current === 'dev') {
    return res.json({ updateAvailable: false, current, latest: null, message: 'Dev-Modus — kein Update-Check', platform: 'linux' });
  }

  const platform = fs.existsSync('/.dockerenv') ? 'docker' : process.platform === 'win32' ? 'windows' : 'linux';

  // Return cached result if fresh (5 min) — skip cache with ?force=true.
  if (!force && updateCache.ts > now - 300000 && updateCache.current === current) {
    return res.json({ updateAvailable: updateCache.updateAvailable, current, latest: updateCache.latest, cached: true, platform });
  }

  const ghToken = process.env.GITHUB_TOKEN;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'dlvault',
    };
    if (ghToken) headers.Authorization = `token ${ghToken}`;
    const repo = process.env.UPDATE_CHECK_REPO || 'dlvault/dlvault';
    const resp = await fetch(`https://api.github.com/repos/${repo}/commits/main`, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      return res.json({ updateAvailable: false, current, latest: null, message: `GitHub API Fehler: ${resp.status}` });
    }

    const data = await resp.json() as { sha: string };
    const latest = data.sha?.substring(0, current.length) || null;
    const updateAvailable = !!latest && latest !== current;
    updateCache = { ts: now, latest, current, updateAvailable };
    res.json({ updateAvailable, current, latest, platform });
  } catch {
    res.json({ updateAvailable: false, current, latest: null, message: 'Update-Check fehlgeschlagen', platform });
  }
});

// SSE events endpoint (before rate limiter for long-lived connections)
app.use('/api/events', eventsRoutes);
app.use('/api/update', updateRoutes);

// API routes
app.use('/api/settings', settingsRoutes);
app.use('/api/movies', moviesRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/downloads', downloadsRoutes);
app.use('/api/library', libraryRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/seasons', seasonsRoutes);
app.use('/api/blocklist', blocklistRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/poster', posterRoutes);
app.use('/api/plugins', pluginsRoutes);

// Serve frontend in production
const frontendDist = path.join(__dirname, '../frontend/dist');
app.use(express.static(frontendDist, {
  maxAge: '7d',
  immutable: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.get('*path', (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
    // Frontend not built (backend-only CI/test run) — answer a plain 404
    // instead of letting sendFile's ENOENT bubble to the 500 error handler.
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Express error-handling middleware (must be after all routes)
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled route error:', err.message, err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Global error handlers — prevent silent crashes
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err.message, err.stack);
  // Give logger time to flush, then exit
  setTimeout(() => process.exit(1), 1000);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.error('Unhandled promise rejection:', msg, stack);
});

// Initialize
initDatabase();
logger.info('Database initialized');

// Start scheduler, post-processor, and telegram bot
startScheduler();
startPostProcessor();
startBandwidthScheduler();
startTelegramBot();
startBackupScheduler();

// Request timeout — prevent hanging requests (4 minutes covers captcha-heavy plugin resolution)
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.setTimeout(240000); // 4 minute timeout
  next();
});

const server = app.listen(PORT, async () => {
  logger.info(`Dlvault running on http://localhost:${PORT}`);

  // Push settings to JDownloader on startup
  if (jdownloaderService.isConfigured()) {
    // Push 2Captcha key to JDownloader's own captcha-solver if configured.
    // The key lives under the generic secret-store so plugins can read it too.
    const twoCaptchaKey = getSetting('secret-store.2captcha-api-key');
    if (twoCaptchaKey) {
      jdownloaderService.configure2CaptchaSolver(twoCaptchaKey).catch(err => {
        logger.error('Failed to push 2Captcha key to JDownloader:', err.message);
      });
    }
  }

  // Boot-time deep health check — runs all canaries after startup and logs
  // the verdict. Opt in via DLVAULT_BOOT_HEALTHCHECK (default: on).
  // Using setTimeout(0) so we don't block the listen() callback.
  if (process.env.DLVAULT_BOOT_HEALTHCHECK !== 'false') {
    setTimeout(async () => {
      try {
        logger.info('Running boot health check…');
        const payload = await runDeepHealthCheck();
        logDeepHealth(payload, 'Boot health');
        if (payload.overall === 'unhealthy') {
          // Unhealthy boot: keep running (user may want to inspect), but shout loud.
          logger.error('Boot health check reported UNHEALTHY — critical checks failed. Investigate before relying on this deploy.');
        }
      } catch (err: any) {
        logger.error(`Boot health check failed to run: ${err.message}`);
      }
    }, 0);
  }

  // Best-effort: pre-pull the updater image so the first "Update" click in
  // the UI doesn't pay the registry round-trip. Non-blocking; if the host
  // can't reach the registry now, the click-time pull handles it. We delay
  // by a few seconds to let JDownloader/Trakt/etc. finish their own startup
  // before we touch the docker socket.
  if (process.env.DLVAULT_PREPULL_UPDATER !== 'false') {
    setTimeout(async () => {
      try {
        const { ensureUpdaterImage } = await import('./api/routes/update');
        const result = await ensureUpdaterImage();
        if (result.pulled) {
          logger.info('Updater image pre-pulled — one-click update is ready.');
        } else if (!result.available) {
          logger.debug(`Updater image pre-pull skipped: ${result.error || 'unknown'}`);
        }
      } catch (err: any) {
        logger.debug(`Updater pre-pull skipped: ${err.message}`);
      }
    }, 5000);
  }
});

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info(`${signal} received, shutting down gracefully...`);
    stopScheduler();
    stopPostProcessor();
    stopBandwidthScheduler();
    stopBackupScheduler();

    // Stop accepting new connections
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // Wait for in-flight sync to finish (max 30s)
    const deadline = Date.now() + 30000;
    while (isSyncRunning() && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (isSyncRunning()) {
      logger.warn('Sync still running after 30s timeout, forcing shutdown');
    }

    await pluginRegistry.closeAll();
    closeDatabase();
    logger.info('Database closed');
    process.exit(0);
  });
}

export default app;
