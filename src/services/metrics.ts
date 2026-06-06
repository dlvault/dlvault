/**
 * Simple in-memory metrics for monitoring scrape/download performance.
 * Exposed via GET /api/health (extended).
 */

interface MetricCounters {
  scrapeAttempts: number;
  scrapeSuccesses: number;
  scrapeFailures: number;
  captchaSolveAttempts: number;
  captchaSolveSuccesses: number;
  jdApiCalls: number;
  jdApiErrors: number;
  syncRuns: number;
  moviesProcessed: number;
  lastSyncDurationMs: number;
  lastSyncAt: string | null;
  startedAt: string;
}

const counters: MetricCounters = {
  scrapeAttempts: 0,
  scrapeSuccesses: 0,
  scrapeFailures: 0,
  captchaSolveAttempts: 0,
  captchaSolveSuccesses: 0,
  jdApiCalls: 0,
  jdApiErrors: 0,
  syncRuns: 0,
  moviesProcessed: 0,
  lastSyncDurationMs: 0,
  lastSyncAt: null,
  startedAt: new Date().toISOString(),
};

export function incrementMetric(key: keyof Omit<MetricCounters, 'lastSyncDurationMs' | 'lastSyncAt' | 'startedAt'>): void {
  counters[key]++;
}

export function setMetric<K extends 'lastSyncDurationMs' | 'lastSyncAt'>(key: K, value: MetricCounters[K]): void {
  counters[key] = value;
}

export function getMetrics(): MetricCounters {
  return { ...counters };
}
