import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ──
const mocks = vi.hoisted(() => {
  return {
    plugins: [] as any[],
    jdConfigured: false,
    jdAddLinksResult: 'sent' as 'sent' | 'offline' | 'error',
  };
});

vi.mock('../../src/plugins/registry', () => ({
  pluginRegistry: {
    getAll: vi.fn(() => mocks.plugins),
    forMediaType: vi.fn((_type: string) => mocks.plugins),
  },
}));

vi.mock('../../src/jdownloader/index', () => ({
  jdownloaderService: {
    isConfigured: vi.fn(() => mocks.jdConfigured),
    addLinks: vi.fn(async () => mocks.jdAddLinksResult),
  },
}));

vi.mock('../../src/database/services/movies', () => ({
  addMovie: vi.fn((data: any) => ({ id: 1, status: 'found', ...data })),
  getMovieByImdbId: vi.fn(() => undefined),
  getMovieByTmdbId: vi.fn(() => undefined),
  updateMovieStatus: vi.fn(),
}));

vi.mock('../../src/database/services/downloads', () => ({
  addDownload: vi.fn(),
  updateDownloadStatusByMovieId: vi.fn(),
}));

vi.mock('../../src/database/services/activityLog', () => ({
  addLogEntry: vi.fn(),
}));

vi.mock('../../src/services/eventbus', () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import express from 'express';
import request from 'supertest';
import router from '../../src/api/routes/search';
import { pluginRegistry } from '../../src/plugins/registry';
import { jdownloaderService } from '../../src/jdownloader/index';
import * as movies from '../../src/database/services/movies';
import * as downloads from '../../src/database/services/downloads';
import { addLogEntry } from '../../src/database/services/activityLog';
import { eventBus } from '../../src/services/eventbus';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/search', router);
  return app;
}

// Flush the setImmediate background task scheduled by /download
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(() => setImmediate(resolve)));
}

const app = makeApp();

beforeEach(() => {
  vi.mocked(movies.getMovieByImdbId).mockReset().mockReturnValue(undefined as any);
  vi.mocked(movies.getMovieByTmdbId).mockReset().mockReturnValue(undefined as any);
  vi.mocked(movies.addMovie).mockReset().mockImplementation((data: any) => ({ id: 1, status: 'found', ...data }) as any);
  vi.mocked(movies.updateMovieStatus).mockReset();
  vi.mocked(downloads.addDownload).mockReset();
  vi.mocked(downloads.updateDownloadStatusByMovieId).mockReset();
  vi.mocked(addLogEntry).mockReset();
  vi.mocked(eventBus.emit).mockReset();
  vi.mocked(jdownloaderService.isConfigured).mockReset().mockImplementation(() => mocks.jdConfigured);
  vi.mocked(jdownloaderService.addLinks).mockReset().mockImplementation(async () => mocks.jdAddLinksResult);
  vi.mocked(pluginRegistry.getAll).mockReset().mockImplementation(() => mocks.plugins);
  vi.mocked(pluginRegistry.forMediaType).mockReset().mockImplementation(() => mocks.plugins);
  mocks.plugins = [];
  mocks.jdConfigured = false;
  mocks.jdAddLinksResult = true;
});

