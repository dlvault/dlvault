import { describe, it, expect } from 'vitest';
import { incrementMetric, setMetric, getMetrics } from '../../src/services/metrics';

describe('Metrics Service', () => {
  it('should return initial metrics with zero counters', () => {
    const metrics = getMetrics();
    expect(metrics).toHaveProperty('scrapeAttempts');
    expect(metrics).toHaveProperty('syncRuns');
    expect(metrics).toHaveProperty('startedAt');
    expect(typeof metrics.startedAt).toBe('string');
  });

  it('should increment counter metrics', () => {
    const before = getMetrics().scrapeAttempts;
    incrementMetric('scrapeAttempts');
    const after = getMetrics().scrapeAttempts;
    expect(after).toBe(before + 1);
  });

  it('should increment multiple different counters independently', () => {
    const beforeSuccess = getMetrics().scrapeSuccesses;
    const beforeFailure = getMetrics().scrapeFailures;

    incrementMetric('scrapeSuccesses');
    incrementMetric('scrapeSuccesses');
    incrementMetric('scrapeFailures');

    expect(getMetrics().scrapeSuccesses).toBe(beforeSuccess + 2);
    expect(getMetrics().scrapeFailures).toBe(beforeFailure + 1);
  });

  it('should set lastSyncDurationMs', () => {
    setMetric('lastSyncDurationMs', 12345);
    expect(getMetrics().lastSyncDurationMs).toBe(12345);
  });

  it('should set lastSyncAt', () => {
    const timestamp = '2026-04-04T12:00:00.000Z';
    setMetric('lastSyncAt', timestamp);
    expect(getMetrics().lastSyncAt).toBe(timestamp);
  });

  it('should return a copy (not a reference) of metrics', () => {
    const m1 = getMetrics();
    const m2 = getMetrics();
    expect(m1).not.toBe(m2);
    expect(m1).toEqual(m2);
  });
});
