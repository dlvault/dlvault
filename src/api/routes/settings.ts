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
import { seerrService } from '../../services/seerr';
import { tmdbService } from '../../services/tmdb';
import { getArrApiKey } from './arr';
import { getWebhookToken, WEBHOOK_TYPES } from './seerrWebhook';
import { plexLibraryService } from '../../services/plexLibrary';
import { startScheduler, getJdMonitorState, notifyJdUpdateTriggered } from '../../services/scheduler';
import { startPostProcessor } from '../../services/postprocess';
import { restartBandwidthScheduler } from '../../services/bandwidth';
import { startTelegramBot, stopTelegramBot, testTelegramBot } from '../../services/telegram';
import { createBackup, listBackups, deleteBackup as deleteBackupFile, startBackupScheduler, backupDir, resolveBackupPath } from '../../services/backup';
import { stageRestore } from '../../services/restore';
import { addLogEntry } from '../../database/services/activityLog';
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
  'plugins.', 'kids.', 'integrity.', 'seerr.', 'arr.', 'tmdb.',
  'secret-store.',  // shared plugin secrets, declared via manifest.requiredSecrets
  // Override for the bundled challenge solver's URL. createPluginContext reads
  // `challenge_solver.url` and documents it as user-configurable, but the prefix
  // was missing here — so PUT /api/settings logged "Rejected unknown setting key"
  // and dropped it, pinning the solver to the in-image instance forever.
  'challenge_solver.',
];

function isAllowedSettingKey(key: string): boolean {
  return ALLOWED_SETTING_PREFIXES.some(prefix => key.startsWith(prefix));
}

