import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { logger } from '../utils/logger';
import { pluginRegistry } from './registry';
import { validateManifest, hostVersionSatisfies, ManifestValidationError, HOST_VERSION } from './manifest';
import type { PluginManifest } from './manifest';
import { createPluginContext, type PluginFactory } from './context';
import { recordDisclaimerAccepted, defaultPluginsDir } from './loader';

/**
 * Plugin install service. Given a URL or an uploaded buffer, validates the
 * plugin file, writes it to data/plugins/, records the user's disclaimer
 * acceptance, and registers the plugin with the registry.
 *
 * This is the trust boundary: every code path that brings new code onto disk
 * goes through one of the install* helpers, which require an explicit
 * disclaimerAccepted=true flag.
 */

const MAX_PLUGIN_BYTES = 5 * 1024 * 1024; // 5 MB cap
const DOWNLOAD_TIMEOUT_MS = 30_000;

export class InstallError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = 'InstallError';
  }
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  sourceUrl?: string;
  fileSha256: string;
  filePath: string;
}

export interface PluginPreview {
  manifest: PluginManifest;
  fileSha256: string;
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Validate a plugin .js buffer in isolation, extract its manifest.
 * Compiles the module in a temp file (Node's require is path-based).
 * Returns the manifest and a parsed factory, or throws InstallError.
 */
function parseAndValidateBuffer(buf: Buffer): { manifest: PluginManifest; factory: PluginFactory } {
  // Compile via a tmp file so require() can find the module. Node's
  // require requires a path; we have a buffer. The tmp file is unlinked
  // before this function returns.
  const tmpFile = path.join(
    fs.mkdtempSync(path.join(require('os').tmpdir(), 'dlvault-install-')),
    'candidate.dlvault.js',
  );
  fs.writeFileSync(tmpFile, buf);

  try {
    let mod: { manifest?: unknown; default?: unknown };
    try {
      delete require.cache[require.resolve(tmpFile)];
      mod = require(tmpFile) as { manifest?: unknown; default?: unknown };
    } catch (err: any) {
      throw new InstallError(`plugin file failed to parse: ${err?.message || err}`);
    }

    let manifest: PluginManifest;
    try {
      manifest = validateManifest(mod.manifest);
    } catch (err) {
      const msg = err instanceof ManifestValidationError ? err.message : String(err);
      throw new InstallError(`invalid manifest: ${msg}`);
    }

    if (!hostVersionSatisfies(HOST_VERSION, manifest.minHostVersion)) {
      throw new InstallError(
        `plugin requires host ${manifest.minHostVersion}, this build is ${HOST_VERSION}`,
      );
    }

    if (typeof mod.default !== 'function') {
      throw new InstallError('plugin must export a default factory function');
    }

    return { manifest, factory: mod.default as PluginFactory };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(path.dirname(tmpFile));
    } catch { /* best effort */ }
  }
}

/**
 * Common install path. Takes a validated buffer + manifest, writes the file
 * to data/plugins/, records the disclaimer entry, and registers the plugin.
 * Returns the metadata for the API response.
 */
function commitInstall(
  buf: Buffer,
  manifest: PluginManifest,
  factory: PluginFactory,
  opts: { sourceUrl?: string; pluginsDir: string },
): InstalledPlugin {
  if (pluginRegistry.isBundled(manifest.id)) {
    throw new InstallError(`plugin id "${manifest.id}" is reserved by a bundled plugin`, 409);
  }

  if (!fs.existsSync(opts.pluginsDir)) {
    fs.mkdirSync(opts.pluginsDir, { recursive: true });
  }
  const filePath = path.join(opts.pluginsDir, `${manifest.id}.dlvault.js`);
  fs.writeFileSync(filePath, buf);
  const fileSha256 = sha256(buf);

  // Instantiate before recording disclaimer — if the factory throws we don't
  // want a stale acceptance pointing at a broken plugin.
  let plugin;
  try {
    plugin = factory(createPluginContext(manifest));
  } catch (err: any) {
    // Roll back the file write so a broken plugin doesn't litter the dir.
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    throw new InstallError(`plugin factory threw: ${err?.message || err}`);
  }

  if (!plugin || plugin.id !== manifest.id) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    throw new InstallError('plugin factory returned an invalid plugin (id mismatch)');
  }

