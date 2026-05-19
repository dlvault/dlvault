import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { getAllSettings, getSetting, setSetting } from '../../database/index';
import { isSensitiveKey } from '../../database/encryption';
import { getAllMovies, getMovieByTraktId, addMovie } from '../../database/services/movies';
import { getAllDownloads } from '../../database/services/downloads';
import db from '../../database/index';
import { traktService } from '../../services/trakt';
import { jdownloaderService } from '../../jdownloader/index';
import { jellyfinService } from '../../services/jellyfin';
import { plexService } from '../../services/plex';
import { plexLibraryService } from '../../services/plexLibrary';
import { startScheduler } from '../../services/scheduler';
import { startPostProcessor } from '../../services/postprocess';
import { restartBandwidthScheduler } from '../../services/bandwidth';
import { startTelegramBot, stopTelegramBot, testTelegramBot } from '../../services/telegram';
import { createBackup, listBackups, deleteBackup as deleteBackupFile, startBackupScheduler } from '../../services/backup';
import { logger } from '../../utils/logger';

const router = Router();

// Bearer-token guard for endpoints that expose decrypted secrets on the wire
// (/backup) or accept bulk settings overwrite (/restore). The global auth
// middleware in server.ts has a permissive browser-bypass, which would let
// any local browser hit /backup and walk away with all tokens. Force a real
// token here regardless of how the global middleware is configured.
function requireApiToken(req: Request, res: Response, next: NextFunction) {
  const apiToken = process.env.API_TOKEN;
  if (!apiToken) {
    res.status(503).json({
      error: 'API_TOKEN environment variable must be set to use backup/restore endpoints (avoids exposing decrypted secrets without authentication).',
    });
    return;
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required' });
    return;
  }
  const provided = Buffer.from(authHeader.slice(7), 'utf-8');
  const expected = Buffer.from(apiToken, 'utf-8');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// GET /api/settings
router.get('/', (_req: Request, res: Response) => {
  const settings = getAllSettings();
  // Mask every sensitive value before returning to the frontend. Use the
  // authoritative isSensitiveKey() — it covers core service credentials,
  // everything under `secret-store.*`, AND per-plugin `secret`-typed settings
  // registered at install time (those were previously returned in cleartext
  // because the old hardcoded list didn't know about them).
  const masked = { ...settings };
  for (const key of Object.keys(masked)) {
    if (isSensitiveKey(key) && masked[key]) {
      masked[key] = '••••••••';
    }
  }
  res.json(masked);
});

// Whitelist of allowed setting keys
const ALLOWED_SETTING_PREFIXES = [
  'trakt.', 'jdownloader.', 'plex.', 'jellyfin.', 'captcha.',
  'quality.', 'scheduler.', 'paths.', 'bandwidth.', 'telegram.', 'omdb.',
  'library.', 'postprocess.', 'watchlist.', 'backup.', 'rename.',
  'plugins.',
  'secret-store.',  // shared plugin secrets, declared via manifest.requiredSecrets
];

function isAllowedSettingKey(key: string): boolean {
  return ALLOWED_SETTING_PREFIXES.some(prefix => key.startsWith(prefix));
}

// POST /api/settings/validate-paths — check if configured paths exist and are writable
router.post('/validate-paths', (_req: Request, res: Response) => {
  const keys = ['paths.downloads', 'paths.movies', 'paths.series'] as const;
  const results: Record<string, { exists: boolean; writable: boolean; empty: boolean; error?: string }> = {};

  for (const key of keys) {
    const p = getSetting(key);
    if (!p) {
      results[key] = { exists: false, writable: false, empty: true, error: 'Nicht konfiguriert' };
      continue;
    }

    // Detect Windows-style paths (e.g. C:\, D:\, w:\) — these never work inside Docker
    if (/^[a-zA-Z]:[\\\/]/.test(p)) {
      results[key] = { exists: false, writable: false, empty: true, error: `Windows-Pfad "${p}" erkannt — hier den Container-Pfad verwenden (z.B. /downloads)` };
      continue;
    }

    const exists = fs.existsSync(p);
    if (!exists) {
      results[key] = { exists: false, writable: false, empty: true, error: `Pfad "${p}" existiert nicht — Volume-Mount fehlt?` };
      continue;
    }

    // Check writable by attempting to create+remove a temp file
    let writable = false;
    const testFile = path.join(p, `.dlvault-write-test-${Date.now()}`);
    try {
      fs.writeFileSync(testFile, '');
      fs.unlinkSync(testFile);
      writable = true;
    } catch {
      // not writable
    }

    // Check if directory is empty (potential sign of missing mount)
    let empty = false;
    try {
      const entries = fs.readdirSync(p);
      empty = entries.length === 0;
    } catch {
      empty = true;
    }

    let error: string | undefined;
    if (!writable) {
      error = `${p} ist nicht beschreibbar — Berechtigungen pruefen`;
    } else if (empty) {
      error = `${p} ist leer — Volume-Mount korrekt konfiguriert?`;
    }

    results[key] = { exists, writable, empty, error };
  }

  res.json(results);
});

// PUT /api/settings
router.put('/', (req: Request, res: Response) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }
  const updates: Record<string, string> = body;

  for (const [key, value] of Object.entries(updates)) {
    // Don't overwrite with masked values
    if (value === '••••••••') continue;
    if (typeof value !== 'string') {
      logger.warn(`Rejected non-string value for setting key: ${key}`);
      continue;
    }
    if (!isAllowedSettingKey(key)) {
      logger.warn(`Rejected unknown setting key: ${key}`);
      continue;
    }
    // Defense against stale UI state overwriting OAuth tokens / secrets: if
    // a sensitive key arrives with an empty value, skip it. The user has to
    // explicitly disconnect via the dedicated endpoints to clear a secret.
    if (isSensitiveKey(key) && value === '') continue;
    setSetting(key, value);
  }

  // Restart scheduler if interval changed
  if (updates['scheduler.interval_hours'] || updates['scheduler.enabled'] !== undefined) {
    startScheduler();
  }

  // Restart post-processor if paths changed
  if (updates['paths.downloads'] || updates['paths.movies'] || updates['paths.series']) {
    startPostProcessor();
  }

  // Restart bandwidth scheduler if bandwidth settings changed
  if (Object.keys(updates).some(k => k.startsWith('bandwidth.'))) {
    restartBandwidthScheduler();
  }

  // Restart Telegram bot if settings changed
  if (Object.keys(updates).some(k => k.startsWith('telegram.'))) {
    if (getSetting('telegram.enabled') === 'true' && getSetting('telegram.bot_token')) {
      startTelegramBot();
    } else {
      stopTelegramBot();
    }
  }

  // Restart backup scheduler if backup settings changed
  if (Object.keys(updates).some(k => k.startsWith('backup.'))) {
    startBackupScheduler();
  }

  // Push 2Captcha API key to JDownloader's solver when its shared secret is saved
  if (
    updates['secret-store.2captcha-api-key']
    && updates['secret-store.2captcha-api-key'] !== '••••••••'
  ) {
    jdownloaderService.configure2CaptchaSolver(updates['secret-store.2captcha-api-key']).catch(err => {
      logger.error('Failed to push 2Captcha key to JDownloader:', err.message);
    });
  }

  logger.info('Settings updated');
  res.json({ success: true });
});

