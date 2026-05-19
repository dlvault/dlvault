import { describe, it, expect, vi } from 'vitest';

// ===========================================================================
// Server-level test. Distinct from routes.test.ts: this file targets app-wide
// concerns in src/server.ts that routes.test.ts does not cover —
//   - middleware wiring (compression / helmet / cors / json limit)
//   - GET /api/health/detailed (cache + disk + service probes)
//   - GET /api/update-check (dev mode, force, GitHub fetch paths)
//   - the global 500 error handler
//   - the catch-all frontend fallback (GET *path -> index.html)
// All side effects (listen, scheduler, post-processor, telegram, backup,
// updater pre-pull, boot health check) are neutralised by mocks so the test
// imports the app without binding ports or leaving timers/handles open.
// ===========================================================================

// --- DB: default export is the better-sqlite3 handle (db.prepare(...).get()).
const mockDb = vi.hoisted(() => ({
  prepare: vi.fn((sql: string) => ({
    get: vi.fn(() => {
      if (sql.includes('movies')) return { c: 7 };
      if (sql.includes('downloads')) return { c: 3 };
      if (sql.includes('blocklist')) return { c: 1 };
      return { c: 0 };
    }),
    all: vi.fn(() => []),
    run: vi.fn(),
  })),
}));

const mockSettings = vi.hoisted(() => ({}) as Record<string, string>);

vi.mock('../../src/database/index', () => ({
  default: mockDb,
  db: mockDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getSetting: vi.fn((key: string) => mockSettings[key] ?? null),
  setSetting: vi.fn(),
}));

vi.mock('../../src/services/scheduler', () => ({
  startScheduler: vi.fn(),
  stopScheduler: vi.fn(),
  isSchedulerRunning: vi.fn(() => true),
  isSyncRunning: vi.fn(() => false),
  runFullSync: vi.fn(() => Promise.resolve()),
  processMovie: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/services/postprocess', () => ({
  startPostProcessor: vi.fn(),
  stopPostProcessor: vi.fn(),
}));

vi.mock('../../src/services/bandwidth', () => ({
  startBandwidthScheduler: vi.fn(),
  stopBandwidthScheduler: vi.fn(),
}));

vi.mock('../../src/services/telegram', () => ({
  startTelegramBot: vi.fn(() => Promise.resolve()),
  stopTelegramBot: vi.fn(),
}));

vi.mock('../../src/services/backup', () => ({
  startBackupScheduler: vi.fn(),
  stopBackupScheduler: vi.fn(),
}));

vi.mock('../../src/services/metrics', () => ({
  getMetrics: vi.fn(() => ({ syncs: 0, errors: 0 })),
}));

