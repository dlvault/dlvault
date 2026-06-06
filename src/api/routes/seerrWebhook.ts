import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { getSetting, setSetting } from '../../database/index';
import { logger } from '../../utils/logger';

/**
 * Push endpoint for Seerr's webhook agent.
 *
 * Without it dlvault learns about an approved request on its next two-minute
 * poll; with it, within a second. The payload template is ours to define, and
 * the shape below was confirmed against a live Seerr 3.4.1:
 *
 *   {"notification_type":"MEDIA_APPROVED","subject":"Spider-Man: Brand New Day (2026)",
 *    "media_type":"movie","tmdbId":"969681","tvdbId":"","media_status":"PROCESSING",
 *    "request_id":"5","requestedBy":"<user>"}
 *
 * `notification_type` is a *name*, not a bitmask value, so dlvault can filter on
 * something stable rather than tracking Seerr's enum numbering.
 *
 * Deliberately, the payload is treated only as a wake-up signal: it triggers the
 * ordinary watchlist pass, which fetches the authoritative request list from
 * Seerr itself. Nothing here can inject a title. A spoofed or malformed call
 * costs at most one sync, and the tested pull path stays the single way a
 * request becomes a tracked download.
 */

/** Notification names that mean "there is work to do". */
const ACTIONABLE = new Set(['MEDIA_APPROVED', 'MEDIA_AUTO_APPROVED', 'MEDIA_DECLINED']);

/** Reports worth reacting to immediately rather than on the next sweep. */
const ISSUE_EVENTS = new Set(['ISSUE_CREATED', 'ISSUE_REOPENED']);

/**
 * Bitmask Seerr stores for the subscription. 4 = approved, 64 = declined,
 * 128 = auto-approved — verified live: with this mask MEDIA_APPROVED arrives and
 * unrelated events (MEDIA_FAILED, MEDIA_AVAILABLE) do not.
 */
export const WEBHOOK_TYPES = 196 | 256 | 2048;   // + ISSUE_CREATED, ISSUE_REOPENED

/** Coalescing window: an approval burst should cost one sync, not one each. */
const COALESCE_MS = 1500;

let pending: NodeJS.Timeout | null = null;
let running = false;

export function getWebhookToken(): string {
  let token = getSetting('seerr.webhook_token');
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    setSetting('seerr.webhook_token', token);
    logger.info('Generated token for the Seerr webhook endpoint');
  }
  return token;
}

/** Test seam — lets a test observe the coalescing without a real scheduler. */
export function _resetWebhookState(): void {
  if (pending) clearTimeout(pending);
  pending = null;
  running = false;
}

function scheduleSync(): void {
  if (pending) return;                 // already queued within the window
  pending = setTimeout(async () => {
    pending = null;
    if (running) return;               // a pass is in flight; it will see the change
    running = true;
    try {
      const { runWatchlistCheck } = await import('../../services/scheduler');
      await runWatchlistCheck();
    } catch (error: any) {
      logger.error(`Seerr webhook: watchlist pass failed: ${error?.message || error}`);
    } finally {
      running = false;
    }
  }, COALESCE_MS);
  // Never hold the process open for a coalescing timer.
  if (typeof pending.unref === 'function') pending.unref();
}

const router = Router();

router.post('/webhook', (req: Request, res: Response) => {
  if (getSetting('seerr.webhook_enabled') !== 'true') {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const provided = String(req.headers['x-dlvault-token'] || '');
  const expected = getWebhookToken();
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const type = String(req.body?.notification_type || '');

  // Answer 200 for everything authenticated, including types we ignore: Seerr
  // marks a request FAILED on a non-2xx, and "dlvault does not care about
  // MEDIA_AVAILABLE" is not a failure of the request.
  res.json({ ok: true });

  if (type === 'TEST_NOTIFICATION') {
    logger.info('Seerr webhook: test notification received');
    return;
  }
  const subject = String(req.body?.subject || '').slice(0, 120);

  if (ISSUE_EVENTS.has(type)) {
    logger.info(`Seerr webhook: ${type}${subject ? ` — ${subject}` : ''}, checking reports now`);
    import('../../services/seerrIssues')
      .then(m => m.processSeerrIssues())
      .catch(err => logger.error(`Seerr issue sweep failed: ${err?.message || err}`));
    return;
  }

  if (!ACTIONABLE.has(type)) return;

  logger.info(`Seerr webhook: ${type}${subject ? ` — ${subject}` : ''}, syncing now`);
  scheduleSync();
});

export default router;
