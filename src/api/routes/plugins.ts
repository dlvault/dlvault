import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pluginRegistry } from '../../plugins/registry';
import type { FetchProgress } from '../../plugins/types';
import {
  installFromUrl,
  installFromBuffer,
  acceptPendingPlugin,
  uninstallPlugin,
  previewPlugin,
  InstallError,
} from '../../plugins/install';
import { loadPluginsFromDirectory, defaultPluginsDir } from '../../plugins/loader';
import { setSetting, getSetting } from '../../database/index';
import { addLogEntry } from '../../database/services/activityLog';
import { createFetchJob, updateFetchJob, finishFetchJob, listFetchJobs } from '../../services/fetchJobs';
import { invalidateMusicLibraryCache } from '../../services/musicLibrary';
import { withPluginTimeout, PLUGIN_TIMEOUTS } from '../../plugins/timeout';
import { logger } from '../../utils/logger';

const router = Router();

// Installing a plugin places code that runs inside the host process — the
// install/upload/accept routes are remote code execution by design. When the
// operator enabled token auth (API_TOKEN set), enforce it here outright —
// matching /update/start and /backup: the global middleware's browser-bypass
// must not apply to routes that accept executable code. Without API_TOKEN
// (the trusted-LAN default) the disclaimer flow stays the only gate, so the
// browser install UX keeps working without any frontend token plumbing.
function requireTokenWhenConfigured(req: Request, res: Response, next: NextFunction): void {
  const apiToken = process.env.API_TOKEN;
  if (!apiToken) {
    next();
    return;
  }
  const authHeader = req.headers.authorization;
  const provided = authHeader?.startsWith('Bearer ') ? Buffer.from(authHeader.slice(7), 'utf-8') : null;
  const expected = Buffer.from(apiToken, 'utf-8');
  if (!provided || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    res.status(401).json({ error: 'API token required: send Authorization: Bearer <API_TOKEN> (token auth is enabled on this server)' });
    return;
  }
  next();
}

/**
 * Confine a self-downloading plugin's destination to the configured downloads
 * root. `destDir` arrives in the request body and is handed to the plugin as the
 * directory to write into — unchecked, that is an arbitrary-write primitive
 * against anything the container can reach (`/app/data`, the library roots, …).
 */
function resolveFetchDestination(requested: unknown): string {
  const root = path.resolve(getSetting('paths.downloads') || '/downloads');
  if (requested === undefined || requested === null || requested === '') {
    return path.join(root, 'music');
  }
  if (typeof requested !== 'string') {
    throw new Error('destDir must be a string');
  }
  // Relative values are resolved against the root; absolute ones must already
  // live inside it. `path.resolve` collapses any `..` before the check.
  const candidate = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error(`destDir must stay inside the configured downloads directory (${root})`);
  }
  return candidate;
}

/** Shared error mapper. */
function sendInstallError(res: Response, err: unknown): void {
  if (err instanceof InstallError) {
    res.status(err.status).json({ error: err.message });
  } else {
    const message = (err as any)?.message || String(err);
    logger.error(`Plugin route error: ${message}`);
    res.status(500).json({ error: message });
  }
}

/**
 * GET /api/plugins
 * Returns the current registry contents + any pending plugins waiting for
 * disclaimer acceptance (drop-file installs).
 */