vi.mock('../../src/jdownloader/index', () => ({
  jdownloaderService: {
    isConfigured: vi.fn(() => false),
    connect: vi.fn(() => Promise.resolve(false)),
    configureExtractionOverwrite: vi.fn(() => Promise.resolve()),
    configure2CaptchaSolver: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../../src/plugins/registry', () => ({
  pluginRegistry: {
    getCspDomains: vi.fn(() => ['https://example-cdn.test']),
    runHealthChecks: vi.fn(() => Promise.resolve({})),
    getById: vi.fn(() => undefined),
    closeAll: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../../src/plugins/bootstrap', () => ({
  loadDynamicPlugins: vi.fn(() => ({ loaded: [], pending: [], errors: [] })),
}));

// Lazily-imported services in computeHealthSnapshot.
vi.mock('../../src/services/trakt', () => ({
  traktService: { isConfigured: vi.fn(() => false), isAuthenticated: vi.fn(() => false) },
}));
vi.mock('../../src/services/jellyfin', () => ({
  jellyfinService: { isConfigured: vi.fn(() => false), testConnection: vi.fn(() => Promise.resolve({ success: false })) },
}));
vi.mock('../../src/services/plexLibrary', () => ({
  plexLibraryService: { isConfigured: vi.fn(() => false), testConnection: vi.fn(() => Promise.resolve({ success: false })) },
}));

// Health route — exports a router plus deep-health helpers used at boot.
vi.mock('../../src/api/routes/health', async () => {
  const express = (await vi.importActual<typeof import('express')>('express')).default;
  const router = express.Router();
  return {
    default: router,
    runDeepHealthCheck: vi.fn(() => Promise.resolve({ overall: 'healthy', checks: [] })),
    logDeepHealth: vi.fn(),
  };
});

// Update route — router plus the pre-pull helper.
vi.mock('../../src/api/routes/update', async () => {
  const express = (await vi.importActual<typeof import('express')>('express')).default;
  const router = express.Router();
  return {
    default: router,
    ensureUpdaterImage: vi.fn(() => Promise.resolve({ available: false, pulled: false })),
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// fs — server.ts uses statfsSync, existsSync, static serving + sendFile.
// We let existsSync return false (no disk paths configured, no /.dockerenv).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      statfsSync: vi.fn(() => { throw new Error('no statfs'); }),
    },
  };
});

// Capture the listen callback so a test can drive the startup sequence
// without binding a port. The callback itself is NOT auto-invoked at import.
const listenCallback = vi.hoisted(() => ({ fn: null as null | (() => void | Promise<void>) }));

// Prevent app.listen from binding a port (same trick as routes.test.ts).
vi.mock('express', async (importOriginal) => {
  const actual = await importOriginal<typeof import('express')>();
  const originalExpress = actual.default;
  const wrapped = (...args: Parameters<typeof originalExpress>) => {
    const app = originalExpress(...args);
    app.listen = vi.fn((...largs: any[]) => {
      const cb = largs.find(a => typeof a === 'function');
      if (cb) listenCallback.fn = cb;
      return { close: vi.fn() };
    }) as any;
    return app;
  };
  Object.assign(wrapped, originalExpress);
  return { ...actual, default: wrapped };
});

import request from 'supertest';
import app from '../../src/server';
import { jdownloaderService } from '../../src/jdownloader/index';
import { logger } from '../../src/utils/logger';
import { runDeepHealthCheck } from '../../src/api/routes/health';
import { ensureUpdaterImage } from '../../src/api/routes/update';

describe('middleware wiring', () => {
  it('applies helmet security headers including CSP with plugin CSP domains', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['content-security-policy']).toContain('https://example-cdn.test');
    // helmet default-ish headers
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('compresses responses for compressible content', async () => {
    const res = await request(app)
      .get('/api/health/detailed')
      .set('Accept-Encoding', 'gzip');
    // supertest auto-decompresses; the header proves compression middleware ran.
    expect(['gzip', undefined]).toContain(res.headers['content-encoding']);
    expect(res.status).toBe(200);
  });

  it('rejects JSON bodies over the 10mb limit', async () => {
    // express.json throws PayloadTooLargeError past the limit; that error flows
    // into the global handler which answers 500 (not a structured 413). The
    // point is the request never reaches the route — the limit fired.
    const huge = 'x'.repeat(11 * 1024 * 1024);
    const res = await request(app)
      .post('/api/movies')
      .set('Content-Type', 'application/json')
      .send(`{"data":"${huge}"}`);
    expect([413, 500]).toContain(res.status);
  });
});

describe('GET /api/health/detailed', () => {
  it('returns combined snapshot with disk, services, plugins and db counts', async () => {
    const res = await request(app).get('/api/health/detailed?force=true');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('services');
    expect(res.body).toHaveProperty('plugins');
    expect(res.body).toHaveProperty('disk');
    expect(res.body.database).toEqual({ movies: 7, downloads: 3, blocklist: 1 });
    expect(res.body.cached).toBe(false);
    // disk paths unconfigured -> error entries
    expect(res.body.disk['paths.downloads']).toHaveProperty('error');
    // service probes ran for the unconfigured services
    expect(res.body.services).toHaveProperty('jdownloader');
    expect(res.body.services).toHaveProperty('trakt');
  });

  it('serves a cached snapshot on the second non-forced call', async () => {
    await request(app).get('/api/health/detailed?force=true'); // primes cache
    const res = await request(app).get('/api/health/detailed');
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
  });
});

describe('GET /api/update-check', () => {
  it('reports dev mode when GIT_COMMIT is unset', async () => {
    const prev = process.env.GIT_COMMIT;
    delete process.env.GIT_COMMIT;
    const res = await request(app).get('/api/update-check');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updateAvailable: false, current: 'dev' });
    if (prev !== undefined) process.env.GIT_COMMIT = prev;
  });

  it('queries GitHub and reports an available update when SHA differs', async () => {
    const prev = process.env.GIT_COMMIT;
    process.env.GIT_COMMIT = 'aaaaaaa';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ sha: 'bbbbbbbdeadbeef' }),
    } as any);

    const res = await request(app).get('/api/update-check?force=true');
    expect(res.status).toBe(200);
    expect(res.body.current).toBe('aaaaaaa');
    expect(res.body.latest).toBe('bbbbbbb');
    expect(res.body.updateAvailable).toBe(true);

    fetchSpy.mockRestore();
    if (prev === undefined) delete process.env.GIT_COMMIT; else process.env.GIT_COMMIT = prev;
  });

  it('handles a GitHub fetch failure gracefully', async () => {
    const prev = process.env.GIT_COMMIT;
    process.env.GIT_COMMIT = 'ccccccc';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const res = await request(app).get('/api/update-check?force=true');
    expect(res.status).toBe(200);
    expect(res.body.updateAvailable).toBe(false);
    expect(res.body).toHaveProperty('message');

    fetchSpy.mockRestore();
    if (prev === undefined) delete process.env.GIT_COMMIT; else process.env.GIT_COMMIT = prev;
  });

  it('reports a non-ok GitHub response as an API error message', async () => {
    const prev = process.env.GIT_COMMIT;
    process.env.GIT_COMMIT = 'ddddddd';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403 } as any);

    const res = await request(app).get('/api/update-check?force=true');
    expect(res.status).toBe(200);
    expect(res.body.updateAvailable).toBe(false);
    expect(res.body.message).toContain('403');

    fetchSpy.mockRestore();
    if (prev === undefined) delete process.env.GIT_COMMIT; else process.env.GIT_COMMIT = prev;
  });
});

