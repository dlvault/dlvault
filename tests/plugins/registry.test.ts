import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSettings: Record<string, string> = {};
const registerSensitiveKey = vi.fn();
vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
  default: { prepare: vi.fn() },
}));
vi.mock('../../src/database/encryption', () => ({
  registerSensitiveKey: (key: string) => registerSensitiveKey(key),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { pluginRegistry } from '../../src/plugins/registry';
import type { SourcePlugin } from '../../src/plugins/types';
import type { PluginManifest } from '../../src/plugins/manifest';

function makePlugin(overrides: Partial<SourcePlugin> & Pick<SourcePlugin, 'id' | 'mediaTypes'>): SourcePlugin {
  return {
    name: overrides.id,
    findReleases: async () => ({ sourceUrl: null, releases: [] }),
    resolveLinks: async (l) => l,
    ...overrides,
  } as SourcePlugin;
}

describe('PluginRegistry', () => {
  beforeEach(() => {
    pluginRegistry._reset();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    registerSensitiveKey.mockReset();
  });

  it('preserves registration order', () => {
    pluginRegistry.register(makePlugin({ id: 'a', mediaTypes: ['movie'] }));
    pluginRegistry.register(makePlugin({ id: 'b', mediaTypes: ['movie'] }));
    pluginRegistry.register(makePlugin({ id: 'c', mediaTypes: ['movie'] }));
    expect(pluginRegistry.getAll().map(p => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('replaces a plugin on re-registration', () => {
    pluginRegistry.register(makePlugin({ id: 'x', mediaTypes: ['movie'], name: 'X1' }));
    pluginRegistry.register(makePlugin({ id: 'x', mediaTypes: ['movie'], name: 'X2' }));
    expect(pluginRegistry.getAll().length).toBe(1);
    expect(pluginRegistry.getById('x')?.name).toBe('X2');
  });

  it('filters by media type', () => {
    pluginRegistry.register(makePlugin({ id: 'movies-only', mediaTypes: ['movie'] }));
    pluginRegistry.register(makePlugin({ id: 'shows-only', mediaTypes: ['show'] }));
    pluginRegistry.register(makePlugin({ id: 'both', mediaTypes: ['movie', 'show'] }));
    expect(pluginRegistry.forMediaType('movie').map(p => p.id)).toEqual(['movies-only', 'both']);
    expect(pluginRegistry.forMediaType('show').map(p => p.id)).toEqual(['shows-only', 'both']);
  });

  it('respects the per-plugin enable flag', () => {
    pluginRegistry.register(makePlugin({ id: 'a', mediaTypes: ['movie'] }));
    pluginRegistry.register(makePlugin({ id: 'b', mediaTypes: ['movie'] }));
    expect(pluginRegistry.forMediaType('movie').map(p => p.id)).toEqual(['a', 'b']);

    mockSettings['plugins.a.enabled'] = 'false';
    expect(pluginRegistry.forMediaType('movie').map(p => p.id)).toEqual(['b']);

    mockSettings['plugins.a.enabled'] = 'true';
    expect(pluginRegistry.forMediaType('movie').map(p => p.id)).toEqual(['a', 'b']);
  });

  it('aggregates CSP domains across plugins and normalizes', () => {
    pluginRegistry.register(makePlugin({ id: 'a', mediaTypes: ['movie'], cspDomains: ['example.com'] }));
    pluginRegistry.register(makePlugin({ id: 'b', mediaTypes: ['movie'], cspDomains: ['https://other.com', 'example.com'] }));
    const domains = pluginRegistry.getCspDomains();
    expect(domains).toContain('https://example.com');
    expect(domains).toContain('https://other.com');
    // De-duplicated
    expect(domains.length).toBe(2);
  });

  it('runs health checks in parallel and tolerates throws', async () => {
    pluginRegistry.register(makePlugin({
      id: 'good',
      mediaTypes: ['movie'],
      healthCheck: async () => ({ ok: true, critical: false, detail: 'ok' }),
    }));
    pluginRegistry.register(makePlugin({
      id: 'bad',
      mediaTypes: ['movie'],
      healthCheck: async () => { throw new Error('boom'); },
    }));
    pluginRegistry.register(makePlugin({ id: 'silent', mediaTypes: ['movie'] }));

    const results = await pluginRegistry.runHealthChecks();
    expect(results.good).toEqual({ ok: true, critical: false, detail: 'ok' });
    expect(results.bad.ok).toBe(false);
    expect(results.bad.error).toBe('boom');
    expect(results.silent).toBeUndefined();
  });

  it('aggregates discover results in registration order', async () => {
    pluginRegistry.register(makePlugin({
      id: 'first',
      mediaTypes: ['movie'],
      discover: async () => [
        { rank: 1, title: 'A', genres: [], poster: null, url: '/a', description: '' },
      ],
    }));
    pluginRegistry.register(makePlugin({
      id: 'second',
      mediaTypes: ['movie'],
      discover: async () => [
        { rank: 1, title: 'B', genres: [], poster: null, url: '/b', description: '' },
      ],
    }));
    const items = await pluginRegistry.aggregateDiscover('movie');
    expect(items.map(i => i.title)).toEqual(['A', 'B']);
  });

  it('aggregateDiscover survives a plugin throwing', async () => {
    pluginRegistry.register(makePlugin({
      id: 'good',
      mediaTypes: ['movie'],
      discover: async () => [
        { rank: 1, title: 'OK', genres: [], poster: null, url: '/ok', description: '' },
      ],
    }));
    pluginRegistry.register(makePlugin({
      id: 'broken',
      mediaTypes: ['movie'],
      discover: async () => { throw new Error('discover blew up'); },
    }));
    const items = await pluginRegistry.aggregateDiscover('movie');
    expect(items.map(i => i.title)).toEqual(['OK']);
  });

  it('stores and returns a manifest, flagging secret settings fields for encryption', () => {
    const manifest: PluginManifest = {
      id: 'm', name: 'M', version: '1.0.0', mediaTypes: ['movie'],
      settingsSchema: [
        { key: 'api_key', type: 'secret', label: 'API Key' } as any,
        { key: 'host', type: 'string', label: 'Host' } as any,
      ],
    };
    pluginRegistry.register(makePlugin({ id: 'm', mediaTypes: ['movie'] }), manifest);
    expect(pluginRegistry.getManifest('m')).toBe(manifest);
    expect(registerSensitiveKey).toHaveBeenCalledTimes(1);
    expect(registerSensitiveKey).toHaveBeenCalledWith('plugins.m.api_key');
  });

  it('getManifest returns undefined when no manifest was supplied', () => {
    pluginRegistry.register(makePlugin({ id: 'nomani', mediaTypes: ['movie'] }));
    expect(pluginRegistry.getManifest('nomani')).toBeUndefined();
    expect(pluginRegistry.getManifest('unknown')).toBeUndefined();
  });

  describe('bundled plugins', () => {
    it('marks registered-bundled plugins as bundled', () => {
      pluginRegistry.registerBundled(makePlugin({ id: 'core', mediaTypes: ['movie'] }));
      expect(pluginRegistry.isBundled('core')).toBe(true);
      expect(pluginRegistry.isBundled('other')).toBe(false);
    });

    it('refuses to unregister a bundled plugin', () => {
      pluginRegistry.registerBundled(makePlugin({ id: 'core', mediaTypes: ['movie'] }));
      expect(pluginRegistry.unregister('core')).toBe(false);
      expect(pluginRegistry.getById('core')).toBeDefined();
    });
  });

  describe('unregister', () => {
    it('returns false for an unknown id', () => {
      expect(pluginRegistry.unregister('ghost')).toBe(false);
    });

    it('removes a plugin, drops its manifest, and calls close', async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      pluginRegistry.register(
        makePlugin({ id: 'p', mediaTypes: ['movie'], close }),
        { id: 'p', name: 'P', version: '1.0.0', mediaTypes: ['movie'] },
      );
      expect(pluginRegistry.unregister('p')).toBe(true);
      expect(pluginRegistry.getById('p')).toBeUndefined();
      expect(pluginRegistry.getManifest('p')).toBeUndefined();
      expect(close).toHaveBeenCalled();
    });

    it('swallows a rejected close on unregister', async () => {
      const close = vi.fn().mockRejectedValue(new Error('close failed'));
      pluginRegistry.register(makePlugin({ id: 'p', mediaTypes: ['movie'], close }));
      expect(pluginRegistry.unregister('p')).toBe(true);
      // Let the rejected close promise settle without throwing.
      await Promise.resolve();
      expect(close).toHaveBeenCalled();
    });
  });

  describe('aggregateSearchTitles', () => {
    it('tags candidates with their pluginId and respects media type filter', async () => {
      pluginRegistry.register(makePlugin({
        id: 'm1', mediaTypes: ['movie'],
        searchTitles: async () => [{ title: 'A' }],
      }));
      pluginRegistry.register(makePlugin({
        id: 's1', mediaTypes: ['show'],
        searchTitles: async () => [{ title: 'B' }],
      }));
      const movieHits = await pluginRegistry.aggregateSearchTitles('q', { mediaType: 'movie' });
      expect(movieHits).toEqual([{ title: 'A', pluginId: 'm1' }]);
    });

    it('searches all enabled plugins when no media type is given', async () => {
      pluginRegistry.register(makePlugin({
        id: 'm1', mediaTypes: ['movie'],
        searchTitles: async () => [{ title: 'A' }],
      }));
      pluginRegistry.register(makePlugin({
        id: 's1', mediaTypes: ['show'],
        searchTitles: async () => [{ title: 'B' }],
      }));
      const hits = await pluginRegistry.aggregateSearchTitles('q');
      expect(hits.map(h => h.title).sort()).toEqual(['A', 'B']);
    });

    it('logs and skips a plugin whose searchTitles throws', async () => {
      pluginRegistry.register(makePlugin({
        id: 'ok', mediaTypes: ['movie'],
        searchTitles: async () => [{ title: 'A' }],
      }));
      pluginRegistry.register(makePlugin({
        id: 'bad', mediaTypes: ['movie'],
        searchTitles: async () => { throw new Error('search blew up'); },
      }));
      const hits = await pluginRegistry.aggregateSearchTitles('q', { mediaType: 'movie' });
      expect(hits).toEqual([{ title: 'A', pluginId: 'ok' }]);
    });
  });

  describe('aggregateDiscoverByPlugin', () => {
    it('groups results per plugin and omits empty / failing plugins', async () => {
      pluginRegistry.register(makePlugin({
        id: 'with-items', name: 'WithItems', mediaTypes: ['movie'],
        discover: async () => [
          { rank: 1, title: 'X', genres: [], poster: null, url: '/x', description: '' },
        ],
      }));
      pluginRegistry.register(makePlugin({
        id: 'empty', mediaTypes: ['movie'],
        discover: async () => [],
      }));
      pluginRegistry.register(makePlugin({
        id: 'broken', mediaTypes: ['movie'],
        discover: async () => { throw new Error('boom'); },
      }));
      const grouped = await pluginRegistry.aggregateDiscoverByPlugin('movie');
      expect(grouped).toHaveLength(1);
      expect(grouped[0].pluginId).toBe('with-items');
      expect(grouped[0].pluginName).toBe('WithItems');
      expect(grouped[0].items).toHaveLength(1);
    });
  });

  describe('getCachedDiscover', () => {
    it('collects cached items, skipping null results', () => {
      pluginRegistry.register(makePlugin({
        id: 'cached', mediaTypes: ['movie'],
        getCachedDiscover: () => [
          { rank: 1, title: 'C', genres: [], poster: null, url: '/c', description: '' },
        ],
      }));
      pluginRegistry.register(makePlugin({
        id: 'no-cache', mediaTypes: ['movie'],
        getCachedDiscover: () => null,
      }));
      const items = pluginRegistry.getCachedDiscover('movie');
      expect(items.map(i => i.title)).toEqual(['C']);
    });
  });

  describe('closeAll', () => {
    it('closes every plugin that supports close and swallows failures', async () => {
      const closeOk = vi.fn().mockResolvedValue(undefined);
      const closeBad = vi.fn().mockRejectedValue(new Error('nope'));
      pluginRegistry.register(makePlugin({ id: 'a', mediaTypes: ['movie'], close: closeOk }));
      pluginRegistry.register(makePlugin({ id: 'b', mediaTypes: ['movie'], close: closeBad }));
      pluginRegistry.register(makePlugin({ id: 'c', mediaTypes: ['movie'] }));
      await expect(pluginRegistry.closeAll()).resolves.toBeUndefined();
      expect(closeOk).toHaveBeenCalled();
      expect(closeBad).toHaveBeenCalled();
    });
  });
});