// GET /api/settings/trakt/auth-url
router.get('/trakt/auth-url', (_req: Request, res: Response) => {
  const url = traktService.getAuthUrl();
  res.json({ url });
});

// POST /api/settings/trakt/exchange
router.post('/trakt/exchange', async (req: Request, res: Response) => {
  const { code } = req.body;
  if (!code) {
    res.status(400).json({ error: 'Code required' });
    return;
  }

  const success = await traktService.exchangeCode(code);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Token exchange failed' });
  }
});

// GET /api/settings/trakt/status
router.get('/trakt/status', (_req: Request, res: Response) => {
  res.json({
    configured: traktService.isConfigured(),
    authenticated: traktService.isAuthenticated(),
    username: getSetting('trakt.username'),
  });
});

// GET /api/settings/jdownloader/status
router.get('/jdownloader/status', async (_req: Request, res: Response) => {
  if (!jdownloaderService.isConfigured()) {
    res.json({ configured: false, connected: false, devices: [] });
    return;
  }

  const connected = await jdownloaderService.connect();
  let devices: { id: string; name: string; type: string }[] = [];
  if (connected) {
    devices = await jdownloaderService.listDevices();
  }

  res.json({
    configured: true,
    connected,
    devices: devices.map(d => ({ id: d.id, name: d.name, type: d.type })),
  });
});

// POST /api/settings/jdownloader/test
router.post('/jdownloader/test', async (_req: Request, res: Response) => {
  const connected = await jdownloaderService.connect();
  if (connected) {
    const devices = await jdownloaderService.listDevices();
    res.json({ success: true, devices });
  } else {
    res.status(400).json({ error: 'Connection failed' });
  }
});

