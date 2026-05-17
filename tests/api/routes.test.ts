import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Hoisted mock variables available inside vi.mock factories
const mockMovies = vi.hoisted(() => [
  { id: 1, title: 'Test Movie', year: 2024, status: 'pending', trakt_id: 100, imdb_id: 'tt1234567' },
  { id: 2, title: 'Another Movie', year: 2023, status: 'downloaded', trakt_id: 101, imdb_id: 'tt7654321' },
  { id: 3, title: 'Searching Movie', year: 2025, status: 'searching', trakt_id: 102, imdb_id: 'tt9999999' },
]);

const mockLogs = vi.hoisted(() => [
  { id: 1, movie_id: 1, action: 'sync', details: 'Started sync', created_at: '2026-04-01T00:00:00Z' },
  { id: 2, movie_id: 2, action: 'download', details: 'Downloaded', created_at: '2026-04-01T01:00:00Z' },
]);

const mockDownloads = vi.hoisted(() => [
  { id: 1, movie_id: 1, release_name: 'Test.Movie.2024.1080p', status: 'pending', hoster: 'demo' },
]);

// Mock database module — must come before any app import
vi.mock('../../src/database/index', () => ({
  initDatabase: vi.fn(),
  getSetting: vi.fn(() => null),
  setSetting: vi.fn(),
  db: {},
}));

vi.mock('../../src/database/services/movies', () => ({
  getAllMovies: vi.fn(() => mockMovies),
  getMovieById: vi.fn((id: number) => mockMovies.find(m => m.id === id) ?? null),
  deleteMovie: vi.fn(),
  updateMovieStatus: vi.fn(),
  getMoviesByStatus: vi.fn(() => []),
  updateLastChecked: vi.fn(),
}));

vi.mock('../../src/database/services/activityLog', () => ({
  getRecentLogs: vi.fn((limit: number) => mockLogs.slice(0, limit)),
  getLogsByMovieId: vi.fn((movieId: number) => mockLogs.filter(l => l.movie_id === movieId)),
  addLogEntry: vi.fn(),
}));

vi.mock('../../src/database/services/downloads', () => ({
  getAllDownloads: vi.fn(() => mockDownloads),
  getDownloadsByMovieId: vi.fn((movieId: number) => mockDownloads.filter(d => d.movie_id === movieId)),
  addDownload: vi.fn(),
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

vi.mock('../../src/jdownloader/index', () => ({
  jdownloaderService: {
    isConfigured: vi.fn(() => false),
    configure2CaptchaSolver: vi.fn(() => Promise.resolve()),
    getDownloadPackages: vi.fn(() => Promise.resolve([])),
    getDownloadLinks: vi.fn(() => Promise.resolve([])),
    getLinkGrabberPackages: vi.fn(() => Promise.resolve([])),
    getSpeed: vi.fn(() => Promise.resolve(null)),
    startDownloads: vi.fn(() => Promise.resolve(true)),
    stopDownloads: vi.fn(() => Promise.resolve(true)),
    pauseDownloads: vi.fn(() => Promise.resolve(true)),
    removePackages: vi.fn(() => Promise.resolve(true)),
    getSpeedLimit: vi.fn(() => Promise.resolve(0)),
    isSpeedLimited: vi.fn(() => Promise.resolve(false)),
    setSpeedLimit: vi.fn(() => Promise.resolve()),
    setSpeedLimitEnabled: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../../src/services/trakt', () => ({
  traktService: {},
}));

vi.mock('../../src/services/plex', () => ({
  plexService: {},
}));

vi.mock('../../src/services/jellyfin', () => ({
  jellyfinService: {},
}));

vi.mock('../../src/services/plexLibrary', () => ({
  plexLibraryService: {},
}));

vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({ isConfigured: vi.fn(() => false), getMovies: vi.fn(async () => []), deleteItem: vi.fn(async () => false) })),
  getLibraryProviderType: vi.fn(() => 'jellyfin'),
  getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Prevent app.listen from actually binding a port during import
vi.mock('express', async (importOriginal) => {
  const actual = await importOriginal<typeof import('express')>();
  const originalExpress = actual.default;
  const wrapped = (...args: Parameters<typeof originalExpress>) => {
    const app = originalExpress(...args);
    app.listen = vi.fn().mockReturnValue({ close: vi.fn() }) as any;
    return app;
  };
  // Copy static methods (json, static, Router, etc.)
  Object.assign(wrapped, originalExpress);
  return { ...actual, default: wrapped };
});

import request from 'supertest';
import app from '../../src/server';

describe('GET /api/health', () => {
  it('returns 200 with correct structure', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('scheduler');
    expect(res.body).toHaveProperty('syncRunning');
    expect(res.body).toHaveProperty('memoryMB');
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.memoryMB).toBe('number');
  });

  it('reports scheduler as running (mocked)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.scheduler).toBe(true);
    expect(res.body.syncRunning).toBe(false);
  });
});

