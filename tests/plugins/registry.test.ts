import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSettings: Record<string, string> = {};
vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
  default: { prepare: vi.fn() },
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { pluginRegistry } from '../../src/plugins/registry';
import type { SourcePlugin } from '../../src/plugins/types';

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
});