// POST /api/settings/validate-paths — check if configured paths exist and are writable
router.post('/validate-paths', (_req: Request, res: Response) => {
  const requiredKeys = ['paths.downloads', 'paths.movies', 'paths.series'] as const;
  // Optional kids libraries: only validated when actually configured, so an
  // unused separation never surfaces as a "missing mount" in the setup script.
  const optionalKeys = ['paths.kids_movies', 'paths.kids_series'] as const;
  const results: Record<string, { exists: boolean; writable: boolean; empty: boolean; error?: string }> = {};

  const validateKey = (key: string, optional: boolean): void => {
    const p = getSetting(key);
    if (!p) {
      if (optional) return; // skip empty optional keys entirely
      results[key] = { exists: false, writable: false, empty: true, error: 'Nicht konfiguriert' };
      return;
    }

    // Detect Windows-style paths (e.g. C:\, D:\, w:\) — these never work inside Docker
    if (/^[a-zA-Z]:[\\\/]/.test(p)) {
      results[key] = { exists: false, writable: false, empty: true, error: `Windows-Pfad "${p}" erkannt — hier den Container-Pfad verwenden (z.B. /downloads)` };
      return;
    }

    const exists = fs.existsSync(p);
    if (!exists) {
      results[key] = { exists: false, writable: false, empty: true, error: `Pfad "${p}" existiert nicht — Volume-Mount fehlt?` };
      return;
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
  };

  for (const key of requiredKeys) validateKey(key, false);
  for (const key of optionalKeys) validateKey(key, true);

  res.json(results);
});

/**
 * DELETE /api/settings/secret/:key — remove a stored secret.
 *
 * PUT /api/settings deliberately ignores an empty value for a sensitive key, so
 * that stale UI state can't silently wipe an OAuth token. That left no way at
 * all to REMOVE a secret through the UI: clearing the field was a no-op and the
 * only workaround was storing a junk value. This is the explicit path.
 */
router.delete('/secret/:key', (req: Request, res: Response) => {
  const key = String(req.params.key);
  if (!isAllowedSettingKey(key)) {
    res.status(400).json({ error: 'Unknown setting key' });
    return;
  }
  if (!isSensitiveKey(key)) {
    res.status(400).json({ error: 'Not a secret — use PUT /api/settings' });
    return;
  }
  setSetting(key, '');
  logger.info(`Secret cleared: ${key}`);
  res.json({ ok: true });
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

  // Restart scheduler if any scheduler setting changed. Prefix check like the
  // bandwidth/telegram/backup triggers below: the frontend now sends a DELTA
  // (changed keys only) — the old interval_hours/enabled check only worked
  // because the former full-object save always contained those keys.
  if (Object.keys(updates).some(k => k.startsWith('scheduler.'))) {
    startScheduler();
  }

  // Restart post-processor if paths changed
  if (
    updates['paths.downloads'] ||
    updates['paths.movies'] ||
    updates['paths.series'] ||
    updates['paths.kids_movies'] ||
    updates['paths.kids_series']
  ) {
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

/**
 * Credentials that define "this provider is connected".
 *
 * Clearing them is what actually disconnects a provider — switching
 * `watchlist.provider` only decides which one *runs*, and used to leave a dead
 * Trakt app's tokens sitting in the database forever.
 */
const PROVIDER_CREDENTIALS: Record<string, string[]> = {
  trakt: ['trakt.client_id', 'trakt.client_secret', 'trakt.access_token', 'trakt.refresh_token', 'trakt.username'],
  plex: ['plex.token'],
  seerr: ['seerr.url', 'seerr.api_key'],
};

/** Whether a provider still has everything it needs to run. */
function providerConfigured(name: string): boolean {
  if (name === 'trakt') return traktService.isConfigured();
  if (name === 'plex') return plexService.isConfigured();
  if (name === 'seerr') return seerrService.isConfigured();
  return false;
}

/**
 * POST /api/settings/watchlist/:provider/disconnect
 *
 * Wipes a provider's stored credentials. The in-memory auth-failure latches key
 * on the credential itself, so clearing it also releases the block — no restart.
 *
 * If the disconnected provider was the active one, the selection moves to the
 * remaining configured provider when there is exactly one. Leaving it pointing
 * at an empty provider would mean nothing syncs at all, silently — the failure
 * mode this whole area was just hardened against.
 */
router.post('/watchlist/:provider/disconnect', (req: Request, res: Response) => {
  const provider = String(req.params.provider);
  const keys = PROVIDER_CREDENTIALS[provider];
  if (!keys) {
    res.status(400).json({ error: 'Unknown provider' });
    return;
  }

  for (const key of keys) setSetting(key, '');

  const active = getSetting('watchlist.provider') || 'trakt';
  let switchedTo: string | null = null;

  const stillActive = active === provider
    || (active === 'both' && (provider === 'trakt' || provider === 'plex'));

  if (stillActive) {
    const remaining = Object.keys(PROVIDER_CREDENTIALS).filter(p => p !== provider && providerConfigured(p));
    if (remaining.length === 1) {
      setSetting('watchlist.provider', remaining[0]);
      switchedTo = remaining[0];
    } else if (active === 'both') {
      // 'both' means Trakt+Plex; with one of them gone the other stands alone.
      const other = provider === 'trakt' ? 'plex' : 'trakt';
      setSetting('watchlist.provider', other);
      switchedTo = other;
    }
  }

  logger.info(`Watchlist provider disconnected: ${provider}${switchedTo ? ` (active provider is now ${switchedTo})` : ''}`);
  addLogEntry(null, 'provider_disconnected', `${provider} getrennt`);
  res.json({ ok: true, switchedTo });
});

// GET /api/settings/trakt/status
router.get('/trakt/status', (_req: Request, res: Response) => {
  res.json({
    configured: traktService.isConfigured(),
    authenticated: traktService.isAuthenticated(),
    username: getSetting('trakt.username'),
  });
});

/**
 * Resolve which JD device the configured name will actually drive — mirrors the
 * tolerant (exact-then-case-insensitive) match in JDownloaderService.getDeviceId.
 * Surfaced to the UI so "Verbindung testen" can warn when a typed name matches
 * nothing (e.g. "@Windows" vs the real "@windows"): the button used to show green
 * "connected, 2 devices" even when downloads would silently never reach JD.
 *
 * `selectedDevice` = the device that will be used (null = configured-but-not-found,
 * the failure case). `deviceNameConfigured` = null when the field is empty.
 */
function jdDeviceSelection(devices: { name: string }[]): {
  deviceNameConfigured: string | null;
  selectedDevice: string | null;
} {
  const name = (getSetting('jdownloader.device_name') || '').trim();
  if (!name) {
    return { deviceNameConfigured: null, selectedDevice: devices[0]?.name ?? null };
  }
  const match = devices.find(d => d.name === name)
    || devices.find(d => (d.name || '').trim().toLowerCase() === name.toLowerCase());
  return { deviceNameConfigured: name, selectedDevice: match?.name ?? null };
}

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
    updateAvailable: getJdMonitorState().updateAvailable,
    devices: devices.map(d => ({ id: d.id, name: d.name, type: d.type })),
    ...jdDeviceSelection(devices),
  });
});

