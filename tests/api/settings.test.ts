import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockSettings: Record<string, string> = {};

const mockDb = vi.hoisted(() => ({
  prepare: vi.fn(() => ({ get: vi.fn(() => ({ count: 7 })) })),
}));

vi.mock('../../src/database/index', () => ({
  default: mockDb,
  getAllSettings: vi.fn(() => ({ ...mockSettings })),
  getSetting: vi.fn((key: string) => mockSettings[key] ?? null),
  setSetting: vi.fn((key: string, value: string) => { mockSettings[key] = value; }),
}));

vi.mock('../../src/database/encryption', () => ({
  isSensitiveKey: vi.fn((key: string) =>
    ['trakt.client_secret', 'trakt.access_token', 'trakt.refresh_token', 'jdownloader.password',
      'plex.token', 'jellyfin.api_key', 'telegram.bot_token', 'omdb.api_key'].includes(key)
    || key.startsWith('secret-store.')),
}));

const mockMovies = vi.hoisted(() => [
  { id: 1, trakt_id: 100, title: 'Existing', year: 2024 },
]);

vi.mock('../../src/database/services/movies', () => ({
  getAllMovies: vi.fn(() => mockMovies),
  getMovieByTraktId: vi.fn((id: number) => mockMovies.find(m => m.trakt_id === id) ?? null),
  addMovie: vi.fn((m: any) => ({ id: 99, ...m })),
}));

vi.mock('../../src/database/services/downloads', () => ({
  getAllDownloads: vi.fn(() => [{ id: 1, release_name: 'r' }]),
}));

const mockTrakt = vi.hoisted(() => ({
  getAuthUrl: vi.fn(() => 'https://trakt.tv/oauth/authorize?x'),
  exchangeCode: vi.fn(async () => true),
  isConfigured: vi.fn(() => true),
  isAuthenticated: vi.fn(() => true),
}));
vi.mock('../../src/services/trakt', () => ({ traktService: mockTrakt }));

const mockJD = vi.hoisted(() => ({
  isConfigured: vi.fn(() => false),
  connect: vi.fn(async () => true),
  listDevices: vi.fn(async () => [{ id: 'd1', name: 'JD', type: 'jd' }]),
  configure2CaptchaSolver: vi.fn(async () => undefined),
  restartAndUpdate: vi.fn(async () => true),
}));
vi.mock('../../src/jdownloader/index', () => ({ jdownloaderService: mockJD }));

const mockPlex = vi.hoisted(() => ({
  isConfigured: vi.fn(() => false),
  testConnection: vi.fn(async () => ({ success: true, username: 'u', movieCount: 5 })),
}));
vi.mock('../../src/services/plex', () => ({ plexService: mockPlex }));

const mockJellyfin = vi.hoisted(() => ({
  isConfigured: vi.fn(() => false),
  testConnection: vi.fn(async () => ({ success: true, serverName: 's', movieCount: 5 })),
}));
vi.mock('../../src/services/jellyfin', () => ({ jellyfinService: mockJellyfin }));

const mockPlexLib = vi.hoisted(() => ({
  isConfigured: vi.fn(() => false),
  testConnection: vi.fn(async () => ({ success: true, serverName: 's', movieCount: 5 })),
}));
vi.mock('../../src/services/plexLibrary', () => ({ plexLibraryService: mockPlexLib }));

const schedFns = vi.hoisted(() => ({
  startScheduler: vi.fn(),
  getJdMonitorState: vi.fn(() => ({ updateAvailable: false, reachable: true })),
  notifyJdUpdateTriggered: vi.fn(),
}));
vi.mock('../../src/services/scheduler', () => schedFns);

const ppFns = vi.hoisted(() => ({ startPostProcessor: vi.fn() }));
vi.mock('../../src/services/postprocess', () => ppFns);

const bwFns = vi.hoisted(() => ({ restartBandwidthScheduler: vi.fn() }));
vi.mock('../../src/services/bandwidth', () => bwFns);

const tgFns = vi.hoisted(() => ({
  startTelegramBot: vi.fn(async () => undefined),
  stopTelegramBot: vi.fn(),
  testTelegramBot: vi.fn(async () => ({ success: true, botName: 'Bot' })),
}));
vi.mock('../../src/services/telegram', () => tgFns);

