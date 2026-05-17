import { pluginRegistry } from './registry';
import { createPluginContext } from './context';
import iaFactory, { manifest as iaManifest } from './internet-archive/index';
import { loadPluginsFromDirectory, defaultPluginsDir, type LoadResult } from './loader';

/**
 * Register the plugins bundled with this build (priority order = registration
 * order). Bundled plugins win id-collisions against dynamically-loaded ones.
 */
export function registerBuiltinPlugins(): void {
  pluginRegistry.registerBundled(iaFactory(createPluginContext(iaManifest)), iaManifest);
}

/**
 * Scan the on-disk plugin directory and register valid, user-accepted plugins.
 * Called after `registerBuiltinPlugins()` so bundled plugins keep their slot.
 */
export function loadDynamicPlugins(pluginsDir: string = defaultPluginsDir()): LoadResult {
  return loadPluginsFromDirectory(pluginsDir);
}