// POST /api/settings/plex/auth-pin — request a new Plex PIN for OAuth
router.post('/plex/auth-pin', async (_req: Request, res: Response) => {
  try {
    const pinRes = await (await import('axios')).default.post('https://plex.tv/api/v2/pins', null, {
      headers: {
        'Accept': 'application/json',
        'X-Plex-Client-Identifier': 'dlvault-v1',
        'X-Plex-Product': 'Dlvault',
        'X-Plex-Version': '1.0',
        'strong': 'true',
      },
      params: { strong: true },
      timeout: 10000,
    });
    const { id, code } = pinRes.data;
    const authUrl = `https://app.plex.tv/auth#?clientID=dlvault-v1&code=${code}&context%5Bdevice%5D%5Bproduct%5D=Dlvault`;
    res.json({ pinId: id, code, authUrl });
  } catch (error: any) {
    logger.error('Plex PIN request failed:', error.message);
    res.status(500).json({ error: 'PIN request failed' });
  }
});

// POST /api/settings/plex/auth-check — poll PIN to get token after user authorized
router.post('/plex/auth-check', async (req: Request, res: Response) => {
  const { pinId } = req.body;
  if (!pinId) {
    res.status(400).json({ error: 'pinId required' });
    return;
  }

  try {
    const checkRes = await (await import('axios')).default.get(`https://plex.tv/api/v2/pins/${pinId}`, {
      headers: {
        'Accept': 'application/json',
        'X-Plex-Client-Identifier': 'dlvault-v1',
      },
      timeout: 10000,
    });

    const token = checkRes.data.authToken;
    if (token) {
      setSetting('plex.token', token);
      logger.info('Plex token received via OAuth');
      res.json({ success: true, token: '********' });
    } else {
      // User hasn't authorized yet
      res.json({ success: false, pending: true });
    }
  } catch (error: any) {
    logger.error('Plex PIN check failed:', error.message);
    res.status(500).json({ error: 'PIN check failed' });
  }
});

// GET /api/settings/plex/status
router.get('/plex/status', async (_req: Request, res: Response) => {
  if (!plexService.isConfigured()) {
    res.json({ connected: false, username: '', movieCount: 0 });
    return;
  }
  const result = await plexService.testConnection();
  res.json({
    connected: result.success,
    username: result.username || '',
    movieCount: result.movieCount || 0,
  });
});

// POST /api/settings/plex/test
router.post('/plex/test', async (_req: Request, res: Response) => {
  const result = await plexService.testConnection();
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json({ error: 'Connection failed' });
  }
});

// GET /api/settings/jellyfin/status
router.get('/jellyfin/status', async (_req: Request, res: Response) => {
  if (!jellyfinService.isConfigured()) {
    res.json({ connected: false, serverName: '', movieCount: 0 });
    return;
  }
  const result = await jellyfinService.testConnection();
  res.json({
    connected: result.success,
    serverName: result.serverName || '',
    movieCount: result.movieCount || 0,
  });
});

// POST /api/settings/jellyfin/test
router.post('/jellyfin/test', async (_req: Request, res: Response) => {
  const result = await jellyfinService.testConnection();
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json({ error: 'Connection failed' });
  }
});

// GET /api/settings/plex-library/status
router.get('/plex-library/status', async (_req: Request, res: Response) => {
  if (!plexLibraryService.isConfigured()) {
    res.json({ connected: false, serverName: '', movieCount: 0 });
    return;
  }
  const result = await plexLibraryService.testConnection();
  res.json({
    connected: result.success,
    serverName: result.serverName || '',
    movieCount: result.movieCount || 0,
  });
});

// POST /api/settings/plex-library/test
router.post('/plex-library/test', async (_req: Request, res: Response) => {
  const result = await plexLibraryService.testConnection();
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json({ error: 'Connection failed' });
  }
});

