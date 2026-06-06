import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockSettings: Record<string, string> = {};

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] ?? null),
  setSetting: vi.fn(),
  initDatabase: vi.fn(),
}));

import express from 'express';
import request from 'supertest';
import router from '../../src/api/routes/poster';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/poster', router);
  return app;
}

const app = makeApp();

describe('GET /api/poster/:imdbId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
  });

  it('rejects an invalid imdb id with 400', async () => {
    const res = await request(app).get('/api/poster/notvalid');
    expect(res.status).toBe(400);
  });

  it('serves a transparent pixel (200) when no API key is configured', async () => {
    const res = await request(app).get('/api/poster/tt1234567');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('redirects to the poster URL on a successful OMDb lookup', async () => {
    mockSettings['omdb.api_key'] = 'key';
    mockedAxios.get.mockResolvedValueOnce({
      data: { Response: 'True', Poster: 'https://img.example/poster.jpg' },
    });
    const res = await request(app).get('/api/poster/tt1111111').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://img.example/poster.jpg');
    expect(res.headers['cache-control']).toContain('max-age=86400');
  });

  it('serves a cached redirect without calling OMDb again', async () => {
    mockSettings['omdb.api_key'] = 'key';
    mockedAxios.get.mockResolvedValueOnce({
      data: { Response: 'True', Poster: 'https://img.example/cached.jpg' },
    });
    // first call populates the cache
    await request(app).get('/api/poster/tt2222222').redirects(0);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    // second call should be served from cache
    const res = await request(app).get('/api/poster/tt2222222').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://img.example/cached.jpg');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when OMDb has no poster (Poster N/A) and caches the miss', async () => {
    mockSettings['omdb.api_key'] = 'key';
    mockedAxios.get.mockResolvedValueOnce({
      data: { Response: 'True', Poster: 'N/A' },
    });
    const res = await request(app).get('/api/poster/tt3333333');
    expect(res.status).toBe(404);

    // cached negative result -> still 404, no further OMDb call
    const res2 = await request(app).get('/api/poster/tt3333333');
    expect(res2.status).toBe(404);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when OMDb response is False', async () => {
    mockSettings['omdb.api_key'] = 'key';
    mockedAxios.get.mockResolvedValueOnce({ data: { Response: 'False', Error: 'not found' } });
    const res = await request(app).get('/api/poster/tt4444444');
    expect(res.status).toBe(404);
  });

  it('returns 502 when the OMDb request throws', async () => {
    mockSettings['omdb.api_key'] = 'key';
    mockedAxios.get.mockRejectedValueOnce(new Error('network'));
    const res = await request(app).get('/api/poster/tt5555555');
    expect(res.status).toBe(502);
  });
});

/**
 * TMDb-sourced rows (Seerr's catalog) carry a posterPath but no IMDb id, so the
 * OMDb route above cannot serve them. Going through dlvault rather than putting
 * the TMDb URL in the page keeps the image-src policy intact — CSP checks the
 * initial URL, and a same-origin redirect is not re-checked.
 */
describe('GET /api/poster/tmdb/:size/:file', () => {
  it('redirects to TMDb for a valid size and filename', async () => {
    const res = await request(app).get('/api/poster/tmdb/w500/abc123.jpg');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://image.tmdb.org/t/p/w500/abc123.jpg');
  });

  it('needs no OMDb key — that is the point for Seerr users', async () => {
    const res = await request(app).get('/api/poster/tmdb/w300/x.png');
    expect(res.status).toBe(302);
  });

  it('refuses a size it does not know', async () => {
    const res = await request(app).get('/api/poster/tmdb/w9999/abc.jpg');
    expect(res.status).toBe(400);
  });

  it('refuses anything that is not a plain image filename', async () => {
    // The segment is echoed into an outbound URL, so it is rejected outright
    // rather than sanitised.
    for (const bad of ['..%2Fevil.jpg', 'abc.jpg%3Fx=1', 'abc.svg', 'ab-c.jpg']) {
      const res = await request(app).get(`/api/poster/tmdb/w500/${bad}`);
      expect(res.status, bad).toBe(400);
    }
  });

  it('caches for a day like the IMDb route', async () => {
    const res = await request(app).get('/api/poster/tmdb/w500/abc.jpg');
    expect(res.headers['cache-control']).toContain('max-age=86400');
  });
});