router.get('/', (_req: Request, res: Response) => {
  const registered = pluginRegistry.getAll().map(p => {
    const m = pluginRegistry.getManifest(p.id);
    return {
      id: p.id,
      name: p.name,
      mediaTypes: p.mediaTypes,
      cspDomains: p.cspDomains || [],
      bundled: pluginRegistry.isBundled(p.id),
      enabled: pluginRegistry.isEnabled(p.id),
      // Manifest fields (undefined for plugins registered without a manifest —
      // e.g. legacy private plugins that haven't migrated yet).
      version: m?.version,
      description: m?.description,
      author: m?.author,
      homepage: m?.homepage,
      permissions: m?.permissions || [],
      settingsSchema: m?.settingsSchema || [],
      requiredSecrets: m?.requiredSecrets || [],
    };
  });

  // Re-scan the plugins dir for pending entries — files that are physically
  // present but haven't been registered (no disclaimer / hash mismatch).
  let pending: unknown[] = [];
  try {
    const result = loadPluginsFromDirectory(defaultPluginsDir());
    pending = result.pending.map(p => ({
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      mediaTypes: p.manifest.mediaTypes,
      description: p.manifest.description,
      author: p.manifest.author,
      homepage: p.manifest.homepage,
      permissions: p.manifest.permissions || [],
      cspDomains: p.manifest.cspDomains || [],
      fileSha256: p.fileSha256,
      reason: p.reason,
    }));
  } catch (err: any) {
    logger.debug(`Pending scan failed: ${err.message}`);
  }

  res.json({ registered, pending });
});

/**
 * GET /api/plugins/secrets
 *
 * Aggregated shared-secret schema across all installed plugins. Secrets are
 * stored under `secret-store.<key>` in the settings table and shared across
 * plugins by key — if two installed plugins both declare a `2captcha-api-key`
 * secret, this endpoint reports the union with both plugins listed as
 * requesters. The user fills in the value once.
 *
 * Response:
 *   { secrets: [{
 *       key: 'some-service-api-key',
 *       label: 'Some Service API key',
 *       description?: '...',
 *       requestedBy: [{ id: 'plugin-a', name: 'Plugin A' }, ...],
 *       configured: true|false,   // is a value currently saved
 *   }] }
 */
router.get('/secrets', (_req: Request, res: Response) => {
  const SECRET_STORE_PREFIX = 'secret-store.';

  type Aggregate = {
    key: string;
    label: string;
    description?: string;
    requestedBy: { id: string; name: string }[];
    configured: boolean;
  };
  const byKey = new Map<string, Aggregate>();

  for (const plugin of pluginRegistry.getAll()) {
    const m = pluginRegistry.getManifest(plugin.id);
    if (!m?.requiredSecrets) continue;
    for (const req of m.requiredSecrets) {
      const existing = byKey.get(req.key);
      if (existing) {
        existing.requestedBy.push({ id: plugin.id, name: plugin.name });
        // First plugin's label/description wins; later plugins are silent
        // on label conflict (the user only sees one row anyway).
      } else {
        byKey.set(req.key, {
          key: req.key,
          label: req.label,
          description: req.description,
          requestedBy: [{ id: plugin.id, name: plugin.name }],
          configured: !!getSetting(`${SECRET_STORE_PREFIX}${req.key}`),
        });
      }
    }
  }

  res.json({ secrets: Array.from(byKey.values()) });
});

/**
 * POST /api/plugins/preview
 * Body: { url?: string, contentBase64?: string }
 *
 * Validate a plugin candidate WITHOUT installing or registering it. Used by
 * the install dialog to render the manifest preview before the user accepts
 * the disclaimer.
 */
router.post('/preview', requireTokenWhenConfigured, async (req: Request, res: Response) => {
  const { url, contentBase64 } = req.body as { url?: string; contentBase64?: string };
  if (!url && !contentBase64) {
    res.status(400).json({ error: 'preview requires url or contentBase64' });
    return;
  }
  try {
    const preview = await previewPlugin({ url, contentBase64 });
    res.json({ manifest: preview.manifest, fileSha256: preview.fileSha256 });
  } catch (err) {
    sendInstallError(res, err);
  }
});

/**
 * POST /api/plugins/install
 * Body: { url: string, disclaimerAccepted: boolean }
 *
 * Downloads a .dlvault.js from a public HTTPS URL, validates, saves, and
 * registers. The disclaimer flag is required — the API rejects without it.
 */
