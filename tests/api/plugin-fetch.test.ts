import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';

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
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: vi.fn() }));
const invalidateMusicLibraryCache = vi.fn();
vi.mock('../../src/services/musicLibrary', () => ({
  invalidateMusicLibraryCache: () => invalidateMusicLibraryCache(),
}));

import pluginsRoutes from '../../src/api/routes/plugins';
import { pluginRegistry } from '../../src/plugins/registry';
import { listFetchJobs, _resetFetchJobs } from '../../src/services/fetchJobs';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/plugins', pluginsRoutes);
  return app;
}

/** A self-downloading plugin whose fetchRelease behaviour the test controls. */
function registerFetchPlugin(fetchRelease: any) {
  pluginRegistry.register({
    id: 'music-src',
    name: 'Music Source',
    mediaTypes: ['music'],
    findReleases: async () => ({ sourceUrl: null, releases: [] }),
    resolveLinks: async (l: any) => l,
    fetchRelease,
  } as any, {
    id: 'music-src', name: 'Music Source', version: '1.0.0', mediaTypes: ['music'],
  } as any);
}

beforeEach(() => {
  pluginRegistry._reset();
  _resetFetchJobs();
  invalidateMusicLibraryCache.mockClear();
  Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
  delete process.env.API_TOKEN;
  mockSettings['paths.downloads'] = '/downloads';
});

describe('POST /api/plugins/:id/fetch — destination confinement', () => {
  it('defaults to <downloads>/music', async () => {
    const seen: string[] = [];
    registerFetchPlugin(async (_r: any, o: any) => { seen.push(o.destDir); return { ok: true, files: ['a.flac'] }; });

    const res = await request(makeApp())
      .post('/api/plugins/music-src/fetch')
      .send({ url: 'https://example.test/album/1', title: 'Album' });

    expect(res.status).toBe(200);
    expect(seen[0]).toBe(path.join('/downloads', 'music'));
  });

  it('rejects an absolute destDir outside the downloads root', async () => {
    registerFetchPlugin(async () => ({ ok: true }));

    const res = await request(makeApp())
      .post('/api/plugins/music-src/fetch')
      .send({ url: 'https://example.test/a', destDir: '/app/data' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/downloads/i);
  });

  it('rejects a relative destDir that escapes via ..', async () => {
    registerFetchPlugin(async () => ({ ok: true }));

    const res = await request(makeApp())
      .post('/api/plugins/music-src/fetch')
      .send({ url: 'https://example.test/a', destDir: '../../etc' });

    expect(res.status).toBe(400);
  });

  it('accepts a subdirectory of the downloads root', async () => {
    const seen: string[] = [];
    registerFetchPlugin(async (_r: any, o: any) => { seen.push(o.destDir); return { ok: true }; });

    const res = await request(makeApp())
      .post('/api/plugins/music-src/fetch')
      .send({ url: 'https://example.test/a', destDir: '/downloads/music/singles' });

    expect(res.status).toBe(200);
    expect(seen[0]).toBe('/downloads/music/singles');
  });
});

describe('POST /api/plugins/:id/fetch — job lifecycle', () => {
  it('finishes the job when fetchRelease throws SYNCHRONOUSLY', async () => {
    // A plugin that is not declared `async` and validates its arguments with a
    // throw. In the background path this escaped setImmediate as an uncaught
    // exception, which the process-level handler answers by exiting.
    registerFetchPlugin(() => { throw new Error('kaputt'); });

    const res = await request(makeApp())
      .post('/api/plugins/music-src/fetch')
      .send({ url: 'https://example.test/a' });

    expect(res.status).toBe(502);
    const jobs = listFetchJobs('music-src');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('error');
    expect(jobs[0].error).toContain('kaputt');
  });

  it('rejects a second fetch for a release already downloading', async () => {
    let release: (() => void) | null = null;
    registerFetchPlugin(() => new Promise(resolve => {
      release = () => resolve({ ok: true });
    }));

    const app = makeApp();
    const first = request(app)
      .post('/api/plugins/music-src/fetch')
      .send({ url: 'https://example.test/a', title: 'Same Album', background: true });
    await first;

    const second = await request(app)
      .post('/api/plugins/music-src/fetch')
      .send({ url: 'https://example.test/a', title: 'Same Album', background: true });

    expect(second.status).toBe(409);
    expect(listFetchJobs('music-src').filter(j => j.status === 'processing')).toHaveLength(1);
    release?.();
  });

  it('drops the music library cache after a successful fetch', async () => {
    registerFetchPlugin(async () => ({ ok: true, files: ['x.flac'] }));

    await request(makeApp())
      .post('/api/plugins/music-src/fetch')
      .send({ url: 'https://example.test/a' });

    expect(invalidateMusicLibraryCache).toHaveBeenCalled();
  });

  it('does not drop the cache when the fetch failed', async () => {
    registerFetchPlugin(async () => ({ ok: false, error: 'nope' }));

    await request(makeApp())
      .post('/api/plugins/music-src/fetch')
      .send({ url: 'https://example.test/a' });

    expect(invalidateMusicLibraryCache).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/plugins/fetch-jobs/:jobId', () => {
  it('cancels a stuck job so it stops occupying the UI', async () => {
    registerFetchPlugin(() => new Promise(() => { /* never settles */ }));

    const app = makeApp();
    const started = await request(app)
      .post('/api/plugins/music-src/fetch')
      .send({ url: 'https://example.test/a', background: true });
    const jobId = started.body.jobId;
    expect(listFetchJobs('music-src')[0].status).toBe('processing');

    const res = await request(app).delete(`/api/plugins/fetch-jobs/${jobId}`);

    expect(res.status).toBe(200);
    const job = listFetchJobs('music-src')[0];
    expect(job.status).toBe('error');
    expect(job.error).toBe('Abgebrochen');
  });

  it('404s for an unknown job id', async () => {
    const res = await request(makeApp()).delete('/api/plugins/fetch-jobs/fj_999');
    expect(res.status).toBe(404);
  });
});
