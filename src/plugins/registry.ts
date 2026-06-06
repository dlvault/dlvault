import { getSetting } from '../database/index';
import { registerSensitiveKey } from '../database/encryption';
import { logger } from '../utils/logger';
import type {
  SourcePlugin,
  MediaType,
  DiscoverItem,
  PluginHealthOutcome,
  TitleCandidate,
} from './types';
import type { PluginManifest } from './manifest';
import { withPluginTimeout, PLUGIN_TIMEOUTS } from './timeout';

/**
 * In-memory plugin registry. Plugins are registered once at startup (see
 * src/plugins/bootstrap.ts) and looked up by consumers (scheduler, search
 * routes, CSP, health checks). Iteration order matches registration order —
 * the first-registered plugin is tried first by the scheduler.
 */
class PluginRegistry {
  private plugins: SourcePlugin[] = [];
  // Manifest stored alongside the plugin so the API + UI can render version,
  // description, settingsSchema etc. Populated when bootstrap/loader passes
  // a manifest; falls back to undefined for plugins registered without one.
  private manifests = new Map<string, PluginManifest>();
  // Plugins shipped with the host that the user cannot uninstall via API.
  // Tracked separately so the /api/plugins DELETE handler can reject bundled
  // removals.
  private bundledIds = new Set<string>();

  /** Register a plugin. Idempotent on id — second registration replaces the first. */
  register(plugin: SourcePlugin, manifest?: PluginManifest): void {
    const existing = this.plugins.findIndex(p => p.id === plugin.id);
    if (existing !== -1) {
      logger.warn(`Plugin "${plugin.id}" re-registered — replacing existing entry`);
      // Best-effort close the displaced instance so a hot-deploy (re-upload without
      // restart) can't leak its resources — child-process workers, a launched
      // browser, intervals. Mirrors unregister()'s cleanup. Fire-and-forget: the
      // old instance owns resources separate from the incoming one, so closing it
      // never affects the replacement.
      const old = this.plugins[existing];
      if (typeof old.close === 'function') {
        old.close().catch(err => logger.warn(`Plugin "${plugin.id}" close on replace failed: ${err?.message || err}`));
      }
      this.plugins[existing] = plugin;
    } else {
      this.plugins.push(plugin);
      logger.info(`Plugin registered: ${plugin.id} (${plugin.name})`);
    }
    if (manifest) {
      this.manifests.set(plugin.id, manifest);
      // Plugin manifests can mark settings fields as `type: 'secret'` —
      // flag those for encryption-at-rest just like host secrets.
      for (const field of manifest.settingsSchema || []) {
        if (field.type === 'secret') {
          registerSensitiveKey(`plugins.${plugin.id}.${field.key}`);
        }
      }
    }
  }

  /**
   * Register a plugin and flag it as bundled (built into the host).
   * Bundled plugins cannot be uninstalled via the public API.
   */
  registerBundled(plugin: SourcePlugin, manifest?: PluginManifest): void {
    this.register(plugin, manifest);
    this.bundledIds.add(plugin.id);
  }

  /** Manifest associated with a registered plugin (if known). */
  getManifest(id: string): PluginManifest | undefined {
    return this.manifests.get(id);
  }

  /**
   * Remove a plugin from the registry. Returns true on success, false if the
   * id is unknown or the plugin is bundled (and thus protected).
   */
  unregister(id: string): boolean {
    if (this.bundledIds.has(id)) return false;
    const idx = this.plugins.findIndex(p => p.id === id);
    if (idx === -1) return false;
    const plugin = this.plugins[idx];
    this.plugins.splice(idx, 1);
    this.manifests.delete(id);
    // Best-effort cleanup — don't block unregister on close failures.
    if (typeof plugin.close === 'function') {
      plugin.close().catch(err => logger.warn(`Plugin "${id}" close on unregister failed: ${err?.message || err}`));
    }
    logger.info(`Plugin unregistered: ${id}`);
    return true;
  }

  isBundled(id: string): boolean {
    return this.bundledIds.has(id);
  }

  /** Replace all registered plugins. Test helper. */
  _reset(): void {
    this.plugins = [];
    this.manifests.clear();
    this.bundledIds.clear();
  }

  getById(id: string): SourcePlugin | undefined {
    return this.plugins.find(p => p.id === id);
  }

  /** All plugins in registration order. */
  getAll(): readonly SourcePlugin[] {
    return this.plugins;
  }

  /**
   * Plugins that should be tried for a given media type, in priority order,
   * filtered by the per-plugin enable flag (setting `plugins.<id>.enabled`).
   * Default-enabled if the setting is absent or 'true'.
   */
  forMediaType(mediaType: MediaType): SourcePlugin[] {
    return this.plugins
      .filter(p => p.mediaTypes.includes(mediaType))
      .filter(p => this.isEnabled(p.id));
  }

