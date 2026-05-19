import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios');

const mockSettings: Record<string, string> = {};

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] ?? ''),
}));

const providerState = {
  configured: false,
  movies: [] as any[],
  deleteResult: false,
  getMoviesThrows: false,
};

vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({
    isConfigured: () => providerState.configured,
    getMovies: vi.fn(async () => {
      if (providerState.getMoviesThrows) throw new Error('provider down');
      return providerState.movies;
    }),
    deleteItem: vi.fn(async () => providerState.deleteResult),
  })),
  getLibraryProviderType: vi.fn(() => 'jellyfin'),
  getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));

vi.mock('../../src/database/services/movies', () => ({
  getAllMovies: vi.fn(() => []),
  updateMovieStatus: vi.fn(),
}));

vi.mock('../../src/database/services/activityLog', () => ({
  addLogEntry: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import express from 'express';
import request from 'supertest';
import axios from 'axios';
import router from '../../src/api/routes/library';
import * as libProvider from '../../src/services/libraryProvider';
import * as moviesSvc from '../../src/database/services/movies';
import { addLogEntry } from '../../src/database/services/activityLog';

const mockedAxios = vi.mocked(axios, true);

const app = express();
app.use(express.json());
app.use('/api/library', router);

beforeEach(() => {
  Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
  providerState.configured = false;
  providerState.movies = [];
  providerState.deleteResult = false;
  providerState.getMoviesThrows = false;
  vi.mocked(libProvider.getLibraryProviderType).mockReset().mockReturnValue('jellyfin');
  vi.mocked(libProvider.getLibraryProviderName).mockReset().mockReturnValue('Jellyfin');
  vi.mocked(moviesSvc.getAllMovies).mockReset().mockReturnValue([] as any);
  vi.mocked(moviesSvc.updateMovieStatus).mockReset();
  vi.mocked(addLogEntry).mockReset();
  mockedAxios.get.mockReset();
});

describe('GET /api/library', () => {
  it('400 for invalid type parameter', async () => {
    const res = await request(app).get('/api/library?type=bogus');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid type parameter' });
  });

  it('returns items with poster URLs and source none when not configured', async () => {
    providerState.movies = [
      { id: 'a', mediaType: 'movie', name: 'M', imageTag: 'tag1' },
      { id: 'b', mediaType: 'show', name: 'S' },
    ];
    const res = await request(app).get('/api/library');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.source).toBe('none');
    expect(res.body.items[0].posterUrl).toBe('/api/library/a/poster?tag=tag1');
    expect(res.body.items[1].posterUrl).toBeNull();
  });

  it('filters by type and reports provider type when configured', async () => {
    providerState.configured = true;
    providerState.movies = [
      { id: 'a', mediaType: 'movie', name: 'M' },
      { id: 'b', mediaType: 'show', name: 'S' },
    ];
    const res = await request(app).get('/api/library?type=movie');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].mediaType).toBe('movie');
    expect(res.body.source).toBe('jellyfin');
  });

  it('500 when provider getMovies throws', async () => {
    providerState.getMoviesThrows = true;
    const res = await request(app).get('/api/library');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load library' });
  });
});