// POST /api/settings/jdownloader/update — restart JD and install its self-update.
// JD goes offline for a minute or two while it restarts; the JD monitor's offline
// alert + post-recovery auto-resume cover that window.
router.post('/jdownloader/update', async (_req: Request, res: Response) => {
  if (!jdownloaderService.isConfigured()) {
    res.status(400).json({ error: 'JDownloader ist nicht konfiguriert' });
    return;
  }
  const ok = await jdownloaderService.restartAndUpdate();
  if (ok) {
    // Clear + suppress the cached update badge so it doesn't linger on JD's stale
    // flag while it restarts and re-evaluates against the new version.
    notifyJdUpdateTriggered();
    logger.info('JDownloader self-update triggered via dashboard');
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Update konnte nicht gestartet werden (JDownloader nicht erreichbar?)' });
  }
});

// POST /api/settings/jdownloader/test
router.post('/jdownloader/test', async (_req: Request, res: Response) => {
  const connected = await jdownloaderService.connect();
  if (connected) {
    const devices = await jdownloaderService.listDevices();
    res.json({ success: true, devices, ...jdDeviceSelection(devices) });
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

// POST /api/settings/tmdb/test
router.post('/tmdb/test', async (_req: Request, res: Response) => {
  const result = await tmdbService.testConnection();
  if (result.ok) {
    res.json(result);
  } else {
    res.status(400).json({ error: result.error || 'Connection failed' });
  }
});

// GET /api/settings/seerr/status
router.get('/seerr/status', async (_req: Request, res: Response) => {
  if (!seerrService.isConfigured()) {
    res.json({ connected: false, version: '' });
    return;
  }
  const result = await seerrService.testConnection();
  res.json({
    connected: result.ok,
    version: result.version || '',
    error: result.error || '',
    // Surface a latched credential failure so the UI can explain a silent stop
    // instead of just showing "not connected".
    authFailure: seerrService.getAuthFailure(),
  });
});

// POST /api/settings/seerr/test
router.post('/seerr/test', async (_req: Request, res: Response) => {
  const result = await seerrService.testConnection();
  if (result.ok) {
    res.json(result);
  } else {
    res.status(400).json({ error: result.error || 'Connection failed' });
  }
});

/**
 * POST /api/settings/seerr/register
 *
 * Turns on the Radarr/Sonarr-compatible endpoint and enters dlvault into
 * Seerr as both servers. `baseUrl` is how Seerr reaches dlvault — it
 * cannot be derived reliably from the request, because dlvault commonly sits
 * behind a container bridge where the address the browser used is meaningless.
 */
router.post('/seerr/register', async (req: Request, res: Response) => {
  const baseUrl = String(req.body?.baseUrl || '').trim();
  if (!baseUrl) {
    res.status(400).json({ error: 'baseUrl fehlt' });
    return;
  }
  setSetting('arr.enabled', 'true');
  const apiKey = getArrApiKey();
  const result = await seerrService.registerAsArrServer(baseUrl, apiKey);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  // Same call sets up the push notification: without it dlvault waits out the
  // two-minute poll before acting on an approval. A failure here is not fatal —
  // the pull path still works — so report it rather than failing the whole call.
  setSetting('seerr.webhook_enabled', 'true');
  const hook = await seerrService.registerWebhook(baseUrl, getWebhookToken(), WEBHOOK_TYPES);
  if (!hook.ok) setSetting('seerr.webhook_enabled', 'false');

  res.json({ ok: true, webhook: hook.ok, webhookError: hook.error || null });
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
    path: getSetting('backup.path'),
    // Effective target, so the UI can show where backups actually land when the
    // path is left empty.
    effectivePath: backupDir(),
    include_key: getSetting('backup.include_key'),
  });
});

// PUT /api/settings/backup-schedule
router.put('/backup-schedule', (req: Request, res: Response) => {
  const { enabled, interval_hours, max_backups, path: backupPath, include_key } = req.body;

  // Validate the target BEFORE storing it: a path that cannot be written is a
  // backup setting that silently produces no backups, which is worse than none.
  if (backupPath !== undefined) {
    const trimmed = String(backupPath).trim();
    if (trimmed) {
      const resolved = path.resolve(trimmed);
      try {
        fs.mkdirSync(resolved, { recursive: true });
        const probe = path.join(resolved, `.dlvault-write-test-${process.pid}`);
        fs.writeFileSync(probe, 'x');
        fs.unlinkSync(probe);
      } catch (err: any) {
        res.status(400).json({
          error: `Backup-Pfad "${resolved}" ist nicht beschreibbar: ${err.message}. `
            + 'Bei Docker muss der Pfad ein gemountetes Volume sein.',
        });
        return;
      }
    }
    setSetting('backup.path', trimmed);
  }

  if (enabled !== undefined) setSetting('backup.enabled', enabled);
  if (interval_hours !== undefined) setSetting('backup.interval_hours', interval_hours);
  if (max_backups !== undefined) setSetting('backup.max_backups', max_backups);
  if (include_key !== undefined) setSetting('backup.include_key', include_key);
  startBackupScheduler();
  res.json({ success: true, effectivePath: backupDir() });
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

/**
 * POST /api/settings/backups/:filename/restore
 *
 * Stages a restore and asks the process to exit. The swap itself happens on the
 * next boot, before the database is opened — see services/restore.ts for why it
 * cannot be done in-process.
 */
router.post('/backups/:filename/restore', (req: Request, res: Response) => {
  const filename = String(req.params.filename);
  const full = resolveBackupPath(filename);
  if (!full) {
    res.status(404).json({ error: 'Backup nicht gefunden' });
    return;
  }
  if (filename.endsWith('.db')) {
    res.status(400).json({
      error: 'Dieses Backup stammt aus dem alten Format (nur Datenbank, ohne Schlüssel und Plugins) '
        + 'und kann nicht automatisch wiederhergestellt werden. Manuell: Container stoppen, die Datei '
        + 'als data/dlvault.db einsetzen, data/dlvault.db-wal und -shm löschen, Container starten.',
    });
    return;
  }

  try {
    const staged = stageRestore(fs.readFileSync(full));
    addLogEntry(null, 'backup_restore', `Wiederherstellung vorbereitet aus ${filename}`);
    logger.warn(`Restore staged from ${filename} — exiting so it is applied on the next start`);
    res.json({
      success: true,
      restarting: true,
      manifest: staged.manifest,
      restoredKey: staged.restoredKey,
      pluginCount: staged.pluginCount,
    });
    // Give the response time to flush, then exit. The container's restart policy
    // brings the process back, and the staged files are applied during boot.
    setTimeout(() => process.exit(0), 750);
  } catch (err: any) {
    logger.error(`Restore staging failed for ${filename}: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
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