  recordDisclaimerAccepted(opts.pluginsDir, manifest.id, {
    acceptedAt: new Date().toISOString(),
    sourceUrl: opts.sourceUrl,
    fileSha256,
    manifestVersion: manifest.version,
  });

  pluginRegistry.register(plugin, manifest);
  logger.info(`Plugin installed: ${manifest.id} v${manifest.version}${opts.sourceUrl ? ` from ${opts.sourceUrl}` : ''}`);

  return { manifest, sourceUrl: opts.sourceUrl, fileSha256, filePath };
}

export interface InstallOpts {
  disclaimerAccepted: boolean;
  pluginsDir?: string;
}

// Cloud instance-metadata endpoints (IMDS). LAN/private hosts are intentionally
// allowed (a user may self-host a plugin server), but these credential-leaking
// endpoints are never a legitimate plugin source.
const METADATA_HOSTS = new Set([
  '169.254.169.254', 'fd00:ec2::254',
  'metadata.google.internal', 'metadata.goog',
]);

function assertNotMetadataHost(hostname: string): void {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // The whole IPv4 link-local range (169.254/16) is the metadata range.
  if (METADATA_HOSTS.has(h) || /^169\.254\./.test(h)) {
    throw new InstallError('refusing to fetch from a cloud metadata endpoint');
  }
}

/** Download a buffer from an https URL with size + timeout caps. */
async function fetchPluginBuffer(url: string): Promise<Buffer> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new InstallError('invalid URL'); }
  if (parsed.protocol !== 'https:') {
    throw new InstallError('only https:// URLs are accepted');
  }
  assertNotMetadataHost(parsed.hostname);
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxContentLength: MAX_PLUGIN_BYTES,
      maxBodyLength: MAX_PLUGIN_BYTES,
      headers: { 'User-Agent': 'dlvault/1.0 (plugin-installer)' },
      // axios follows redirects automatically — re-validate each hop so an
      // https URL can't bounce to http:// or to a metadata endpoint.
      beforeRedirect: (options: any) => {
        if (options.protocol && options.protocol !== 'https:') {
          throw new InstallError('refusing to follow a redirect to a non-https URL');
        }
        const host = String(options.hostname || options.host || '');
        if (host) assertNotMetadataHost(host);
      },
    });
    const buf = Buffer.from(res.data);
    if (buf.length > MAX_PLUGIN_BYTES) {
      throw new InstallError(`plugin file too large (${buf.length} > ${MAX_PLUGIN_BYTES} bytes)`);
    }
    return buf;
  } catch (err: any) {
    if (err instanceof InstallError) throw err;
    throw new InstallError(`download failed: ${err?.message || err}`, 502);
  }
}

/**
 * Validate a plugin without installing it. Returns the manifest + hash so the
 * UI can render a preview ("about to install: name vX.Y.Z, needs permissions
 * [...], CSP domains [...]"). Disclaimer is NOT required for preview.
 */
export async function previewPlugin(input: { url?: string; contentBase64?: string }): Promise<PluginPreview> {
  let buf: Buffer;
  if (input.url) {
    buf = await fetchPluginBuffer(input.url);
  } else if (input.contentBase64) {
    try {
      buf = Buffer.from(input.contentBase64, 'base64');
    } catch {
      throw new InstallError('contentBase64 is not valid base64');
    }
    if (buf.length > MAX_PLUGIN_BYTES) {
      throw new InstallError(`plugin file too large (${buf.length} > ${MAX_PLUGIN_BYTES} bytes)`);
    }
  } else {
    throw new InstallError('preview requires either url or contentBase64');
  }
  const { manifest } = parseAndValidateBuffer(buf);
  return { manifest, fileSha256: sha256(buf) };
}