router.post('/install', requireTokenWhenConfigured, async (req: Request, res: Response) => {
  const { url, disclaimerAccepted } = req.body as { url?: string; disclaimerAccepted?: boolean };
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'url is required' });
    return;
  }
  try {
    const result = await installFromUrl(url, { disclaimerAccepted: !!disclaimerAccepted });
    res.json({
      success: true,
      manifest: result.manifest,
      sourceUrl: result.sourceUrl,
      fileSha256: result.fileSha256,
    });
  } catch (err) {
    sendInstallError(res, err);
  }
});

/**
 * POST /api/plugins/upload
 * Body: { filename: string, contentBase64: string, disclaimerAccepted: boolean }
 *
 * Accept a plugin uploaded directly from the user's browser. Content is
 * base64-encoded in the JSON body so no multipart middleware is needed.
 */
router.post('/upload', requireTokenWhenConfigured, async (req: Request, res: Response) => {
  const { filename, contentBase64, disclaimerAccepted } = req.body as {
    filename?: string;
    contentBase64?: string;
    disclaimerAccepted?: boolean;
  };
  if (!filename || typeof filename !== 'string') {
    res.status(400).json({ error: 'filename is required' });
    return;
  }
  if (!contentBase64 || typeof contentBase64 !== 'string') {
    res.status(400).json({ error: 'contentBase64 is required' });
    return;
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(contentBase64, 'base64');
  } catch {
    res.status(400).json({ error: 'contentBase64 is not valid base64' });
    return;
  }
  try {
    const result = await installFromBuffer(filename, buf, { disclaimerAccepted: !!disclaimerAccepted });
    res.json({
      success: true,
      manifest: result.manifest,
      fileSha256: result.fileSha256,
    });
  } catch (err) {
    sendInstallError(res, err);
  }
});

/**
 * POST /api/plugins/:id/accept
 * Body: { disclaimerAccepted: boolean }
 *
 * Accept a plugin that's already in data/plugins/ (drop-file UX). The user
 * sees it in the pending list and clicks "Accept" after reviewing.
 */
router.post('/:id/accept', requireTokenWhenConfigured, async (req: Request, res: Response) => {
  const { disclaimerAccepted } = req.body as { disclaimerAccepted?: boolean };
  try {
    const result = await acceptPendingPlugin(String(req.params.id), { disclaimerAccepted: !!disclaimerAccepted });
    res.json({
      success: true,
      manifest: result.manifest,
      fileSha256: result.fileSha256,
    });
  } catch (err) {
    sendInstallError(res, err);
  }
});

/**
 * POST /api/plugins/:id/enable  and  /:id/disable
 * Toggle the per-plugin enabled flag (settings key plugins.<id>.enabled).
 */
router.post('/:id/enable', (req: Request, res: Response) => {
  if (!pluginRegistry.getById(String(req.params.id))) {
    res.status(404).json({ error: 'plugin not found' });
    return;
  }
  setSetting(`plugins.${String(req.params.id)}.enabled`, 'true');
  res.json({ success: true, enabled: true });
});

router.post('/:id/disable', (req: Request, res: Response) => {
  if (!pluginRegistry.getById(String(req.params.id))) {
    res.status(404).json({ error: 'plugin not found' });
    return;
  }
  setSetting(`plugins.${String(req.params.id)}.enabled`, 'false');
  res.json({ success: true, enabled: false });
});

/**
 * GET /api/plugins/fetch-jobs — recent self-download jobs (live status).
 * Backs the UI's "active downloads" list so it survives page reloads. Static
 * path, declared before /:id/* so it isn't shadowed.
 */
router.get('/fetch-jobs', (req: Request, res: Response) => {
  const pluginId = typeof req.query.pluginId === 'string' ? req.query.pluginId : undefined;
  res.json({ jobs: listFetchJobs(pluginId) });
});

/**
 * DELETE /api/plugins/fetch-jobs/:jobId — give up on a self-download job.
 *
 * The transfer itself runs inside the plugin and has no abort handle in the
 * plugin contract, so this marks the job failed and stops it occupying the UI.
 * Without it a wedged job sat in 'processing' forever: the dashboard reads any
 * active job as "downloading" and the only way out was a container restart.
 */
