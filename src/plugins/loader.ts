import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { pluginRegistry } from './registry';
import { createPluginContext, type PluginFactory } from './context';
import { validateManifest, hostVersionSatisfies, ManifestValidationError } from './manifest';
import type { PluginManifest } from './manifest';
import type { SourcePlugin } from './types';

/**
 * File-based plugin loader. Scans a directory for `*.dlvault.js`, requires
 * each, validates the manifest, builds a context, and registers the plugin
 * with the registry.
 *
 * Plugins are only registered if their id is present in the disclaimer log
 * (data/plugins/disclaimer-log.json). Files without a corresponding accept
 * entry are reported as "pending" so the UI can prompt the user.
 */

const HOST_VERSION = '1.0.0'; // bumped manually with each release
const PLUGIN_FILE_SUFFIX = '.dlvault.js';
const DISCLAIMER_LOG = 'disclaimer-log.json';

export interface DisclaimerEntry {
  acceptedAt: string;
  sourceUrl?: string;
  fileSha256: string;
  manifestVersion: string;
}

export interface PendingPlugin {
  path: string;
  fileSha256: string;
  manifest: PluginManifest;
  reason: 'no-disclaimer' | 'sha-mismatch';
}

export interface LoadError {
  path: string;
  error: string;
}

export interface LoadResult {
  loaded: { manifest: PluginManifest; plugin: SourcePlugin }[];
  pending: PendingPlugin[];
  errors: LoadError[];
}

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readDisclaimerLog(pluginsDir: string): Record<string, DisclaimerEntry> {
  const file = path.join(pluginsDir, DISCLAIMER_LOG);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, DisclaimerEntry>;
  } catch (err: any) {
    logger.warn(`Plugin loader: could not parse ${DISCLAIMER_LOG}: ${err.message}`);
    return {};
  }
}

/**
 * Append a disclaimer entry. Idempotent on plugin id — re-accept overwrites.
 * Called by the install API after the user clicks "Install" in the UI.
 */
export function recordDisclaimerAccepted(
  pluginsDir: string,
  pluginId: string,
  entry: DisclaimerEntry,
): void {
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
  const file = path.join(pluginsDir, DISCLAIMER_LOG);
  const log = readDisclaimerLog(pluginsDir);
  log[pluginId] = entry;
  fs.writeFileSync(file, JSON.stringify(log, null, 2));
  logger.info(`Plugin disclaimer recorded for "${pluginId}"`);
}

interface PluginModule {
  manifest?: unknown;
  default?: unknown;
}

function loadOnePlugin(
  filePath: string,
  disclaimerLog: Record<string, DisclaimerEntry>,
  alreadyRegistered: ReadonlySet<string>,
): { kind: 'loaded'; manifest: PluginManifest; plugin: SourcePlugin }
  | { kind: 'pending'; pending: PendingPlugin }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; error: string } {
  let mod: PluginModule;
  try {
    // Clear require cache so re-loading picks up changes (mostly relevant for tests)
    delete require.cache[require.resolve(filePath)];
    mod = require(filePath) as PluginModule;
  } catch (err: any) {
    return { kind: 'error', error: `require failed: ${err?.message || err}` };
  }

  let manifest: PluginManifest;
  try {
    manifest = validateManifest(mod.manifest);
  } catch (err) {
    const msg = err instanceof ManifestValidationError ? err.message : String(err);
    return { kind: 'error', error: `invalid manifest: ${msg}` };
  }

  if (!hostVersionSatisfies(HOST_VERSION, manifest.minHostVersion)) {
    return { kind: 'error', error: `requires host ${manifest.minHostVersion}, running ${HOST_VERSION}` };
  }

  if (alreadyRegistered.has(manifest.id)) {
    // Not actually an error: this happens whenever a file on disk matches a
    // plugin that was already registered through the install API, or when a
    // bundled plugin shares an id with a disk plugin. The loader is the
    // second mechanism — silently skip rather than spam ERROR logs.
    return { kind: 'skipped', reason: `already registered (id="${manifest.id}")` };
  }

  if (typeof mod.default !== 'function') {
    return { kind: 'error', error: 'plugin must export a default factory function' };
  }

  const sha = sha256File(filePath);
  const accepted = disclaimerLog[manifest.id];
  if (!accepted) {
    return {
      kind: 'pending',
      pending: { path: filePath, fileSha256: sha, manifest, reason: 'no-disclaimer' },
    };
  }
  if (accepted.fileSha256 !== sha) {
    return {
      kind: 'pending',
      pending: { path: filePath, fileSha256: sha, manifest, reason: 'sha-mismatch' },
    };
  }

  let plugin: SourcePlugin;
  try {
    const context = createPluginContext(manifest);
    plugin = (mod.default as PluginFactory)(context);
  } catch (err: any) {
    return { kind: 'error', error: `factory threw: ${err?.message || err}` };
  }

  if (!plugin || plugin.id !== manifest.id) {
    return { kind: 'error', error: `factory returned an invalid plugin (id mismatch)` };
  }

  return { kind: 'loaded', manifest, plugin };
}

/**
 * Scan `pluginsDir` for `*.dlvault.js` and register valid, disclaimer-accepted
 * plugins. Never throws — errors are collected and returned.
 */
export function loadPluginsFromDirectory(pluginsDir: string): LoadResult {
  const result: LoadResult = { loaded: [], pending: [], errors: [] };

  if (!fs.existsSync(pluginsDir)) {
    logger.debug(`Plugin loader: ${pluginsDir} does not exist — nothing to load`);
    return result;
  }

  const disclaimerLog = readDisclaimerLog(pluginsDir);
  const alreadyRegistered = new Set(pluginRegistry.getAll().map(p => p.id));

  const files = fs.readdirSync(pluginsDir)
    .filter(f => f.endsWith(PLUGIN_FILE_SUFFIX))
    .map(f => path.resolve(pluginsDir, f));

  for (const filePath of files) {
    const outcome = loadOnePlugin(filePath, disclaimerLog, alreadyRegistered);
    if (outcome.kind === 'loaded') {
      pluginRegistry.register(outcome.plugin, outcome.manifest);
      alreadyRegistered.add(outcome.manifest.id);
      result.loaded.push({ manifest: outcome.manifest, plugin: outcome.plugin });
      logger.info(`Plugin loaded from disk: ${outcome.manifest.id} v${outcome.manifest.version}`);
    } else if (outcome.kind === 'pending') {
      result.pending.push(outcome.pending);
      logger.warn(
        `Plugin "${outcome.pending.manifest.id}" found at ${path.basename(filePath)} but ` +
        `${outcome.pending.reason === 'no-disclaimer' ? 'disclaimer not accepted' : 'file hash changed since last accept'} ` +
        `— not registered`,
      );
    } else if (outcome.kind === 'skipped') {
      logger.debug(`Plugin loader: ${path.basename(filePath)} — ${outcome.reason}`);
    } else {
      result.errors.push({ path: filePath, error: outcome.error });
      logger.error(`Plugin loader: ${path.basename(filePath)} — ${outcome.error}`);
    }
  }

  return result;
}

/**
 * Default plugin directory: `<project-root>/data/plugins/`. Matches the
 * DATA_DIR convention used by the database module.
 */
export function defaultPluginsDir(): string {
  return path.join(__dirname, '../../data/plugins');
}
