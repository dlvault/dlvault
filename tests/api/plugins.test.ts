import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Keep InstallError + the URL/buffer install paths real (their validation is
// exercised by the install/upload tests above) but stub the three handlers that
// would otherwise touch the network or filesystem.
vi.mock('../../src/plugins/install', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/plugins/install')>();
  return {
    ...actual,
    previewPlugin: vi.fn(),
    acceptPendingPlugin: vi.fn(),
    uninstallPlugin: vi.fn(),
  };
});

import pluginsRoutes from '../../src/api/routes/plugins';
import { pluginRegistry } from '../../src/plugins/registry';
import { previewPlugin, acceptPendingPlugin, uninstallPlugin, InstallError } from '../../src/plugins/install';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/plugins', pluginsRoutes);
  return app;
}

beforeEach(() => {
  pluginRegistry._reset();
  Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
  // The install/upload/accept guard reads API_TOKEN per request — make sure a
  // token from the host environment never bleeds into the open-route tests.
  delete process.env.API_TOKEN;
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

describe('GET /api/plugins/secrets', () => {
  it('aggregates required secrets across plugins by key', async () => {
    const base = { mediaTypes: ['movie'] as const, findReleases: async () => ({ sourceUrl: null, releases: [] }), resolveLinks: async (l: any) => l };
    pluginRegistry.register(
      { id: 'a', name: 'Plugin A', ...base },
      { requiredSecrets: [{ key: '2captcha-api-key', label: '2Captcha API key', description: 'Solve captchas' }], settingsSchema: [] } as any,
    );
    pluginRegistry.register(
      { id: 'b', name: 'Plugin B', ...base },
      { requiredSecrets: [{ key: '2captcha-api-key', label: '2Captcha API key' }, { key: 'other-key', label: 'Other' }], settingsSchema: [] } as any,
    );
    mockSettings['secret-store.2captcha-api-key'] = 'filled';

    const res = await request(makeApp()).get('/api/plugins/secrets');
    expect(res.status).toBe(200);

    const shared = res.body.secrets.find((s: any) => s.key === '2captcha-api-key');
    expect(shared.requestedBy.map((r: any) => r.id)).toEqual(['a', 'b']);
    expect(shared.configured).toBe(true);

    const other = res.body.secrets.find((s: any) => s.key === 'other-key');
    expect(other.requestedBy).toHaveLength(1);
    expect(other.configured).toBe(false);
  });
});

describe('POST /api/plugins/preview', () => {
  it('400s without url or contentBase64', async () => {
    const res = await request(makeApp()).post('/api/plugins/preview').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/requires url or contentBase64/);
  });

  it('returns the parsed manifest + hash', async () => {
    vi.mocked(previewPlugin).mockResolvedValueOnce({ manifest: { id: 'x', name: 'X' }, fileSha256: 'abc123' } as any);
    const res = await request(makeApp()).post('/api/plugins/preview').send({ url: 'https://example.com/x.dlvault.js' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ manifest: { id: 'x', name: 'X' }, fileSha256: 'abc123' });
  });

  it('maps an InstallError to its status code', async () => {
    vi.mocked(previewPlugin).mockRejectedValueOnce(new InstallError('invalid manifest', 422));
    const res = await request(makeApp()).post('/api/plugins/preview').send({ contentBase64: 'zzz' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('invalid manifest');
  });
});

describe('POST /api/plugins/:id/accept', () => {
  it('accepts a pending plugin, forwarding the disclaimer flag', async () => {
    vi.mocked(acceptPendingPlugin).mockResolvedValueOnce({ manifest: { id: 'p', name: 'P' }, fileSha256: 'sha' } as any);
    const res = await request(makeApp()).post('/api/plugins/p/accept').send({ disclaimerAccepted: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(acceptPendingPlugin).toHaveBeenCalledWith('p', { disclaimerAccepted: true });
  });

  it('maps an InstallError when the disclaimer is missing', async () => {
    vi.mocked(acceptPendingPlugin).mockRejectedValueOnce(new InstallError('disclaimer required', 400));
    const res = await request(makeApp()).post('/api/plugins/p/accept').send({ disclaimerAccepted: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('disclaimer required');
  });
});

describe('API token guard on install/upload/accept', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('401s all three code-accepting routes without a token when API_TOKEN is set', async () => {
    vi.stubEnv('API_TOKEN', 'sekrit');
    const app = makeApp();

    const install = await request(app)
      .post('/api/plugins/install')
      .send({ url: 'https://example.com/x.dlvault.js', disclaimerAccepted: true });
    expect(install.status).toBe(401);

    const upload = await request(app)
      .post('/api/plugins/upload')
      .send({ filename: 'x.dlvault.js', contentBase64: 'YWJj', disclaimerAccepted: true });
    expect(upload.status).toBe(401);

    const accept = await request(app)
      .post('/api/plugins/p/accept')
      .send({ disclaimerAccepted: true });
    expect(accept.status).toBe(401);
  });

  it('401s with a wrong token', async () => {
    vi.stubEnv('API_TOKEN', 'sekrit');
    const res = await request(makeApp())
      .post('/api/plugins/install')
      .set('Authorization', 'Bearer wrong-token')
      .send({ url: 'https://example.com/x.dlvault.js', disclaimerAccepted: true });
    expect(res.status).toBe(401);
  });

  it('lets the request through with the correct Bearer token', async () => {
    vi.stubEnv('API_TOKEN', 'sekrit');
    vi.mocked(acceptPendingPlugin).mockResolvedValueOnce({ manifest: { id: 'p', name: 'P' }, fileSha256: 'sha' } as any);
    const res = await request(makeApp())
      .post('/api/plugins/p/accept')
      .set('Authorization', 'Bearer sekrit')
      .send({ disclaimerAccepted: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('keeps the trusted-LAN default: no API_TOKEN → no token required', async () => {
    // Reaches the handler's own validation (400), not the guard's 401.
    const res = await request(makeApp())
      .post('/api/plugins/install')
      .send({ disclaimerAccepted: true });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/plugins/:id', () => {
  it('uninstalls a user plugin', async () => {
    vi.mocked(uninstallPlugin).mockReturnValueOnce(undefined);
    const res = await request(makeApp()).delete('/api/plugins/some-id');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(uninstallPlugin).toHaveBeenCalledWith('some-id');
  });

  it('refuses to uninstall a bundled plugin', async () => {
    vi.mocked(uninstallPlugin).mockImplementationOnce(() => { throw new InstallError('cannot uninstall bundled plugin', 403); });
    const res = await request(makeApp()).delete('/api/plugins/bundled-id');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/bundled/);
  });
});
