import { describe, it, expect } from 'vitest';
import { parseServerDate } from '../../frontend/src/composables/useFormatters';

describe('parseServerDate', () => {
  it('reads SQLite UTC timestamps (space separator, no zone) as UTC', () => {
    // Older Safari rejects the space separator — the PWA showed "Invalid Date".
    expect(parseServerDate('2026-10-14 04:20:37').toISOString()).toBe('2026-10-14T04:20:37.000Z');
  });

  it('keeps a zone that is already there instead of appending a second one', () => {
    expect(parseServerDate('2026-10-14T04:20:37Z').toISOString()).toBe('2026-10-14T04:20:37.000Z');
    expect(parseServerDate('2026-10-14T06:20:37+02:00').toISOString()).toBe('2026-10-14T04:20:37.000Z');
  });

  it('reads naive ISO timestamps (library addedAt) as UTC', () => {
    expect(parseServerDate('2026-10-14T04:20:37').toISOString()).toBe('2026-10-14T04:20:37.000Z');
  });
});
