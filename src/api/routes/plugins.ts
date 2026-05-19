import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { pluginRegistry } from '../../plugins/registry';
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
import { logger } from '../../utils/logger';

const router = Router();

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
router.post('/preview', async (req: Request, res: Response) => {
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
router.post('/install', async (req: Request, res: Response) => {
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
router.post('/upload', async (req: Request, res: Response) => {
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
router.post('/:id/accept', async (req: Request, res: Response) => {
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
 * DELETE /api/plugins/:id
 * Uninstall a plugin (refuses if bundled).
 */
router.delete('/:id', (req: Request, res: Response) => {
  try {
    uninstallPlugin(String(req.params.id));
    res.json({ success: true });
  } catch (err) {
    sendInstallError(res, err);
  }
});

export default router;