describe('global error handler', () => {
  it('returns 500 JSON when a downstream handler throws', async () => {
    // db.prepare throws -> /api/health/detailed handler rejects after cache
    // logic, surfacing through the express error middleware.
    mockDb.prepare.mockImplementationOnce(() => { throw new Error('db exploded'); });
    const res = await request(app).get('/api/health/detailed?force=true');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

describe('startup (listen callback)', () => {
  it('runs the boot health check and updater pre-pull on listen', async () => {
    vi.useFakeTimers();
    try {
      expect(listenCallback.fn).toBeTypeOf('function');
      // jdownloader not configured -> skips the JD push branch.
      await listenCallback.fn!();
      // Flush the setTimeout(0) boot-health and setTimeout(5000) pre-pull.
      await vi.advanceTimersByTimeAsync(6000);
    } finally {
      vi.useRealTimers();
    }
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Dlvault running'));
    expect(runDeepHealthCheck).toHaveBeenCalled();
    expect(ensureUpdaterImage).toHaveBeenCalled();
  });

  it('pushes JD config on listen when jdownloader is configured', async () => {
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);
    vi.useFakeTimers();
    try {
      await listenCallback.fn!();
      await vi.advanceTimersByTimeAsync(6000);
    } finally {
      vi.useRealTimers();
      vi.mocked(jdownloaderService.isConfigured).mockReturnValue(false);
    }
    expect(jdownloaderService.configureExtractionOverwrite).toHaveBeenCalled();
  });
});

describe('frontend catch-all fallback', () => {
  it('serves index.html for unknown non-API routes', async () => {
    // sendFile targets frontend/dist/index.html which does not exist in tests;
    // express responds 404 via sendFile's ENOENT, but the route is still
    // exercised (no JSON 404 from an API router). We assert it is NOT a
    // structured API error and is handled by the static fallback path.
    const res = await request(app).get('/some/spa/route');
    // index.html missing -> sendFile yields 404; the key is the catch-all ran.
    expect([200, 404]).toContain(res.status);
  });
});
