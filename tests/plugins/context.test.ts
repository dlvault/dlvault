import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSettings: Record<string, string> = {};
vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
  setSetting: vi.fn((key: string, value: string) => { mockSettings[key] = value; }),
  default: { prepare: vi.fn() },
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/scraper/rate-limit', () => ({
  waitForRateLimit: vi.fn().mockResolvedValue(undefined),
}));

import { createPluginContext } from '../../src/plugins/context';
import type { PluginManifest } from '../../src/plugins/manifest';

const baseManifest: PluginManifest = {
  id: 'test-plugin',
  name: 'Test',
  version: '1.0.0',
  mediaTypes: ['movie'],
};

describe('createPluginContext', () => {
  beforeEach(() => {
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
  });

  it('exposes always-available APIs', () => {
    const ctx = createPluginContext(baseManifest);
    expect(ctx.pluginId).toBe('test-plugin');
    expect(typeof ctx.logger.info).toBe('function');
    expect(typeof ctx.http.get).toBe('function');
    expect(typeof ctx.rateLimit).toBe('function');
    expect(ctx.QUALITY_RANK['2160p']).toBeDefined();
    expect(ctx.AUDIO_RANK['5.1']).toBeDefined();
  });

  it('namespaces plugin settings under "plugins.<id>.*"', () => {
    const ctx = createPluginContext(baseManifest);
    ctx.setPluginSetting('api_key', 'secret');
    expect(mockSettings['plugins.test-plugin.api_key']).toBe('secret');
    expect(ctx.getPluginSetting('api_key')).toBe('secret');
  });

  it('omits browser when permission not declared', () => {
    const ctx = createPluginContext(baseManifest);
    expect(ctx.browser).toBeUndefined();
  });

  it('omits secrets when permission not declared', () => {
    const ctx = createPluginContext(baseManifest);
    expect(ctx.secrets).toBeUndefined();
  });

  it('exposes browser factory when "browser" permission is declared', () => {
    const ctx = createPluginContext({ ...baseManifest, permissions: ['browser'] });
    expect(ctx.browser).toBeDefined();
    expect(typeof ctx.browser!.launch).toBe('function');
  });

  it('exposes secrets when "secrets" permission is declared', () => {
    const ctx = createPluginContext({ ...baseManifest, permissions: ['secrets'] });
    expect(ctx.secrets).toBeDefined();
    expect(typeof ctx.secrets!.get).toBe('function');
  });

  it('secrets.get reads from secret-store.* and rejects malformed keys', () => {
    mockSettings['secret-store.test-key'] = 'shared-value';
    const ctx = createPluginContext({ ...baseManifest, permissions: ['secrets'] });
    expect(ctx.secrets!.get('test-key')).toBe('shared-value');
    expect(ctx.secrets!.get('')).toBe('');
    expect(ctx.secrets!.get('../trakt.client_id')).toBe('');
  });

  it('returns a frozen context (plugins cannot mutate the host APIs)', () => {
    const ctx = createPluginContext(baseManifest);
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});
