import { logger } from '../utils/logger';

const MIN_DELAY_MS = 2000; // 2 seconds between source-plugin HTTP requests
let nextAllowedTime = 0;
let gate: Promise<void> = Promise.resolve();

/**
 * Global rate limiter shared across plugins. Ensures a minimum delay between
 * outgoing HTTP requests to any single source so plugins don't collectively
 * hammer a third-party API. Concurrent callers are queued — each waits its
 * turn before proceeding. Call this BEFORE every axios/puppeteer request.
 */
export function waitForRateLimit(): Promise<void> {
  gate = gate.then(async () => {
    const now = Date.now();
    if (now < nextAllowedTime) {
      const waitMs = nextAllowedTime - now;
      logger.debug(`Rate limit: waiting ${waitMs}ms before next request`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    nextAllowedTime = Date.now() + MIN_DELAY_MS;
  });
  return gate;
}