router.delete('/fetch-jobs/:jobId', requireTokenWhenConfigured, (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const job = listFetchJobs().find(j => j.id === jobId);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  if (job.status !== 'processing') {
    res.json({ ok: true, alreadyFinished: true });
    return;
  }
  finishFetchJob(jobId, { ok: false, error: 'Abgebrochen' });
  addLogEntry(null, 'download_cancelled', `Abgebrochen: ${job.title}`);
  logger.info(`[plugin:${job.pluginId}] fetch job ${jobId} cancelled by user`);
  res.json({ ok: true });
});

/**
 * GET /api/plugins/:id/search?q=...
 * Search candidates from a plugin's optional searchTitles method — used by
 * media UIs to render pickable results (title + cover). Neutral: works for any
 * plugin that implements searchTitles.
 */
router.get('/:id/search', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const plugin = pluginRegistry.getById(id);
  if (!plugin) {
    res.status(404).json({ error: 'plugin not found' });
    return;
  }
  if (typeof plugin.searchTitles !== 'function') {
    res.status(400).json({ error: `plugin "${id}" has no searchTitles` });
    return;
  }
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.status(400).json({ error: 'query param "q" is required' });
    return;
  }
  const limit = Math.min(Number(req.query.limit) || 24, 50);
  try {
    const results = await withPluginTimeout(
      'searchTitles',
      PLUGIN_TIMEOUTS.searchTitles,
      plugin.searchTitles(q, { mediaType: plugin.mediaTypes[0], limit }),
    );
    res.json({ query: q, results });
  } catch (err) {
    sendInstallError(res, err);
  }
});

/**
 * POST /api/plugins/:id/fetch
 * Drive a SELF-DOWNLOADING plugin — one that implements `fetchRelease` and owns
 * its whole download pipeline (no JDownloader handoff). Neutral: the host knows
 * nothing about the source; it hands the plugin a release + destination and the
 * plugin fetches it. Body:
 *   { url, title?, destDir?, background? }  → download this specific pick, or
 *   { query, destDir?, background? }        → find + download the top result.
 * With `background: true` the route responds immediately (202) and the download
 * runs detached; otherwise it awaits completion.
 */