describe('GET /api/sync/status', () => {
  it('returns status breakdown by movie status', async () => {
    const res = await request(app).get('/api/sync/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      schedulerRunning: true,
      syncRunning: false,
      totalMovies: 3,
      pending: 1,
      searching: 1,
      downloaded: 1,
    });
  });
});

describe('GET /api/sync/logs', () => {
  it('returns logs with default limit', async () => {
    const res = await request(app).get('/api/sync/logs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('respects custom limit parameter', async () => {
    const { getRecentLogs } = await import('../../src/database/services/activityLog');
    const mockedGetRecentLogs = vi.mocked(getRecentLogs);

    await request(app).get('/api/sync/logs?limit=50');
    expect(mockedGetRecentLogs).toHaveBeenCalledWith(50);
  });

  it('treats limit=0 as default (0 is falsy, falls back to 100)', async () => {
    const { getRecentLogs } = await import('../../src/database/services/activityLog');
    const mockedGetRecentLogs = vi.mocked(getRecentLogs);

    await request(app).get('/api/sync/logs?limit=0');
    // Number('0') || 100 => 100, because 0 is falsy
    expect(mockedGetRecentLogs).toHaveBeenCalledWith(100);
  });

  it('clamps limit to maximum of 1000', async () => {
    const { getRecentLogs } = await import('../../src/database/services/activityLog');
    const mockedGetRecentLogs = vi.mocked(getRecentLogs);

    await request(app).get('/api/sync/logs?limit=5000');
    expect(mockedGetRecentLogs).toHaveBeenCalledWith(1000);
  });

  it('defaults to 100 for non-numeric limit', async () => {
    const { getRecentLogs } = await import('../../src/database/services/activityLog');
    const mockedGetRecentLogs = vi.mocked(getRecentLogs);

    await request(app).get('/api/sync/logs?limit=abc');
    expect(mockedGetRecentLogs).toHaveBeenCalledWith(100);
  });
});

describe('GET /api/movies', () => {
  it('returns an array of movies', async () => {
    const res = await request(app).get('/api/movies');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
    expect(res.body[0]).toHaveProperty('title', 'Test Movie');
  });
});

describe('GET /api/movies/:id', () => {
  it('returns movie with downloads and logs for valid id', async () => {
    const res = await request(app).get('/api/movies/1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('title', 'Test Movie');
    expect(res.body).toHaveProperty('downloads');
    expect(res.body).toHaveProperty('logs');
  });

  it('returns 404 for non-existent movie', async () => {
    const res = await request(app).get('/api/movies/999');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'Movie not found');
  });
});

describe('DELETE /api/movies/:id', () => {
  it('returns success for valid id', async () => {
    const { deleteMovie } = await import('../../src/database/services/movies');
    const res = await request(app).delete('/api/movies/1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(deleteMovie).toHaveBeenCalledWith(1);
  });
});

describe('DELETE /api/downloads/packages/:ids', () => {
  it('accepts valid comma-separated positive integer IDs', async () => {
    const res = await request(app).delete('/api/downloads/packages/1,2,3');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });

  it('rejects non-integer IDs', async () => {
    const res = await request(app).delete('/api/downloads/packages/abc,def');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'Invalid package IDs');
  });

  it('rejects negative IDs', async () => {
    const res = await request(app).delete('/api/downloads/packages/-1,-2');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'Invalid package IDs');
  });

  it('rejects zero as an ID', async () => {
    const res = await request(app).delete('/api/downloads/packages/0');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'Invalid package IDs');
  });

  it('rejects more than 100 IDs', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
    const res = await request(app).delete(`/api/downloads/packages/${ids}`);
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'Invalid package IDs');
  });

  it('accepts exactly 100 IDs', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1).join(',');
    const res = await request(app).delete(`/api/downloads/packages/${ids}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });
});

describe('GET /api/downloads/packages', () => {
  it('returns empty packages when JDownloader is not configured', async () => {
    const res = await request(app).get('/api/downloads/packages');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, packages: [] });
  });
});

describe('GET /api/sync/downloads', () => {
  it('returns download records from database', async () => {
    const res = await request(app).get('/api/sync/downloads');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toHaveProperty('release_name', 'Test.Movie.2024.1080p');
  });
});