const backupFns = vi.hoisted(() => ({
  createBackup: vi.fn(() => ({ filename: 'b.json', size: 10 })),
  listBackups: vi.fn(() => [{ filename: 'b.json', size: 10, created: '2026-01-01' }]),
  deleteBackup: vi.fn(() => true),
  startBackupScheduler: vi.fn(),
}));
vi.mock('../../src/services/backup', () => backupFns);

const omdbFns = vi.hoisted(() => ({
  omdbService: { testConnection: vi.fn(async () => ({ success: true })) },
}));
vi.mock('../../src/services/omdb', () => omdbFns);

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => ['file']),
}));
vi.mock('fs', () => ({ default: mockFs, ...mockFs }));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import express from 'express';
import request from 'supertest';
import router from '../../src/api/routes/settings';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', router);
  return app;
}

const app = makeApp();

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
  mockJD.isConfigured.mockReturnValue(false);
  mockJD.connect.mockResolvedValue(true);
  mockPlex.isConfigured.mockReturnValue(false);
  mockJellyfin.isConfigured.mockReturnValue(false);
  mockPlexLib.isConfigured.mockReturnValue(false);
  mockFs.existsSync.mockReturnValue(true);
  mockFs.writeFileSync.mockReturnValue(undefined);
  mockFs.readdirSync.mockReturnValue(['file']);
  delete process.env.API_TOKEN;
});

// requireApiToken reads the process-global process.env.API_TOKEN at request
// time. vitest reuses a worker process across test files, so a stray value left
// here could bleed into another file (and vice versa). Snapshot the original and
// restore it after this file so the shared env is never left dirty.
const ORIGINAL_API_TOKEN = process.env.API_TOKEN;
afterAll(() => {
  if (ORIGINAL_API_TOKEN === undefined) delete process.env.API_TOKEN;
  else process.env.API_TOKEN = ORIGINAL_API_TOKEN;
});

describe('GET /api/settings', () => {
  it('masks sensitive and secret-store values', async () => {
    mockSettings['trakt.client_secret'] = 'secret';
    mockSettings['plex.token'] = 'tok';
    mockSettings['secret-store.2captcha-api-key'] = 'cap';
    mockSettings['quality.default'] = '1080p';
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body['trakt.client_secret']).toBe('••••••••');
    expect(res.body['plex.token']).toBe('••••••••');
    expect(res.body['secret-store.2captcha-api-key']).toBe('••••••••');
    expect(res.body['quality.default']).toBe('1080p');
  });
});

describe('POST /api/settings/validate-paths', () => {
  it('reports not configured when path missing', async () => {
    const res = await request(app).post('/api/settings/validate-paths');
    expect(res.status).toBe(200);
    expect(res.body['paths.downloads'].error).toBe('Nicht konfiguriert');
  });

  it('flags windows-style paths', async () => {
    mockSettings['paths.downloads'] = 'C:\\Downloads';
    const res = await request(app).post('/api/settings/validate-paths');
    expect(res.body['paths.downloads'].error).toContain('Windows-Pfad');
  });

  it('flags non-existent paths', async () => {
    mockSettings['paths.movies'] = '/nope';
    mockFs.existsSync.mockReturnValue(false);
    const res = await request(app).post('/api/settings/validate-paths');
    expect(res.body['paths.movies'].error).toContain('existiert nicht');
  });

  it('reports writable + non-empty path as ok', async () => {
    mockSettings['paths.series'] = '/data/series';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['a', 'b']);
    const res = await request(app).post('/api/settings/validate-paths');
    expect(res.body['paths.series'].exists).toBe(true);
    expect(res.body['paths.series'].writable).toBe(true);
    expect(res.body['paths.series'].error).toBeUndefined();
  });

  it('flags non-writable path', async () => {
    mockSettings['paths.downloads'] = '/data/dl';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.writeFileSync.mockImplementation(() => { throw new Error('EACCES'); });
    const res = await request(app).post('/api/settings/validate-paths');
    expect(res.body['paths.downloads'].writable).toBe(false);
    expect(res.body['paths.downloads'].error).toContain('nicht beschreibbar');
  });

  it('flags empty directory', async () => {
    mockSettings['paths.downloads'] = '/data/dl';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);
    const res = await request(app).post('/api/settings/validate-paths');
    expect(res.body['paths.downloads'].empty).toBe(true);
    expect(res.body['paths.downloads'].error).toContain('leer');
  });
});

