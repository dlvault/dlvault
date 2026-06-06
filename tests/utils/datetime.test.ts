import { describe, it, expect, vi, afterEach } from 'vitest';
import { toSqliteUtc } from '../../src/utils/datetime';

describe('toSqliteUtc', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats a Date as space-separated UTC without ms or Z', () => {
    expect(toSqliteUtc(new Date('2026-05-22T12:34:56.789Z'))).toBe('2026-05-22 12:34:56');
  });

  it('does not contain a "T" separator (the bug it guards against)', () => {
    const out = toSqliteUtc(new Date('2026-01-01T00:00:00.000Z'));
    expect(out).not.toContain('T');
    expect(out).toBe('2026-01-01 00:00:00');
  });

  it('sorts lexicographically equal-or-greater than the same SQLite timestamp', () => {
    // The whole point: a same-instant stored value must compare >= the cutoff.
    const stored = '2026-05-22 12:00:00';
    const cutoff = toSqliteUtc(new Date('2026-05-22T12:00:00.000Z'));
    expect(stored >= cutoff).toBe(true);

    // A raw ISO cutoff would (wrongly) sort larger, dropping the row.
    const isoCutoff = new Date('2026-05-22T12:00:00.000Z').toISOString();
    expect(stored >= isoCutoff).toBe(false);
  });

  it('defaults to the current time when called with no argument', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T08:09:10.000Z'));
    expect(toSqliteUtc()).toBe('2026-03-15 08:09:10');
  });
});