describe('POST /api/search', () => {
  it('returns 400 when query missing', async () => {
    const res = await request(app).post('/api/search').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'query is required' });
  });

  it('returns 400 when query is whitespace only', async () => {
    const res = await request(app).post('/api/search').send({ query: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns empty releases when no plugins registered', async () => {
    const res = await request(app).post('/api/search').send({ query: 'Foo' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sourceUrl: null, releases: [] });
  });

  it('returns mapped releases from the first plugin that has results', async () => {
    mocks.plugins = [
      {
        id: 'p1',
        findReleases: vi.fn(async () => ({ sourceUrl: 'http://src/1', releases: [] })),
      },
      {
        id: 'p2',
        findReleases: vi.fn(async () => ({
          sourceUrl: 'http://src/2',
          releases: [
            { title: 'Rel A', quality: '1080p', audio: 'DTS', language: 'de', size: '5GB', releaseType: 'BluRay', links: [{ hoster: 'h', url: 'http://x' }] },
          ],
        })),
      },
    ];

    const res = await request(app).post('/api/search').send({ query: 'Bar', year: 2024, mediaType: 'movie' });
    expect(res.status).toBe(200);
    // sourceUrl is set by first plugin (p1) since it returned first non-null
    expect(res.body.sourceUrl).toBe('http://src/1');
    expect(res.body.releases).toHaveLength(1);
    expect(res.body.releases[0]).toMatchObject({ index: 0, title: 'Rel A', quality: '1080p' });
    expect(pluginRegistry.forMediaType).toHaveBeenCalledWith('movie');
  });

  it('uses show media type when specified', async () => {
    mocks.plugins = [{ id: 'p', findReleases: vi.fn(async () => ({ releases: [] })) }];
    await request(app).post('/api/search').send({ query: 'Show', mediaType: 'show' });
    expect(pluginRegistry.forMediaType).toHaveBeenCalledWith('show');
  });

  it('skips plugins that throw and continues', async () => {
    mocks.plugins = [
      { id: 'bad', findReleases: vi.fn(async () => { throw new Error('boom'); }) },
      { id: 'good', findReleases: vi.fn(async () => ({ releases: [{ title: 'T', links: [] }] })) },
    ];
    const res = await request(app).post('/api/search').send({ query: 'X' });
    expect(res.status).toBe(200);
    expect(res.body.releases).toHaveLength(1);
  });

  it('returns 500 when forMediaType itself throws', async () => {
    vi.mocked(pluginRegistry.forMediaType).mockImplementation(() => { throw new Error('registry down'); });
    const res = await request(app).post('/api/search').send({ query: 'X' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Search failed' });
  });
});

describe('POST /api/search/download — validation', () => {
  it('returns 400 when title missing', async () => {
    const res = await request(app).post('/api/search/download').send({ links: [{ hoster: 'h', url: 'http://x' }] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'title is required' });
  });

  it('returns 400 when links not an array', async () => {
    const res = await request(app).post('/api/search/download').send({ title: 'T' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'links are required' });
  });

  it('returns 400 when links empty', async () => {
    const res = await request(app).post('/api/search/download').send({ title: 'T', links: [] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'links are required' });
  });

  it('returns 400 when more than 100 links', async () => {
    const links = Array.from({ length: 101 }, () => ({ hoster: 'h', url: 'http://x' }));
    const res = await request(app).post('/api/search/download').send({ title: 'T', links });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Maximum 100 links allowed' });
  });

  it('returns 400 when a link has no url', async () => {
    const res = await request(app).post('/api/search/download').send({ title: 'T', links: [{ hoster: 'h' }] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Each link must have a valid url' });
  });

  it('returns 400 when a link url is malformed', async () => {
    const res = await request(app).post('/api/search/download').send({ title: 'T', links: [{ hoster: 'h', url: 'not a url' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid URL');
  });
});

describe('POST /api/search/download — flow', () => {
  it('creates a new movie and queues when not found', async () => {
    const res = await request(app)
      .post('/api/search/download')
      .send({ title: 'New Movie', year: 2024, links: [{ hoster: 'h', url: 'http://x/a' }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'queued' });
    expect(movies.addMovie).toHaveBeenCalled();
  });

  it('promotes an existing non-downloaded movie to found', async () => {
    vi.mocked(movies.getMovieByImdbId).mockReturnValue({ id: 7, title: 'Ex', status: 'searching' } as any);
    const res = await request(app)
      .post('/api/search/download')
      .send({ title: 'Ex', imdbId: 'tt1', links: [{ hoster: 'h', url: 'http://x/a' }] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(7, 'found');
    expect(eventBus.emit).toHaveBeenCalledWith('movie:updated', expect.objectContaining({ id: 7, status: 'found' }));
  });

  it('looks up by tmdbId when imdbId not found', async () => {
    vi.mocked(movies.getMovieByTmdbId).mockReturnValue({ id: 9, title: 'TmdbMovie', status: 'pending' } as any);
    const res = await request(app)
      .post('/api/search/download')
      .send({ title: 'TmdbMovie', tmdbId: 555, links: [{ hoster: 'h', url: 'http://x/a' }] });
    expect(res.status).toBe(200);
    expect(movies.getMovieByTmdbId).toHaveBeenCalledWith(555);
  });

  it('blocks download when movie already downloaded', async () => {
    vi.mocked(movies.getMovieByImdbId).mockReturnValue({ id: 5, title: 'Dl', status: 'downloaded' } as any);
    const res = await request(app)
      .post('/api/search/download')
      .send({ title: 'Dl', imdbId: 'tt2', links: [{ hoster: 'h', url: 'http://x/a' }] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.warning).toContain('already in your library');
  });

  it('background: resolves links, sends to JD on success', async () => {
    mocks.jdConfigured = true;
    mocks.jdAddLinksResult = 'sent';
    mocks.plugins = [
      { id: 'r', resolveLinks: vi.fn(async (links: any[]) => links) },
    ];
    const res = await request(app)
      .post('/api/search/download')
      .send({ title: 'Bg', year: 2020, links: [{ hoster: 'h', url: 'http://x/a' }] });
    expect(res.status).toBe(200);
    await flush();
    expect(downloads.addDownload).toHaveBeenCalled();
    expect(jdownloaderService.addLinks).toHaveBeenCalled();
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(1, 'downloading');
    expect(downloads.updateDownloadStatusByMovieId).toHaveBeenCalledWith(1, 'sent_to_jd');
  });

  it('background: marks pending when no links resolve', async () => {
    mocks.plugins = [
      { id: 'r', resolveLinks: vi.fn(async () => []) },
    ];
    await request(app)
      .post('/api/search/download')
      .send({ title: 'Empty', links: [{ hoster: 'h', url: 'http://x/a' }] });
    await flush();
    expect(addLogEntry).toHaveBeenCalledWith(1, 'jdownloader_failed', expect.stringContaining('Link resolution failed'));
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(1, 'pending');
  });

  it('background: marks pending when JD send fails', async () => {
    mocks.jdConfigured = true;
    mocks.jdAddLinksResult = 'error';
    mocks.plugins = [{ id: 'r', resolveLinks: vi.fn(async (links: any[]) => links) }];
    await request(app)
      .post('/api/search/download')
      .send({ title: 'JdFail', links: [{ hoster: 'h', url: 'http://x/a' }] });
    await flush();
    expect(addLogEntry).toHaveBeenCalledWith(1, 'jdownloader_failed', 'Failed to send links to JDownloader');
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(1, 'pending');
  });

  it('background: handles resolver throwing (plugin error swallowed, links kept)', async () => {
    mocks.jdConfigured = true;
    mocks.plugins = [{ id: 'r', resolveLinks: vi.fn(async () => { throw new Error('resolve boom'); }) }];
    const res = await request(app)
      .post('/api/search/download')
      .send({ title: 'Err', links: [{ hoster: 'h', url: 'http://x/a' }] });
    expect(res.status).toBe(200);
    await flush();
    // resolveViaRegistry swallows plugin errors and returns original links, so JD send proceeds
    expect(jdownloaderService.addLinks).toHaveBeenCalled();
  });

  it('background: does nothing JD-related when not configured but still adds downloads', async () => {
    mocks.jdConfigured = false;
    mocks.plugins = [{ id: 'r', resolveLinks: vi.fn(async (links: any[]) => links) }];
    await request(app)
      .post('/api/search/download')
      .send({ title: 'NoJd', links: [{ hoster: 'h', url: 'http://x/a' }] });
    await flush();
    expect(downloads.addDownload).toHaveBeenCalled();
    expect(jdownloaderService.addLinks).not.toHaveBeenCalled();
  });

  it('returns 500 when getMovieByImdbId throws synchronously', async () => {
    vi.mocked(movies.getMovieByImdbId).mockImplementation(() => { throw new Error('db down'); });
    const res = await request(app)
      .post('/api/search/download')
      .send({ title: 'T', imdbId: 'tt3', links: [{ hoster: 'h', url: 'http://x/a' }] });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Download failed' });
  });
});