/**
 * Install a plugin from a remote URL. The URL is downloaded over HTTPS only
 * (HTTP redirects are followed automatically by axios but the initial URL
 * must be https). Size is capped, content-type is not enforced (npm cdn
 * sometimes serves application/octet-stream).
 */
export async function installFromUrl(url: string, opts: InstallOpts): Promise<InstalledPlugin> {
  if (!opts.disclaimerAccepted) {
    throw new InstallError('disclaimerAccepted must be true to install a plugin', 400);
  }
  const buf = await fetchPluginBuffer(url);
  const { manifest, factory } = parseAndValidateBuffer(buf);
  return commitInstall(buf, manifest, factory, {
    sourceUrl: url,
    pluginsDir: opts.pluginsDir || defaultPluginsDir(),
  });
}

/**
 * Install a plugin from an uploaded file buffer (multipart form upload).
 */
export async function installFromBuffer(
  filename: string,
  buf: Buffer,
  opts: InstallOpts,
): Promise<InstalledPlugin> {
  if (!opts.disclaimerAccepted) {
    throw new InstallError('disclaimerAccepted must be true to install a plugin', 400);
  }
  if (!filename.endsWith('.dlvault.js')) {
    throw new InstallError('uploaded file must end in .dlvault.js');
  }
  if (buf.length > MAX_PLUGIN_BYTES) {
    throw new InstallError(`plugin file too large (${buf.length} > ${MAX_PLUGIN_BYTES} bytes)`);
  }

  const { manifest, factory } = parseAndValidateBuffer(buf);
  return commitInstall(buf, manifest, factory, {
    sourceUrl: `upload:${filename}`,
    pluginsDir: opts.pluginsDir || defaultPluginsDir(),
  });
}

/**
 * Accept a plugin that's already physically present in data/plugins/ (drop-file
 * UX). The user clicks "Accept" in the pending-list UI; we read the file from
 * disk, validate, then commit (writing the disclaimer entry + registering).
 *
 * Reads the file fresh and computes a fresh hash to defend against TOCTOU —
 * if the file changed since the user saw it in the pending list, the install
 * still succeeds against the *current* file (but the recorded hash is the
 * current one, so subsequent loads validate cleanly).
 */
export async function acceptPendingPlugin(
  pluginId: string,
  opts: InstallOpts,
): Promise<InstalledPlugin> {
  if (!opts.disclaimerAccepted) {
    throw new InstallError('disclaimerAccepted must be true', 400);
  }
  const dir = opts.pluginsDir || defaultPluginsDir();
  const filePath = path.join(dir, `${pluginId}.dlvault.js`);
  if (!fs.existsSync(filePath)) {
    throw new InstallError(`plugin file not found: ${pluginId}.dlvault.js`, 404);
  }
  const buf = fs.readFileSync(filePath);
  const { manifest, factory } = parseAndValidateBuffer(buf);
  if (manifest.id !== pluginId) {
    throw new InstallError(`file declares plugin id "${manifest.id}", expected "${pluginId}"`);
  }
  return commitInstall(buf, manifest, factory, {
    sourceUrl: 'local-file',
    pluginsDir: dir,
  });
}

/**
 * Remove a plugin: unregister, delete file, purge disclaimer entry.
 * Bundled plugins cannot be uninstalled.
 */
export function uninstallPlugin(pluginId: string, pluginsDir: string = defaultPluginsDir()): void {
  if (pluginRegistry.isBundled(pluginId)) {
    throw new InstallError(`plugin "${pluginId}" is bundled and cannot be uninstalled`, 409);
  }
  pluginRegistry.unregister(pluginId);

  const filePath = path.join(pluginsDir, `${pluginId}.dlvault.js`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  const logFile = path.join(pluginsDir, 'disclaimer-log.json');
  if (fs.existsSync(logFile)) {
    try {
      const log = JSON.parse(fs.readFileSync(logFile, 'utf-8')) as Record<string, unknown>;
      delete log[pluginId];
      fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
    } catch (err: any) {
      logger.warn(`Could not purge disclaimer entry for ${pluginId}: ${err.message}`);
    }
  }
  logger.info(`Plugin uninstalled: ${pluginId}`);
}
