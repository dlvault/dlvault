import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockJD = vi.hoisted(() => ({
  isConfigured: vi.fn(() => false),
  getDownloadPackages: vi.fn(async () => [] as any[]),
  getExtractionQueue: vi.fn(async () => [] as any[]),
  getDownloadLinks: vi.fn(async () => [] as any[]),
  getLinkGrabberPackages: vi.fn(async () => [] as any[]),
  getSpeed: vi.fn(async () => null as any),
  startDownloads: vi.fn(async () => true),
  stopDownloads: vi.fn(async () => true),
  pauseDownloads: vi.fn(async () => true),
  removePackages: vi.fn(async () => true),
  removeLinkGrabberPackages: vi.fn(async () => true),
  moveLinkGrabberToDownloadlist: vi.fn(async () => true),
  getSpeedLimit: vi.fn(async () => 0),
  isSpeedLimited: vi.fn(async () => false),
  setSpeedLimit: vi.fn(async () => undefined),
  setSpeedLimitEnabled: vi.fn(async () => undefined),
}));

vi.mock('../../src/jdownloader/index', () => ({
  jdownloaderService: mockJD,
}));

const mockFsPromises = vi.hoisted(() => ({
  readdir: vi.fn(async () => [] as any[]),
  stat: vi.fn(async () => ({ mtimeMs: Date.now() })),
  access: vi.fn(async () => undefined),
}));

vi.mock('fs', () => ({
  default: { promises: mockFsPromises },
  promises: mockFsPromises,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import express from 'express';
import request from 'supertest';
import router from '../../src/api/routes/downloads';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/downloads', router);
  return app;
}

const app = makeApp();

beforeEach(() => {
  // mockReset clears the queued *Once implementations too (clearAllMocks does
  // not), so leftover mockRejectedValueOnce / mockResolvedValueOnce from a
  // prior test cannot leak into the next one.
  Object.values(mockJD).forEach(fn => fn.mockReset());
  Object.values(mockFsPromises).forEach(fn => fn.mockReset());

  mockJD.isConfigured.mockReturnValue(false);
  mockJD.getDownloadPackages.mockResolvedValue([]);
  mockJD.getExtractionQueue.mockResolvedValue([]);
  mockJD.getDownloadLinks.mockResolvedValue([]);
  mockJD.getLinkGrabberPackages.mockResolvedValue([]);
  mockJD.getSpeed.mockResolvedValue(null);
  mockJD.startDownloads.mockResolvedValue(true);
  mockJD.stopDownloads.mockResolvedValue(true);
  mockJD.pauseDownloads.mockResolvedValue(true);
  mockJD.removePackages.mockResolvedValue(true);
  mockJD.removeLinkGrabberPackages.mockResolvedValue(true);
  mockJD.moveLinkGrabberToDownloadlist.mockResolvedValue(true);
  mockJD.getSpeedLimit.mockResolvedValue(0);
  mockJD.isSpeedLimited.mockResolvedValue(false);
  mockJD.setSpeedLimit.mockResolvedValue(undefined);
  mockJD.setSpeedLimitEnabled.mockResolvedValue(undefined);

  mockFsPromises.readdir.mockResolvedValue([]);
  mockFsPromises.access.mockResolvedValue(undefined);
  mockFsPromises.stat.mockResolvedValue({ mtimeMs: Date.now() });
});

describe('GET /api/downloads/packages', () => {
  it('returns disconnected when JD is not configured', async () => {
    const res = await request(app).get('/api/downloads/packages');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, packages: [] });
  });

  it('returns packages when configured', async () => {
    mockJD.isConfigured.mockReturnValue(true);
    mockJD.getDownloadPackages.mockResolvedValue([
      { uuid: 1, name: 'Pkg', finished: false, saveTo: '/dl/pkg' },
    ]);
    const res = await request(app).get('/api/downloads/packages');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.packages).toHaveLength(1);
  });

  it('annotates isExtracting from the extraction queue', async () => {
    mockJD.isConfigured.mockReturnValue(true);
    mockJD.getDownloadPackages.mockResolvedValue([
      { uuid: 1, name: 'MyMovie', finished: true, saveTo: '/dl/mymovie' },
    ]);
    mockJD.getExtractionQueue.mockResolvedValue([
      { archiveId: '/dl/mymovie/file.rar', controllerStatus: 'EXTRACTING', progress: 42 },
    ]);
    const res = await request(app).get('/api/downloads/packages');
    expect(res.body.packages[0].isExtracting).toBe(true);
    expect(res.body.packages[0].extractionProgress).toBe(42);
  });

  it('flags isMoved when finished package saveTo no longer exists', async () => {
    mockJD.isConfigured.mockReturnValue(true);
    mockJD.getDownloadPackages.mockResolvedValue([
      { uuid: 1, name: 'Gone', finished: true, saveTo: '/dl/gone' },
    ]);
    mockJD.getExtractionQueue.mockResolvedValue([]);
    mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));
    const res = await request(app).get('/api/downloads/packages');
    expect(res.body.packages[0].isMoved).toBe(true);
  });

  it('detects extraction temp files via filesystem scan', async () => {
    mockJD.isConfigured.mockReturnValue(true);
    mockJD.getDownloadPackages.mockResolvedValue([
      { uuid: 1, name: 'Scan', finished: true, saveTo: '/dl/scan' },
    ]);
    mockJD.getExtractionQueue.mockResolvedValue([]);
    mockFsPromises.access.mockResolvedValue(undefined);
    mockFsPromises.readdir.mockResolvedValueOnce([
      { name: 'movie.extracting', isDirectory: () => false },
    ] as any);
    const res = await request(app).get('/api/downloads/packages');
    expect(res.body.packages[0].isExtracting).toBe(true);
  });

  it('detects extraction marker inside a subdirectory', async () => {
    mockJD.isConfigured.mockReturnValue(true);
    mockJD.getDownloadPackages.mockResolvedValue([
      { uuid: 1, name: 'Sub', finished: true, saveTo: '/dl/sub' },
    ]);
    mockJD.getExtractionQueue.mockResolvedValue([]);
    mockFsPromises.access.mockResolvedValue(undefined);
    // top-level dir contains one subdirectory
    mockFsPromises.readdir
      .mockResolvedValueOnce([{ name: 'inner', isDirectory: () => true }] as any)
      // subdirectory contains an extraction marker
      .mockResolvedValueOnce([{ name: 'x.tmp', isDirectory: () => false }] as any);
    const res = await request(app).get('/api/downloads/packages');
    expect(res.body.packages[0].isExtracting).toBe(true);
  });

  it('detects a recently-modified archive part', async () => {
    mockJD.isConfigured.mockReturnValue(true);
    mockJD.getDownloadPackages.mockResolvedValue([
      { uuid: 1, name: 'Parts', finished: true, saveTo: '/dl/parts' },
    ]);
    mockJD.getExtractionQueue.mockResolvedValue([]);
    mockFsPromises.access.mockResolvedValue(undefined);
    mockFsPromises.readdir.mockResolvedValueOnce([
      { name: 'movie.part01', isDirectory: () => false },
    ] as any);
    mockFsPromises.stat.mockResolvedValueOnce({ mtimeMs: Date.now() } as any);
    const res = await request(app).get('/api/downloads/packages');
    expect(res.body.packages[0].isExtracting).toBe(true);
  });

  it('ignores old archive parts (no extraction flag)', async () => {
    mockJD.isConfigured.mockReturnValue(true);
    mockJD.getDownloadPackages.mockResolvedValue([
      { uuid: 1, name: 'Old', finished: true, saveTo: '/dl/old' },
    ]);
    mockJD.getExtractionQueue.mockResolvedValue([]);
    mockFsPromises.access.mockResolvedValue(undefined);
    mockFsPromises.readdir.mockResolvedValueOnce([
      { name: 'movie.r01', isDirectory: () => false },
    ] as any);
    mockFsPromises.stat.mockResolvedValueOnce({ mtimeMs: Date.now() - 10 * 60 * 1000 } as any);
    const res = await request(app).get('/api/downloads/packages');
    expect(res.body.packages[0].isExtracting).toBeUndefined();
  });

  it('returns disconnected when JD throws', async () => {
    mockJD.isConfigured.mockReturnValue(true);
    mockJD.getDownloadPackages.mockRejectedValue(new Error('boom'));
    const res = await request(app).get('/api/downloads/packages');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, packages: [] });
  });
});