// GET /api/settings/backup — export all settings + data as JSON
router.get('/backup', requireApiToken, (_req: Request, res: Response) => {
  try {
    const settings = getAllSettings();
    const movies = getAllMovies();
    const downloads = getAllDownloads();
    const logCount = (db.prepare('SELECT COUNT(*) as count FROM activity_log').get() as { count: number }).count;

    // Remove encryption-related internal keys but include all user settings (decrypted)
    const exportSettings = { ...settings };

    const date = new Date().toISOString().slice(0, 10);
    const backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      _warning: 'This backup contains decrypted API keys and tokens. Store securely.',
      settings: exportSettings,
      movies,
      downloads,
      activityLogCount: logCount,
    };

    res.setHeader('Content-Disposition', `attachment; filename=dlvault-backup-${date}.json`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Backup export failed: ${message}`);
    res.status(500).json({ error: 'Backup export failed' });
  }
});

// POST /api/settings/restore — import from JSON backup
router.post('/restore', requireApiToken, (req: Request, res: Response) => {
  try {
    const backup = req.body;

    // Validate structure
    if (!backup || typeof backup !== 'object' || !backup.version || !backup.settings) {
      res.status(400).json({ error: 'Invalid backup format: missing version or settings' });
      return;
    }

    if (typeof backup.settings !== 'object' || Array.isArray(backup.settings)) {
      res.status(400).json({ error: 'Invalid backup format: settings must be an object' });
      return;
    }

    // Restore settings (setSetting will re-encrypt sensitive values)
    let settingsRestored = 0;
    for (const [key, value] of Object.entries(backup.settings)) {
      if (typeof key === 'string' && typeof value === 'string' && value.length <= 4096 && isAllowedSettingKey(key)) {
        setSetting(key, value);
        settingsRestored++;
      }
    }

    // Optionally restore movies (merge: skip existing trakt_ids)
    let moviesRestored = 0;
    if (Array.isArray(backup.movies)) {
      for (const movie of backup.movies) {
        if (!movie || typeof movie !== 'object' || !movie.trakt_id || !movie.title) continue;

        // Skip if already exists
        const existing = getMovieByTraktId(movie.trakt_id);
        if (existing) continue;

        addMovie({
          trakt_id: movie.trakt_id,
          imdb_id: movie.imdb_id || null,
          tmdb_id: movie.tmdb_id || null,
          title: movie.title,
          year: movie.year || null,
          slug: movie.slug || null,
          media_type: movie.media_type || 'movie',
          status: movie.status || 'pending',
          desired_quality: movie.desired_quality || '1080p',
        });
        moviesRestored++;
      }
    }

    logger.info(`Backup restored: ${settingsRestored} settings, ${moviesRestored} movies`);
    res.json({ settingsRestored, moviesRestored });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Backup restore failed: ${message}`);
    res.status(500).json({ error: 'Backup restore failed' });
  }
});

// GET /api/settings/telegram/status
router.get('/telegram/status', async (_req: Request, res: Response) => {
  const enabled = getSetting('telegram.enabled') === 'true';
  const configured = !!getSetting('telegram.bot_token');
  const unrestricted = enabled && configured && !getSetting('telegram.allowed_chat_ids');
  res.json({ enabled, configured, unrestricted });
});

// POST /api/settings/telegram/test
router.post('/telegram/test', async (_req: Request, res: Response) => {
  const result = await testTelegramBot();
  if (result.success) {
    res.json({ success: true, botName: result.botName });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// POST /api/settings/omdb/test
router.post('/omdb/test', async (_req: Request, res: Response) => {
  const { omdbService } = await import('../../services/omdb');
  const result = await omdbService.testConnection();
  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// GET /api/settings/backup-schedule
router.get('/backup-schedule', (_req: Request, res: Response) => {
  res.json({
    enabled: getSetting('backup.enabled'),
    interval_hours: getSetting('backup.interval_hours'),
    max_backups: getSetting('backup.max_backups'),
  });
});

// PUT /api/settings/backup-schedule
router.put('/backup-schedule', (req: Request, res: Response) => {
  const { enabled, interval_hours, max_backups } = req.body;
  if (enabled !== undefined) setSetting('backup.enabled', enabled);
  if (interval_hours !== undefined) setSetting('backup.interval_hours', interval_hours);
  if (max_backups !== undefined) setSetting('backup.max_backups', max_backups);
  startBackupScheduler();
  res.json({ success: true });
});

// POST /api/settings/backup-now — trigger manual backup
router.post('/backup-now', (_req: Request, res: Response) => {
  const result = createBackup();
  if (result) {
    res.json(result);
  } else {
    res.status(500).json({ error: 'Backup fehlgeschlagen' });
  }
});

// GET /api/settings/backups — list all backups
router.get('/backups', (_req: Request, res: Response) => {
  res.json(listBackups());
});

// DELETE /api/settings/backups/:filename
router.delete('/backups/:filename', (req: Request, res: Response) => {
  const removed = deleteBackupFile(req.params.filename as string);
  if (removed) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Backup nicht gefunden' });
  }
});

export default router;
