import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEntries = vi.hoisted(() => [
  { id: 1, release_name: 'Bad.Release.2024', title: 'Bad', reason: 'fake', movie_id: 5, created_at: '2026-01-01T00:00:00Z' },
]);

vi.mock('../../src/database/services/blocklist', () => ({
  getBlocklist: vi.fn(() => mockEntries),
  addBlocklistEntry: vi.fn((entry: any) => ({ id: 2, created_at: '2026-01-02T00:00:00Z', ...entry })),
  removeBlocklistEntry: vi.fn(() => true),
  clearBlocklist: vi.fn(() => 3),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import express from 'express';
import request from 'supertest';
import router from '../../src/api/routes/blocklist';
import {
  getBlocklist,
  addBlocklistEntry,
  removeBlocklistEntry,
  clearBlocklist,
} from '../../src/database/services/blocklist';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/blocklist', router);
  return app;
}

const app = makeApp();

describe('GET /api/blocklist', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the blocklist', async () => {
    const res = await request(app).get('/api/blocklist');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toHaveProperty('release_name', 'Bad.Release.2024');
    expect(getBlocklist).toHaveBeenCalled();
  });
});

describe('POST /api/blocklist', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds an entry with valid release_name', async () => {
    const res = await request(app)
      .post('/api/blocklist')
      .send({ release_name: 'New.Release', title: 'New', reason: 'spam', movie_id: 9 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', 2);
    expect(addBlocklistEntry).toHaveBeenCalledWith({
      release_name: 'New.Release',
      title: 'New',
      reason: 'spam',
      movie_id: 9,
    });
  });

  it('rejects missing release_name', async () => {
    const res = await request(app).post('/api/blocklist').send({ title: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'release_name is required');
    expect(addBlocklistEntry).not.toHaveBeenCalled();
  });

  it('rejects non-string release_name', async () => {
    const res = await request(app).post('/api/blocklist').send({ release_name: 123 });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'release_name is required');
  });
});

describe('DELETE /api/blocklist/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes an existing entry', async () => {
    vi.mocked(removeBlocklistEntry).mockReturnValueOnce(true);
    const res = await request(app).delete('/api/blocklist/5');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(removeBlocklistEntry).toHaveBeenCalledWith(5);
  });

  it('returns 404 when entry not found', async () => {
    vi.mocked(removeBlocklistEntry).mockReturnValueOnce(false);
    const res = await request(app).delete('/api/blocklist/99');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'Entry not found');
  });

  it('rejects non-numeric id', async () => {
    const res = await request(app).delete('/api/blocklist/abc');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'Invalid id');
    expect(removeBlocklistEntry).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/blocklist', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clears the blocklist and returns count', async () => {
    vi.mocked(clearBlocklist).mockReturnValueOnce(3);
    const res = await request(app).delete('/api/blocklist');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: 3 });
    expect(clearBlocklist).toHaveBeenCalled();
  });
});