describe('GET /api/downloads/links', () => {
  it('returns links', async () => {
    mockJD.getDownloadLinks.mockResolvedValue([{ uuid: 7 }]);
    const res = await request(app).get('/api/downloads/links');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ uuid: 7 }]);
  });

  it('returns 500 on error', async () => {
    mockJD.getDownloadLinks.mockRejectedValue(new Error('x'));
    const res = await request(app).get('/api/downloads/links');
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});

describe('GET /api/downloads/linkgrabber', () => {
  it('returns packages', async () => {
    mockJD.getLinkGrabberPackages.mockResolvedValue([{ uuid: 3 }]);
    const res = await request(app).get('/api/downloads/linkgrabber');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ uuid: 3 }]);
  });

  it('returns 500 on error', async () => {
    mockJD.getLinkGrabberPackages.mockRejectedValue(new Error('x'));
    const res = await request(app).get('/api/downloads/linkgrabber');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/downloads/state', () => {
  it('returns state', async () => {
    mockJD.getSpeed.mockResolvedValue(1234);
    const res = await request(app).get('/api/downloads/state');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 1234 });
  });

  it('returns 500 on error', async () => {
    mockJD.getSpeed.mockRejectedValue(new Error('x'));
    const res = await request(app).get('/api/downloads/state');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/downloads/start', () => {
  it('starts downloads', async () => {
    const res = await request(app).post('/api/downloads/start');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('returns 500 on error', async () => {
    mockJD.startDownloads.mockRejectedValue(new Error('x'));
    const res = await request(app).post('/api/downloads/start');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/downloads/stop', () => {
  it('stops downloads', async () => {
    const res = await request(app).post('/api/downloads/stop');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('returns 500 on error', async () => {
    mockJD.stopDownloads.mockRejectedValue(new Error('x'));
    const res = await request(app).post('/api/downloads/stop');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/downloads/pause', () => {
  it('pauses by default (no body)', async () => {
    const res = await request(app).post('/api/downloads/pause').send({});
    expect(res.status).toBe(200);
    expect(mockJD.pauseDownloads).toHaveBeenCalledWith(true);
  });

  it('unpauses when pause:false', async () => {
    const res = await request(app).post('/api/downloads/pause').send({ pause: false });
    expect(res.status).toBe(200);
    expect(mockJD.pauseDownloads).toHaveBeenCalledWith(false);
  });

  it('returns 500 on error', async () => {
    mockJD.pauseDownloads.mockRejectedValue(new Error('x'));
    const res = await request(app).post('/api/downloads/pause').send({});
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/downloads/packages/:ids', () => {
  it('removes valid ids', async () => {
    const res = await request(app).delete('/api/downloads/packages/1,2,3');
    expect(res.status).toBe(200);
    expect(mockJD.removePackages).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('rejects invalid ids', async () => {
    const res = await request(app).delete('/api/downloads/packages/abc');
    expect(res.status).toBe(400);
  });

  it('returns 500 when service throws', async () => {
    mockJD.removePackages.mockRejectedValue(new Error('x'));
    const res = await request(app).delete('/api/downloads/packages/1');
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/downloads/linkgrabber/:ids', () => {
  it('removes valid ids', async () => {
    const res = await request(app).delete('/api/downloads/linkgrabber/4,5');
    expect(res.status).toBe(200);
    expect(mockJD.removeLinkGrabberPackages).toHaveBeenCalledWith([4, 5]);
  });

  it('rejects invalid ids', async () => {
    const res = await request(app).delete('/api/downloads/linkgrabber/0');
    expect(res.status).toBe(400);
  });

  it('returns 500 when service throws', async () => {
    mockJD.removeLinkGrabberPackages.mockRejectedValue(new Error('x'));
    const res = await request(app).delete('/api/downloads/linkgrabber/1');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/downloads/linkgrabber/move', () => {
  it('moves valid ids', async () => {
    const res = await request(app).post('/api/downloads/linkgrabber/move').send({ ids: [1, 2] });
    expect(res.status).toBe(200);
    expect(mockJD.moveLinkGrabberToDownloadlist).toHaveBeenCalledWith([1, 2]);
  });

  it('rejects empty/invalid ids', async () => {
    const res = await request(app).post('/api/downloads/linkgrabber/move').send({ ids: [] });
    expect(res.status).toBe(400);
  });

  it('rejects non-array ids', async () => {
    const res = await request(app).post('/api/downloads/linkgrabber/move').send({ ids: 'nope' });
    expect(res.status).toBe(400);
  });

  it('returns 500 when service throws', async () => {
    mockJD.moveLinkGrabberToDownloadlist.mockRejectedValue(new Error('x'));
    const res = await request(app).post('/api/downloads/linkgrabber/move').send({ ids: [1] });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/downloads/speed-limit', () => {
  it('returns speed limit', async () => {
    mockJD.getSpeedLimit.mockResolvedValue(500);
    mockJD.isSpeedLimited.mockResolvedValue(true);
    const res = await request(app).get('/api/downloads/speed-limit');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, limitKbps: 500 });
  });

  it('returns 500 on error', async () => {
    mockJD.getSpeedLimit.mockRejectedValue(new Error('x'));
    const res = await request(app).get('/api/downloads/speed-limit');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/downloads/speed-limit', () => {
  it('sets limit and enabled', async () => {
    const res = await request(app)
      .post('/api/downloads/speed-limit')
      .send({ enabled: true, limitKbps: 1000 });
    expect(res.status).toBe(200);
    expect(mockJD.setSpeedLimit).toHaveBeenCalledWith(1000);
    expect(mockJD.setSpeedLimitEnabled).toHaveBeenCalledWith(true);
  });

  it('ignores non-number limit and non-boolean enabled', async () => {
    const res = await request(app)
      .post('/api/downloads/speed-limit')
      .send({ enabled: 'yes', limitKbps: 'fast' });
    expect(res.status).toBe(200);
    expect(mockJD.setSpeedLimit).not.toHaveBeenCalled();
    expect(mockJD.setSpeedLimitEnabled).not.toHaveBeenCalled();
  });

  it('returns 500 on error', async () => {
    mockJD.setSpeedLimit.mockRejectedValue(new Error('x'));
    const res = await request(app)
      .post('/api/downloads/speed-limit')
      .send({ limitKbps: 5 });
    expect(res.status).toBe(500);
  });
});
