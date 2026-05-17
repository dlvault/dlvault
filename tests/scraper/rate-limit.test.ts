import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('rate-limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('should resolve immediately on first call', async () => {
    const { waitForRateLimit } = await import('../../src/scraper/rate-limit');

    let resolved = false;
    waitForRateLimit().then(() => { resolved = true; });

    // Flush microtasks
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });

  it('should delay second call by at least 2000ms', async () => {
    const { waitForRateLimit } = await import('../../src/scraper/rate-limit');

    // First call
    await waitForRateLimit();

    let secondResolved = false;
    waitForRateLimit().then(() => { secondResolved = true; });

    // Not resolved yet at 1999ms
    await vi.advanceTimersByTimeAsync(1999);
    expect(secondResolved).toBe(false);

    // Resolved after 2000ms
    await vi.advanceTimersByTimeAsync(2);
    expect(secondResolved).toBe(true);
  });

  it('should queue concurrent callers sequentially', async () => {
    const { waitForRateLimit } = await import('../../src/scraper/rate-limit');

    const order: number[] = [];

    // Fire first call
    await waitForRateLimit();

    // Fire two more concurrently
    waitForRateLimit().then(() => { order.push(1); });
    waitForRateLimit().then(() => { order.push(2); });

    // After 2s, first queued call resolves
    await vi.advanceTimersByTimeAsync(2001);
    expect(order).toEqual([1]);

    // After another 2s, second queued call resolves
    await vi.advanceTimersByTimeAsync(2001);
    expect(order).toEqual([1, 2]);
  });
});