router.post('/:id/fetch', requireTokenWhenConfigured, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const plugin = pluginRegistry.getById(id);
  if (!plugin) {
    res.status(404).json({ error: 'plugin not found' });
    return;
  }
  if (typeof plugin.fetchRelease !== 'function') {
    res.status(400).json({ error: `plugin "${id}" is not self-downloading (no fetchRelease)` });
    return;
  }

  const { url, title, query, destDir: bodyDest, background } = (req.body ?? {}) as {
    url?: string; title?: string; query?: string; destDir?: string; background?: boolean;
  };

  // The plugin writes files into this directory, so it cannot come from the
  // request body unchecked — that let any caller point a download at /app/data
  // or anywhere else the container can write. Confine it to the configured
  // downloads root.
  let destDir: string;
  try {
    destDir = resolveFetchDestination(bodyDest);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
    return;
  }

  const fetchRelease = plugin.fetchRelease.bind(plugin);

  try {
    // Resolve which release to fetch: a specific pick (url) or the top hit (query).
    let release;
    if (url && typeof url === 'string') {
      release = {
        title: String(title || url),
        quality: '', audio: 'unknown', language: 'unknown', size: '',
        releaseType: 'rip' as const, isDolbyVision: false,
        season: null, episode: null, isSeasonPack: false,
        links: [{ hoster: id, url }],
      };
    } else if (query && String(query).trim()) {
      // Wrapped like every other plugin call site — an unwrapped one holds the
      // HTTP request open until the 4-minute server timeout and piles up sockets.
      const { releases } = await withPluginTimeout(
        'findReleases',
        PLUGIN_TIMEOUTS.findReleases,
        plugin.findReleases({ title: String(query).trim(), mediaType: plugin.mediaTypes[0] }),
      );
      if (releases.length === 0) {
        res.status(404).json({ error: 'no releases found for query' });
        return;
      }
      release = releases[0];
    } else {
      res.status(400).json({ error: 'body.url or body.query is required' });
      return;
    }

    // One in-flight job per release. Without this, clicking "load album" twice
    // (or once before and once after a page reload — the UI's "added" marker is
    // component-local) started two transfers writing the same file paths
    // concurrently, interleaving bytes into a corrupt file that both jobs then
    // reported as successful.
    const releaseKey = release.links[0]?.url || release.title;
    const alreadyRunning = listFetchJobs(id).find(
      j => j.status === 'processing' && j.title === release.title,
    );
    if (alreadyRunning) {
      res.status(409).json({
        error: 'Dieser Download läuft bereits',
        jobId: alreadyRunning.id,
        release: release.title,
      });
      logger.debug(`[plugin:${id}] duplicate fetch rejected for "${releaseKey}" (job ${alreadyRunning.id} still running)`);
      return;
    }

    // Track the job (live "active downloads" list, survives page reloads) and
    // record completion in the activity log (permanent record, no movie ref).
    const mt = plugin.mediaTypes[0];
    const job = createFetchJob(id, release.title);

    const onProgress = (p: FetchProgress) => {
      if (p.message) logger.info(`[plugin:${id}] ${release.title}: ${p.message}`);
      updateFetchJob(job.id, p);
    };
    const finish = (r: { ok: boolean; files?: string[]; error?: string }) => {
      finishFetchJob(job.id, r);
      // New files landed — drop the library cache so the Mediathek shows them on
      // the next load instead of serving a snapshot for up to five more minutes.
      if (r.ok) invalidateMusicLibraryCache();
      if (r.ok) addLogEntry(null, `${mt}_download_finished`, release.title);
      else addLogEntry(null, `${mt}_download_failed`, `${release.title} — ${r.error || 'Fehler'}`);
      logger.info(`[plugin:${id}] fetch ${r.ok ? 'ok' : 'failed'}: ${release.title}${r.ok ? '' : ' — ' + r.error}`);
    };

    // A plugin's fetchRelease may reject OR throw synchronously (the contract
    // allows both — it needn't be declared async). `Promise.resolve().then(...)`
    // funnels a synchronous throw into the rejection path; calling it bare inside
    // setImmediate let that throw escape as an uncaught exception, which the
    // process-level handler answers by exiting — killing every other in-flight job.
    const runFetch = () => withPluginTimeout(
      'fetchRelease',
      PLUGIN_TIMEOUTS.fetchRelease,
      Promise.resolve().then(() => fetchRelease(release, { destDir, onProgress })),
    );

    if (background) {
      res.status(202).json({ started: true, jobId: job.id, release: release.title });
      setImmediate(() => {
        runFetch()
          .then((r) => finish(r))
          .catch((e) => finish({ ok: false, error: e?.message || String(e) }));
      });
      return;
    }

    // Mirror the background path's error handling: if fetchRelease THROWS (the
    // contract allows it — a plugin needn't wrap everything into {ok:false}),
    // still finish the job, or it sticks in 'processing' forever.
    let result;
    try {
      result = await runFetch();
    } catch (e: any) {
      finish({ ok: false, error: e?.message || String(e) });
      res.status(502).json({ jobId: job.id, release: release.title, ok: false, error: e?.message || String(e) });
      return;
    }
    finish(result);
    res.status(result.ok ? 200 : 502).json({ jobId: job.id, release: release.title, ...result });
  } catch (err) {
    sendInstallError(res, err);
  }
});

/**
 * DELETE /api/plugins/:id
 * Uninstall a plugin (refuses if bundled).
 */
router.delete('/:id', requireTokenWhenConfigured, (req: Request, res: Response) => {
  try {
    uninstallPlugin(String(req.params.id));
    res.json({ success: true });
  } catch (err) {
    sendInstallError(res, err);
  }
});

export default router;
