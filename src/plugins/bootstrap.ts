import { loadPluginsFromDirectory, defaultPluginsDir, type LoadResult } from './loader';

/**
 * Scan the on-disk plugin directory and register valid, user-accepted plugins.
 * dlvault ships with zero bundled source plugins — the core is a plugin host
 * and all sources are user-installed via the Plugin settings UI.
 */
export function loadDynamicPlugins(pluginsDir: string = defaultPluginsDir()): LoadResult {
  return loadPluginsFromDirectory(pluginsDir);
}
