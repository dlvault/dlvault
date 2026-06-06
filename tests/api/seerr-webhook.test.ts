import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSettings: Record<string, string> = {};
vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] ?? ''),
  setSetting: vi.fn((key: string, value: string) => { mockSettings[key] = value; }),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const runWatchlistCheck = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../src/services/scheduler', () => ({ runWatchlistCheck }));

import webhookRouter, { getWebhookToken, WEBHOOK_TYPES, _resetWebhookState } from '../../src/api/routes/seerrWebhook';

const app = express();
app.use(express.json());
app.use('/seerr', webhookRouter);

const TOKEN = 'tok-0123456789abcdef0123456789abcdef0123456789abcd';

/** Exactly what a live Seerr 3.4.1 sends. */
const approved = {
  notification_type: 'MEDIA_APPROVED',
  subject: 'Spider-Man: Brand New Day (2026)',
  media_type: 'movie',
  tmdbId: '969681',
  tvdbId: '',
  request_id: '5',
  requestedBy: 'requester',
};

const post = (body: any, token = TOKEN) =>
  request(app).post('/seerr/webhook').set('X-Dlvault-Token', token).send(body);

describe('Seerr webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    mockSettings['seerr.webhook_enabled'] = 'true';
    mockSettings['seerr.webhook_token'] = TOKEN;
    _resetWebhookState();
  });

  afterEach(() => {
    _resetWebhookState();
    vi.useRealTimers();
  });

  describe('authentication', () => {
    it('accepts a call carrying the right token', async () => {
      const res = await post(approved);
      expect(res.status).toBe(200);
    });

    it('rejects a wrong token', async () => {
      const res = await post(approved, 'wrong');
      expect(res.status).toBe(401);
      await vi.advanceTimersByTimeAsync(5000);
      expect(runWatchlistCheck).not.toHaveBeenCalled();
    });

    it('rejects a call with no token at all', async () => {
      const res = await request(app).post('/seerr/webhook').send(approved);
      expect(res.status).toBe(401);
    });

    it('is invisible while disabled — a 404, nothing to probe', async () => {
      mockSettings['seerr.webhook_enabled'] = 'false';
      const res = await post(approved);
      expect(res.status).toBe(404);
    });

    it('mints a token on first use', () => {
      delete mockSettings['seerr.webhook_token'];
      const token = getWebhookToken();
      expect(token).toHaveLength(48);
      expect(getWebhookToken()).toBe(token);
    });
  });

  describe('acting on notifications', () => {
    it('syncs when a request is approved', async () => {
      await post(approved);
      await vi.advanceTimersByTimeAsync(2000);
      expect(runWatchlistCheck).toHaveBeenCalledTimes(1);
    });

    it('also syncs on auto-approval and on a decline', async () => {
      for (const t of ['MEDIA_AUTO_APPROVED', 'MEDIA_DECLINED']) {
        _resetWebhookState();
        vi.clearAllMocks();
        await post({ ...approved, notification_type: t });
        await vi.advanceTimersByTimeAsync(2000);
        expect(runWatchlistCheck, t).toHaveBeenCalledTimes(1);
      }
    });

    it('ignores events that mean no new work', async () => {
      for (const t of ['MEDIA_AVAILABLE', 'MEDIA_FAILED', 'MEDIA_PENDING']) {
        await post({ ...approved, notification_type: t });
      }
      await vi.advanceTimersByTimeAsync(3000);
      expect(runWatchlistCheck).not.toHaveBeenCalled();
    });

    it('does not run a watchlist sync for a viewer report', async () => {
      // A report changes no request; it goes down the issue path instead.
      const res = await post({ ...approved, notification_type: 'ISSUE_CREATED' });
      expect(res.status).toBe(200);
      await vi.advanceTimersByTimeAsync(3000);
      expect(runWatchlistCheck).not.toHaveBeenCalled();
    });

    it('answers 200 even for ignored events — a non-2xx marks the request FAILED in Seerr', async () => {
      const res = await post({ ...approved, notification_type: 'MEDIA_AVAILABLE' });
      expect(res.status).toBe(200);
    });

    it('handles the test notification without syncing', async () => {
      const res = await post({ notification_type: 'TEST_NOTIFICATION', subject: 'Testbenachrichtigung' });
      expect(res.status).toBe(200);
      await vi.advanceTimersByTimeAsync(3000);
      expect(runWatchlistCheck).not.toHaveBeenCalled();
    });

    it('survives a payload with nothing useful in it', async () => {
      const res = await post({});
      expect(res.status).toBe(200);
    });
  });

  describe('bursts', () => {
    it('collapses several approvals at once into one sync', async () => {
      // Approving five queued requests fires five webhooks within a moment;
      // each fetches the same list, so five syncs would be four too many.
      for (let i = 0; i < 5; i++) await post({ ...approved, request_id: String(i) });
      await vi.advanceTimersByTimeAsync(2000);

      expect(runWatchlistCheck).toHaveBeenCalledTimes(1);
    });

    it('runs again for an approval that arrives after the window', async () => {
      await post(approved);
      await vi.advanceTimersByTimeAsync(2000);
      await post(approved);
      await vi.advanceTimersByTimeAsync(2000);

      expect(runWatchlistCheck).toHaveBeenCalledTimes(2);
    });

    it('does not let a failing sync wedge the endpoint', async () => {
      runWatchlistCheck.mockRejectedValueOnce(new Error('boom'));
      await post(approved);
      await vi.advanceTimersByTimeAsync(2000);

      await post(approved);
      await vi.advanceTimersByTimeAsync(2000);
      expect(runWatchlistCheck).toHaveBeenCalledTimes(2);
    });
  });

  it('subscribes to approvals and to viewer reports', () => {
    // 4 | 64 | 128 — verified live: with this mask MEDIA_APPROVED arrives and
    // MEDIA_FAILED does not. Plus 256 | 2048 for ISSUE_CREATED/ISSUE_REOPENED.
    expect(WEBHOOK_TYPES).toBe(196 | 256 | 2048);
  });
});