describe('GET /api/library/:id/poster', () => {
  it('400 for invalid id', async () => {
    const res = await request(app).get('/api/library/has spaces/poster');
    expect(res.status).toBe(400);
  });

  it('jellyfin: 404 when not configured', async () => {
    vi.mocked(libProvider.getLibraryProviderType).mockReturnValue('jellyfin');
    const res = await request(app).get('/api/library/abc/poster');
    expect(res.status).toBe(404);
  });

  it('jellyfin: proxies image with token', async () => {
    vi.mocked(libProvider.getLibraryProviderType).mockReturnValue('jellyfin');
    mockSettings['jellyfin.url'] = 'http://jelly/';
    mockSettings['jellyfin.api_key'] = 'key';
    mockedAxios.get.mockResolvedValue({ data: Buffer.from('img'), headers: { 'content-type': 'image/png' } } as any);
    const res = await request(app).get('/api/library/abc/poster?tag=deadbeef');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['etag']).toBe('"deadbeef"');
    const calledUrl = mockedAxios.get.mock.calls[0][0] as string;
    expect(calledUrl).toContain('http://jelly/Items/abc/Images/Primary');
  });

  it('jellyfin: 400 on invalid tag', async () => {
    vi.mocked(libProvider.getLibraryProviderType).mockReturnValue('jellyfin');
    mockSettings['jellyfin.url'] = 'http://jelly';
    mockSettings['jellyfin.api_key'] = 'key';
    const res = await request(app).get('/api/library/abc/poster?tag=' + encodeURIComponent('bad/tag'));
    expect(res.status).toBe(400);
  });

  it('plex: 404 when not configured', async () => {
    vi.mocked(libProvider.getLibraryProviderType).mockReturnValue('plex');
    const res = await request(app).get('/api/library/abc/poster');
    expect(res.status).toBe(404);
  });

  it('plex: uses thumb path when tag starts with /', async () => {
    vi.mocked(libProvider.getLibraryProviderType).mockReturnValue('plex');
    mockSettings['plex.server_url'] = 'http://plex/';
    mockSettings['plex.token'] = 'tok';
    mockedAxios.get.mockResolvedValue({ data: Buffer.from('img'), headers: {} } as any);
    const res = await request(app).get('/api/library/abc/poster?tag=' + encodeURIComponent('/library/metadata/123/thumb/456'));
    expect(res.status).toBe(200);
    const calledUrl = mockedAxios.get.mock.calls[0][0] as string;
    expect(calledUrl).toBe('http://plex/library/metadata/123/thumb/456');
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('plex: 400 on invalid thumb path', async () => {
    vi.mocked(libProvider.getLibraryProviderType).mockReturnValue('plex');
    mockSettings['plex.server_url'] = 'http://plex';
    mockSettings['plex.token'] = 'tok';
    const res = await request(app).get('/api/library/abc/poster?tag=' + encodeURIComponent('/etc/passwd'));
    expect(res.status).toBe(400);
  });

  it('plex: falls back to default thumb url when tag does not start with /', async () => {
    vi.mocked(libProvider.getLibraryProviderType).mockReturnValue('plex');
    mockSettings['plex.server_url'] = 'http://plex';
    mockSettings['plex.token'] = 'tok';
    mockedAxios.get.mockResolvedValue({ data: Buffer.from('img'), headers: {} } as any);
    const res = await request(app).get('/api/library/abc/poster');
    expect(res.status).toBe(200);
    const calledUrl = mockedAxios.get.mock.calls[0][0] as string;
    expect(calledUrl).toBe('http://plex/library/metadata/abc/thumb');
  });

  it('404 when axios fetch fails', async () => {
    vi.mocked(libProvider.getLibraryProviderType).mockReturnValue('jellyfin');
    mockSettings['jellyfin.url'] = 'http://jelly';
    mockSettings['jellyfin.api_key'] = 'key';
    mockedAxios.get.mockRejectedValue(new Error('network'));
    const res = await request(app).get('/api/library/abc/poster');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/library/:id', () => {
  it('400 for id over 64 chars', async () => {
    const longId = 'a'.repeat(65);
    const res = await request(app).delete('/api/library/' + longId);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid item ID' });
  });

  it('returns success when provider deletes', async () => {
    providerState.deleteResult = true;
    const res = await request(app).delete('/api/library/abc');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('400 when provider returns false', async () => {
    providerState.deleteResult = false;
    const res = await request(app).delete('/api/library/abc');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Delete failed' });
  });

  it('500 when provider throws', async () => {
    vi.mocked(libProvider.getLibraryProvider).mockImplementationOnce(() => ({
      isConfigured: () => true,
      getMovies: vi.fn(),
      deleteItem: vi.fn(async () => { throw new Error('boom'); }),
    }) as any);
    const res = await request(app).delete('/api/library/abc');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Delete failed' });
  });
});

describe('POST /api/library/import', () => {
  it('400 when provider not configured', async () => {
    providerState.configured = false;
    const res = await request(app).post('/api/library/import');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not configured');
  });

  it('imports matches and counts categories', async () => {
    providerState.configured = true;
    providerState.movies = [
      { name: 'Match Imdb', imdbId: 'tt1', year: 2020 },
      { name: 'Already', imdbId: 'tt2', year: 2021 },
      { name: 'Nope', imdbId: 'tt999', year: 1999 },
      { name: 'By Tmdb', tmdbId: '555', year: 2022 },
      { name: 'By Title', year: 2023 },
    ];
    vi.mocked(moviesSvc.getAllMovies).mockReturnValue([
      { id: 1, imdb_id: 'tt1', title: 'Match Imdb', status: 'pending', year: 2020 },
      { id: 2, imdb_id: 'tt2', title: 'Already', status: 'downloaded', year: 2021 },
      { id: 3, tmdb_id: 555, title: 'By Tmdb', status: 'pending', year: 2022 },
      { id: 4, imdb_id: null, tmdb_id: null, title: 'By Title', status: 'searching', year: 2023 },
    ] as any);

    const res = await request(app).post('/api/library/import');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ imported: 3, alreadyImported: 1, noMatch: 1 });
    expect(moviesSvc.updateMovieStatus).toHaveBeenCalledWith(1, 'downloaded');
    expect(addLogEntry).toHaveBeenCalled();
  });

  it('500 when getMovies throws', async () => {
    providerState.configured = true;
    providerState.getMoviesThrows = true;
    const res = await request(app).post('/api/library/import');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Library import failed' });
  });
});

describe('POST /api/library/scan', () => {
  it('400 when provider not configured', async () => {
    providerState.configured = false;
    const res = await request(app).post('/api/library/scan');
    expect(res.status).toBe(400);
  });

  it('dry-run counts without updating', async () => {
    providerState.configured = true;
    providerState.movies = [
      { name: 'Match', imdbId: 'tt1', year: 2020 },
      { name: 'Done', imdbId: 'tt2', year: 2021 },
      { name: 'Nope', imdbId: 'tt9', year: 1999 },
    ];
    vi.mocked(moviesSvc.getAllMovies).mockReturnValue([
      { id: 1, imdb_id: 'tt1', title: 'Match', status: 'pending', year: 2020 },
      { id: 2, imdb_id: 'tt2', title: 'Done', status: 'downloaded', year: 2021 },
    ] as any);
    const res = await request(app).post('/api/library/scan');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ imported: 1, alreadyImported: 1, noMatch: 1 });
    expect(moviesSvc.updateMovieStatus).not.toHaveBeenCalled();
  });

  it('500 when getMovies throws', async () => {
    providerState.configured = true;
    providerState.getMoviesThrows = true;
    const res = await request(app).post('/api/library/scan');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Library scan failed' });
  });
});
