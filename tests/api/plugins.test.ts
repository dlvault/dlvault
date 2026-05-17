import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

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

import pluginsRoutes from '../../src/api/routes/plugins';
import { pluginRegistry } from '../../src/plugins/registry';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/plugins', pluginsRoutes);
  return app;
}

beforeEach(() => {
  pluginRegistry._reset();
  Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
});

describe('GET /api/plugins', () => {
  it('returns registered plugins with bundled + enabled flags', async () => {
    pluginRegistry.registerBundled({
      id: 'bundled-one',
      name: 'Bundled One',
      mediaTypes: ['movie'],
      cspDomains: ['cdn.example.com'],
      findReleases: async () => ({ sourceUrl: null, releases: [] }),
      resolveLinks: async (l) => l,
    });
    pluginRegistry.register({
      id: 'user-one',
      name: 'User One',
      mediaTypes: ['show'],
      findReleases: async () => ({ sourceUrl: null, releases: [] }),
      resolveLinks: async (l) => l,
    });
    mockSettings['plugins.user-one.enabled'] = 'false';

    const res = await request(makeApp()).get('/api/plugins');
    expect(res.status).toBe(200);
    expect(res.body.registered).toHaveLength(2);
    const bundled = res.body.registered.find((p: any) => p.id === 'bundled-one');
    expect(bundled.bundled).toBe(true);
    expect(bundled.enabled).toBe(true);
    expect(bundled.cspDomains).toContain('cdn.example.com');
    const user = res.body.registered.find((p: any) => p.id === 'user-one');
    expect(user.bundled).toBe(false);
    expect(user.enabled).toBe(false);
  });
});

describe('POST /api/plugins/install', () => {
  it('400s without a URL', async () => {
    const res = await request(makeApp())
      .post('/api/plugins/install')
      .send({ disclaimerAccepted: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url is required/);
  });

  it('400s when disclaimer is not accepted', async () => {
    const res = await request(makeApp())
      .post('/api/plugins/install')
      .send({ url: 'https://example.com/x.dlvault.js', disclaimerAccepted: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disclaimerAccepted/);
  });
});

describe('POST /api/plugins/upload', () => {
  it('400s without filename or content', async () => {
    const r1 = await request(makeApp()).post('/api/plugins/upload').send({ contentBase64: 'abc', disclaimerAccepted: true });
    expect(r1.status).toBe(400);

    const r2 = await request(makeApp()).post('/api/plugins/upload').send({ filename: 'x.dlvault.js', disclaimerAccepted: true });
    expect(r2.status).toBe(400);
  });
});

describe('POST /api/plugins/:id/enable + /disable', () => {
  it('persists the enabled flag in settings', async () => {
    pluginRegistry.register({
      id: 'toggle-me',
      name: 'T',
      mediaTypes: ['movie'],
      findReleases: async () => ({ sourceUrl: null, releases: [] }),
      resolveLinks: async (l) => l,
    });
    const off = await request(makeApp()).post('/api/plugins/toggle-me/disable');
    expect(off.body).toEqual({ success: true, enabled: false });
    expect(mockSettings['plugins.toggle-me.enabled']).toBe('false');

    const on = await request(makeApp()).post('/api/plugins/toggle-me/enable');
    expect(on.body).toEqual({ success: true, enabled: true });
    expect(mockSettings['plugins.toggle-me.enabled']).toBe('true');
  });

  it('404s for an unknown plugin id', async () => {
    const res = await request(makeApp()).post('/api/plugins/no-such/enable');
    expect(res.status).toBe(404);
  });
});