describe('POST /api/settings/jdownloader/update', () => {
  it('400s when JDownloader is not configured', async () => {
    mockJD.isConfigured.mockReturnValue(false);
    const res = await request(app).post('/api/settings/jdownloader/update');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('nicht konfiguriert');
    expect(mockJD.restartAndUpdate).not.toHaveBeenCalled();
  });

  it('triggers the self-update and clears the badge on success', async () => {
    mockJD.isConfigured.mockReturnValue(true);
    mockJD.restartAndUpdate.mockResolvedValueOnce(true);
    const res = await request(app).post('/api/settings/jdownloader/update');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockJD.restartAndUpdate).toHaveBeenCalled();
    expect(schedFns.notifyJdUpdateTriggered).toHaveBeenCalled();
  });

  it('400s when the update could not be started', async () => {
    mockJD.isConfigured.mockReturnValue(true);
    mockJD.restartAndUpdate.mockResolvedValueOnce(false);
    const res = await request(app).post('/api/settings/jdownloader/update');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('nicht gestartet');
  });
});

describe('PUT /api/settings', () => {
  it('rejects non-object body', async () => {
    const res = await request(app).put('/api/settings').send([1, 2]);
    expect(res.status).toBe(400);
  });

  it('saves allowed keys, skips masked/empty-sensitive/unknown/non-string', async () => {
    const { setSetting } = await import('../../src/database/index');
    const res = await request(app).put('/api/settings').send({
      'quality.default': '720p',
      'plex.token': '••••••••',      // masked → skip
      'trakt.access_token': '',       // sensitive empty → skip
      'unknown.key': 'x',             // not whitelisted → skip
      'paths.downloads': 12345,       // non-string → skip
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(setSetting).toHaveBeenCalledWith('quality.default', '720p');
    expect(setSetting).not.toHaveBeenCalledWith('plex.token', '••••••••');
    expect(setSetting).not.toHaveBeenCalledWith('unknown.key', 'x');
  });

  it('restarts scheduler when scheduler keys change', async () => {
    await request(app).put('/api/settings').send({ 'scheduler.interval_hours': '6' });
    expect(schedFns.startScheduler).toHaveBeenCalled();
  });

  it('restarts post-processor when path keys change', async () => {
    await request(app).put('/api/settings').send({ 'paths.movies': '/m' });
    expect(ppFns.startPostProcessor).toHaveBeenCalled();
  });

  it('restarts bandwidth scheduler when bandwidth keys change', async () => {
    await request(app).put('/api/settings').send({ 'bandwidth.limit': '100' });
    expect(bwFns.restartBandwidthScheduler).toHaveBeenCalled();
  });

  it('starts telegram bot when enabled+token set', async () => {
    mockSettings['telegram.enabled'] = 'true';
    mockSettings['telegram.bot_token'] = 'tok';
    await request(app).put('/api/settings').send({ 'telegram.enabled': 'true' });
    expect(tgFns.startTelegramBot).toHaveBeenCalled();
  });

  it('stops telegram bot when not enabled', async () => {
    await request(app).put('/api/settings').send({ 'telegram.allowed_chat_ids': '1' });
    expect(tgFns.stopTelegramBot).toHaveBeenCalled();
  });

  it('restarts backup scheduler when backup keys change', async () => {
    await request(app).put('/api/settings').send({ 'backup.enabled': 'true' });
    expect(backupFns.startBackupScheduler).toHaveBeenCalled();
  });

  it('pushes 2captcha key to JDownloader', async () => {
    await request(app).put('/api/settings').send({ 'secret-store.2captcha-api-key': 'realkey' });
    expect(mockJD.configure2CaptchaSolver).toHaveBeenCalledWith('realkey');
  });
});

describe('GET /api/settings/trakt/auth-url', () => {
  it('returns the auth url', async () => {
    const res = await request(app).get('/api/settings/trakt/auth-url');
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('trakt.tv');
  });
});

describe('POST /api/settings/trakt/exchange', () => {
  it('rejects missing code', async () => {
    const res = await request(app).post('/api/settings/trakt/exchange').send({});
    expect(res.status).toBe(400);
  });

  it('returns success on exchange', async () => {
    mockTrakt.exchangeCode.mockResolvedValueOnce(true);
    const res = await request(app).post('/api/settings/trakt/exchange').send({ code: 'c' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('returns 400 on failed exchange', async () => {
    mockTrakt.exchangeCode.mockResolvedValueOnce(false);
    const res = await request(app).post('/api/settings/trakt/exchange').send({ code: 'c' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/settings/trakt/status', () => {
  it('returns configured/authenticated state', async () => {
    mockSettings['trakt.username'] = 'me';
    const res = await request(app).get('/api/settings/trakt/status');
    expect(res.body).toEqual({ configured: true, authenticated: true, username: 'me' });
  });
});

describe('GET /api/settings/jdownloader/status', () => {
  it('returns not configured', async () => {
    mockJD.isConfigured.mockReturnValue(false);
    const res = await request(app).get('/api/settings/jdownloader/status');
    expect(res.body).toEqual({ configured: false, connected: false, devices: [] });
  });

  it('returns devices when configured + connected', async () => {
    mockJD.isConfigured.mockReturnValue(true);
    mockJD.connect.mockResolvedValue(true);
    const res = await request(app).get('/api/settings/jdownloader/status');
    expect(res.body.configured).toBe(true);
    expect(res.body.connected).toBe(true);
    expect(res.body.devices).toHaveLength(1);
  });

  it('returns connected:false but configured when connect fails', async () => {
    mockJD.isConfigured.mockReturnValue(true);
    mockJD.connect.mockResolvedValue(false);
    const res = await request(app).get('/api/settings/jdownloader/status');
    expect(res.body.configured).toBe(true);
    expect(res.body.connected).toBe(false);
    expect(res.body.devices).toEqual([]);
  });
});

describe('POST /api/settings/jdownloader/test', () => {
  it('returns devices on success', async () => {
    mockJD.connect.mockResolvedValue(true);
    const res = await request(app).post('/api/settings/jdownloader/test');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 400 on failure', async () => {
    mockJD.connect.mockResolvedValue(false);
    const res = await request(app).post('/api/settings/jdownloader/test');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/settings/plex/auth-pin', () => {
  it('returns pin info', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { id: 42, code: 'ABCD' } });
    const res = await request(app).post('/api/settings/plex/auth-pin');
    expect(res.status).toBe(200);
    expect(res.body.pinId).toBe(42);
    expect(res.body.authUrl).toContain('ABCD');
  });

  it('returns 500 on error', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).post('/api/settings/plex/auth-pin');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/settings/plex/auth-check', () => {
  it('rejects missing pinId', async () => {
    const res = await request(app).post('/api/settings/plex/auth-check').send({});
    expect(res.status).toBe(400);
  });

  it('stores token when present', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { authToken: 'plextoken' } });
    const res = await request(app).post('/api/settings/plex/auth-check').send({ pinId: 1 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns pending when no token yet', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: {} });
    const res = await request(app).post('/api/settings/plex/auth-check').send({ pinId: 1 });
    expect(res.body).toEqual({ success: false, pending: true });
  });

  it('returns 500 on error', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).post('/api/settings/plex/auth-check').send({ pinId: 1 });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/settings/plex/status', () => {
  it('returns disconnected when not configured', async () => {
    mockPlex.isConfigured.mockReturnValue(false);
    const res = await request(app).get('/api/settings/plex/status');
    expect(res.body).toEqual({ connected: false, username: '', movieCount: 0 });
  });

  it('returns connection result when configured', async () => {
    mockPlex.isConfigured.mockReturnValue(true);
    const res = await request(app).get('/api/settings/plex/status');
    expect(res.body.connected).toBe(true);
    expect(res.body.username).toBe('u');
  });
});

describe('POST /api/settings/plex/test', () => {
  it('returns result on success', async () => {
    mockPlex.testConnection.mockResolvedValueOnce({ success: true, username: 'u', movieCount: 1 });
    const res = await request(app).post('/api/settings/plex/test');
    expect(res.status).toBe(200);
  });

  it('returns 400 on failure', async () => {
    mockPlex.testConnection.mockResolvedValueOnce({ success: false } as any);
    const res = await request(app).post('/api/settings/plex/test');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/settings/jellyfin/status', () => {
  it('returns disconnected when not configured', async () => {
    mockJellyfin.isConfigured.mockReturnValue(false);
    const res = await request(app).get('/api/settings/jellyfin/status');
    expect(res.body).toEqual({ connected: false, serverName: '', movieCount: 0 });
  });

  it('returns result when configured', async () => {
    mockJellyfin.isConfigured.mockReturnValue(true);
    const res = await request(app).get('/api/settings/jellyfin/status');
    expect(res.body.connected).toBe(true);
  });
});

describe('POST /api/settings/jellyfin/test', () => {
  it('success', async () => {
    mockJellyfin.testConnection.mockResolvedValueOnce({ success: true, serverName: 's', movieCount: 1 });
    const res = await request(app).post('/api/settings/jellyfin/test');
    expect(res.status).toBe(200);
  });

  it('failure', async () => {
    mockJellyfin.testConnection.mockResolvedValueOnce({ success: false } as any);
    const res = await request(app).post('/api/settings/jellyfin/test');
    expect(res.status).toBe(400);
  });
});

describe('plex-library status/test', () => {
  it('status not configured', async () => {
    mockPlexLib.isConfigured.mockReturnValue(false);
    const res = await request(app).get('/api/settings/plex-library/status');
    expect(res.body.connected).toBe(false);
  });

  it('status configured', async () => {
    mockPlexLib.isConfigured.mockReturnValue(true);
    const res = await request(app).get('/api/settings/plex-library/status');
    expect(res.body.connected).toBe(true);
  });

  it('test success', async () => {
    mockPlexLib.testConnection.mockResolvedValueOnce({ success: true, serverName: 's', movieCount: 1 });
    const res = await request(app).post('/api/settings/plex-library/test');
    expect(res.status).toBe(200);
  });

  it('test failure', async () => {
    mockPlexLib.testConnection.mockResolvedValueOnce({ success: false } as any);
    const res = await request(app).post('/api/settings/plex-library/test');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/settings/backup', () => {
  it('returns 503 when no API_TOKEN set', async () => {
    const res = await request(app).get('/api/settings/backup');
    expect(res.status).toBe(503);
  });

  it('returns 401 without bearer token', async () => {
    process.env.API_TOKEN = 'secret-token';
    const res = await request(app).get('/api/settings/backup');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong token', async () => {
    process.env.API_TOKEN = 'secret-token';
    const res = await request(app).get('/api/settings/backup').set('Authorization', 'Bearer wrongtoken1');
    expect(res.status).toBe(401);
  });

  it('returns backup with valid token', async () => {
    process.env.API_TOKEN = 'secret-token';
    const res = await request(app).get('/api/settings/backup').set('Authorization', 'Bearer secret-token');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('version', 1);
    expect(res.body).toHaveProperty('movies');
    expect(res.body.activityLogCount).toBe(7);
  });

  it('returns 500 when backup throws', async () => {
    process.env.API_TOKEN = 'secret-token';
    mockDb.prepare.mockImplementationOnce(() => { throw new Error('db fail'); });
    const res = await request(app).get('/api/settings/backup').set('Authorization', 'Bearer secret-token');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/settings/restore', () => {
  // /restore is guarded by requireApiToken (it accepts a bulk settings
  // overwrite), so each test authenticates with a Bearer token.
  const TOKEN = 'restore-token';
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${TOKEN}`);

  beforeEach(() => { process.env.API_TOKEN = TOKEN; });

  it('returns 503 when API_TOKEN is not set', async () => {
    delete process.env.API_TOKEN;
    const res = await request(app).post('/api/settings/restore').send({ version: 1, settings: {} });
    expect(res.status).toBe(503);
  });

  it('returns 401 without a bearer token', async () => {
    const res = await request(app).post('/api/settings/restore').send({ version: 1, settings: {} });
    expect(res.status).toBe(401);
  });

  it('rejects invalid backup format', async () => {
    const res = await auth(request(app).post('/api/settings/restore')).send({ foo: 'bar' });
    expect(res.status).toBe(400);
  });

  it('rejects when settings not an object', async () => {
    const res = await auth(request(app).post('/api/settings/restore')).send({ version: 1, settings: [1, 2] });
    expect(res.status).toBe(400);
  });

  it('restores settings and new movies', async () => {
    const { setSetting } = await import('../../src/database/index');
    const res = await auth(request(app).post('/api/settings/restore')).send({
      version: 1,
      settings: { 'quality.default': '1080p', 'unknown.key': 'x' },
      movies: [
        { trakt_id: 100, title: 'Existing' },   // already exists → skip
        { trakt_id: 200, title: 'New Movie', year: 2025 },
        { title: 'No id' },                       // invalid → skip
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.settingsRestored).toBe(1);
    expect(res.body.moviesRestored).toBe(1);
    expect(setSetting).toHaveBeenCalledWith('quality.default', '1080p');
  });

  it('returns 500 when restore throws', async () => {
    const { setSetting } = await import('../../src/database/index');
    vi.mocked(setSetting).mockImplementationOnce(() => { throw new Error('boom'); });
    const res = await auth(request(app).post('/api/settings/restore')).send({
      version: 1,
      settings: { 'quality.default': '1080p' },
    });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/settings/telegram/status', () => {
  it('reports enabled/configured/unrestricted', async () => {
    mockSettings['telegram.enabled'] = 'true';
    mockSettings['telegram.bot_token'] = 'tok';
    const res = await request(app).get('/api/settings/telegram/status');
    expect(res.body).toEqual({ enabled: true, configured: true, unrestricted: true });
  });
});

describe('POST /api/settings/telegram/test', () => {
  it('success', async () => {
    tgFns.testTelegramBot.mockResolvedValueOnce({ success: true, botName: 'Bot' });
    const res = await request(app).post('/api/settings/telegram/test');
    expect(res.status).toBe(200);
    expect(res.body.botName).toBe('Bot');
  });

  it('failure', async () => {
    tgFns.testTelegramBot.mockResolvedValueOnce({ success: false, error: 'bad' });
    const res = await request(app).post('/api/settings/telegram/test');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/settings/omdb/test', () => {
  it('success', async () => {
    omdbFns.omdbService.testConnection.mockResolvedValueOnce({ success: true });
    const res = await request(app).post('/api/settings/omdb/test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('failure', async () => {
    omdbFns.omdbService.testConnection.mockResolvedValueOnce({ success: false, error: 'no key' } as any);
    const res = await request(app).post('/api/settings/omdb/test');
    expect(res.status).toBe(400);
  });
});

describe('backup-schedule endpoints', () => {
  it('GET returns schedule settings', async () => {
    mockSettings['backup.enabled'] = 'true';
    mockSettings['backup.interval_hours'] = '24';
    mockSettings['backup.max_backups'] = '5';
    const res = await request(app).get('/api/settings/backup-schedule');
    expect(res.body).toEqual({ enabled: 'true', interval_hours: '24', max_backups: '5' });
  });

  it('PUT updates schedule and restarts', async () => {
    const { setSetting } = await import('../../src/database/index');
    const res = await request(app).put('/api/settings/backup-schedule').send({
      enabled: 'true', interval_hours: '12', max_backups: '3',
    });
    expect(res.status).toBe(200);
    expect(setSetting).toHaveBeenCalledWith('backup.enabled', 'true');
    expect(backupFns.startBackupScheduler).toHaveBeenCalled();
  });
});

describe('POST /api/settings/backup-now', () => {
  it('returns result on success', async () => {
    backupFns.createBackup.mockReturnValueOnce({ filename: 'b.json', size: 10 });
    const res = await request(app).post('/api/settings/backup-now');
    expect(res.status).toBe(200);
    expect(res.body.filename).toBe('b.json');
  });

  it('returns 500 on failure', async () => {
    backupFns.createBackup.mockReturnValueOnce(null);
    const res = await request(app).post('/api/settings/backup-now');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/settings/backups', () => {
  it('lists backups', async () => {
    const res = await request(app).get('/api/settings/backups');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('DELETE /api/settings/backups/:filename', () => {
  it('deletes existing backup', async () => {
    backupFns.deleteBackup.mockReturnValueOnce(true);
    const res = await request(app).delete('/api/settings/backups/b.json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('returns 404 when not found', async () => {
    backupFns.deleteBackup.mockReturnValueOnce(false);
    const res = await request(app).delete('/api/settings/backups/missing.json');
    expect(res.status).toBe(404);
  });
});
