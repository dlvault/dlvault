import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

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

import axios from 'axios';
import { createPluginContext, SECRET_STORE_PREFIX } from '../../src/plugins/context';
import { logger as rootLogger } from '../../src/utils/logger';
import { waitForRateLimit } from '../../src/scraper/rate-limit';
import type { PluginManifest } from '../../src/plugins/manifest';

const mockAxios = axios as unknown as { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

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

  it('omits secrets when permission not declared', () => {
    const ctx = createPluginContext(baseManifest);
    expect(ctx.secrets).toBeUndefined();
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

  it('exports the secret-store prefix used for shared secrets', () => {
    expect(SECRET_STORE_PREFIX).toBe('secret-store.');
  });

  describe('logger', () => {
    it('prefixes every level with the plugin id and forwards to the root logger', () => {
      const ctx = createPluginContext(baseManifest);
      ctx.logger.info('hi');
      ctx.logger.warn('careful');
      ctx.logger.error('boom');
      ctx.logger.debug('detail');
      expect(rootLogger.info).toHaveBeenCalledWith('[plugin:test-plugin] hi');
      expect(rootLogger.warn).toHaveBeenCalledWith('[plugin:test-plugin] careful');
      expect(rootLogger.error).toHaveBeenCalledWith('[plugin:test-plugin] boom');
      expect(rootLogger.debug).toHaveBeenCalledWith('[plugin:test-plugin] detail');
    });
  });

  describe('rateLimit', () => {
    it('delegates to the shared scraper rate limiter', async () => {
      const ctx = createPluginContext(baseManifest);
      await ctx.rateLimit();
      expect(waitForRateLimit).toHaveBeenCalled();
    });
  });

  describe('http client', () => {
    beforeEach(() => {
      mockAxios.get.mockReset();
      mockAxios.post.mockReset();
    });

    it('GET injects User-Agent + timeout and normalizes the response', async () => {
      mockAxios.get.mockResolvedValue({
        status: 200,
        data: { ok: true },
        headers: { 'content-type': 'application/json', 'x-num': 42 },
      });
      const ctx = createPluginContext(baseManifest);
      const res = await ctx.http.get<{ ok: boolean }>('https://example.com');

      expect(res.status).toBe(200);
      expect(res.data).toEqual({ ok: true });
      // Header values are coerced to strings.
      expect(res.headers['x-num']).toBe('42');

      const [url, config] = mockAxios.get.mock.calls[0];
      expect(url).toBe('https://example.com');
      expect(config.timeout).toBe(15000);
      expect(config.headers['User-Agent']).toBe('dlvault-plugin/test-plugin');
    });

    it('GET merges caller headers over the defaults', async () => {
      mockAxios.get.mockResolvedValue({ status: 204, data: null, headers: {} });
      const ctx = createPluginContext(baseManifest);
      await ctx.http.get('https://example.com', { headers: { Authorization: 'Bearer x' } });

      const config = mockAxios.get.mock.calls[0][1];
      expect(config.headers.Authorization).toBe('Bearer x');
      expect(config.headers['User-Agent']).toBe('dlvault-plugin/test-plugin');
    });

    it('POST forwards the body and normalizes the response', async () => {
      mockAxios.post.mockResolvedValue({
        status: 201,
        data: { created: 1 },
        headers: { location: '/x' },
      });
      const ctx = createPluginContext(baseManifest);
      const res = await ctx.http.post('https://example.com', { name: 'a' });

      expect(res.status).toBe(201);
      expect(res.data).toEqual({ created: 1 });
      const [url, body, config] = mockAxios.post.mock.calls[0];
      expect(url).toBe('https://example.com');
      expect(body).toEqual({ name: 'a' });
      expect(config.headers['User-Agent']).toBe('dlvault-plugin/test-plugin');
    });
  });
});