  /** Whether a plugin is enabled. Default true. */
  isEnabled(id: string): boolean {
    const setting = getSetting(`plugins.${id}.enabled`);
    if (!setting) return true;
    return setting === 'true' || setting === '1';
  }

  /** Aggregate CSP image-src domains from all registered plugins. */
  getCspDomains(): string[] {
    const domains = new Set<string>();
    for (const p of this.plugins) {
      for (const d of p.cspDomains || []) {
        domains.add(d.startsWith('http') ? d : `https://${d}`);
      }
    }
    return [...domains];
  }

  /** Run all plugin health checks in parallel. */
  async runHealthChecks(): Promise<Record<string, PluginHealthOutcome>> {
    const entries = this.plugins
      .filter(p => typeof p.healthCheck === 'function')
      .map(async p => {
        try {
          const out = await withPluginTimeout('healthCheck', PLUGIN_TIMEOUTS.healthCheck, p.healthCheck!());
          return [p.id, out] as const;
        } catch (err: any) {
          return [p.id, {
            ok: false,
            critical: false,
            error: err?.message || String(err),
          }] as const;
        }
      });
    const results = await Promise.all(entries);
    return Object.fromEntries(results);
  }

  /**
   * Aggregate free-text title-search candidates across all plugins that
   * implement searchTitles. Each candidate is tagged with its source pluginId
   * so the caller can show provenance. Order: plugin priority, then plugin
   * internal order. Failures are logged and skipped silently.
   */
  async aggregateSearchTitles(
    query: string,
    opts: { mediaType?: MediaType; limit?: number } = {},
  ): Promise<TitleCandidate[]> {
    const filter: SourcePlugin[] = opts.mediaType
      ? this.forMediaType(opts.mediaType)
      : this.plugins.filter(p => this.isEnabled(p.id));
    const candidates = filter.filter(p => typeof p.searchTitles === 'function');
    const results = await Promise.all(candidates.map(async p => {
      try {
        const hits = await withPluginTimeout('searchTitles', PLUGIN_TIMEOUTS.searchTitles, p.searchTitles!(query, opts));
        return hits.map(h => ({ ...h, pluginId: p.id }));
      } catch (err: any) {
        logger.warn(`Plugin "${p.id}" searchTitles("${query}") failed: ${err?.message || err}`);
        return [] as TitleCandidate[];
      }
    }));
    return results.flat();
  }

  /**
   * Aggregate discover results from all plugins for a given media type. Each
   * plugin contributes up to its own internal cap (typically 10). Caller can
   * slice further. Plugins without `discover` are skipped.
   */
  async aggregateDiscover(mediaType: MediaType): Promise<DiscoverItem[]> {
    const candidates = this.forMediaType(mediaType)
      .filter(p => typeof p.discover === 'function');
    const results = await Promise.all(candidates.map(async p => {
      try {
        return await withPluginTimeout('discover', PLUGIN_TIMEOUTS.discover, p.discover!(mediaType));
      } catch (err: any) {
        logger.warn(`Plugin "${p.id}" discover(${mediaType}) failed: ${err?.message || err}`);
        return [] as DiscoverItem[];
      }
    }));
    return results.flat();
  }

  /**
   * Per-plugin discover breakdown. Same data as aggregateDiscover but grouped
   * so the UI can render one section per source instead of a flattened list.
   * Plugins that error or return no items are omitted from the result.
   */
  async aggregateDiscoverByPlugin(
    mediaType: MediaType,
  ): Promise<Array<{ pluginId: string; pluginName: string; items: DiscoverItem[] }>> {
    const candidates = this.forMediaType(mediaType)
      .filter(p => typeof p.discover === 'function');
    const results = await Promise.all(candidates.map(async p => {
      try {
        const items = await withPluginTimeout('discover', PLUGIN_TIMEOUTS.discover, p.discover!(mediaType));
        return { pluginId: p.id, pluginName: p.name, items };
      } catch (err: any) {
        logger.warn(`Plugin "${p.id}" discover(${mediaType}) failed: ${err?.message || err}`);
        return { pluginId: p.id, pluginName: p.name, items: [] as DiscoverItem[] };
      }
    }));
    return results.filter(r => r.items.length > 0);
  }

  /** Cached version of aggregateDiscover that avoids network calls. */
  getCachedDiscover(mediaType: MediaType): DiscoverItem[] {
    const candidates = this.forMediaType(mediaType)
      .filter(p => typeof p.getCachedDiscover === 'function');
    const out: DiscoverItem[] = [];
    for (const p of candidates) {
      const cached = p.getCachedDiscover!(mediaType);
      if (cached) out.push(...cached);
    }
    return out;
  }

  /** Close every plugin that supports it. */
  async closeAll(): Promise<void> {
    await Promise.all(
      this.plugins
        .filter(p => typeof p.close === 'function')
        .map(p => p.close!().catch(err => {
          logger.warn(`Plugin "${p.id}" close failed: ${err?.message || err}`);
        })),
    );
  }
}

export const pluginRegistry = new PluginRegistry();
