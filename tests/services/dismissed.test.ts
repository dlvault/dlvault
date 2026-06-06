import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applySchema } from '../../src/database/schema';

const { testDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  return { testDb: new Database(':memory:') };
});
vi.mock('../../src/database/index', () => ({ default: testDb, getSetting: () => '' }));

import { dismissTitle, isDismissed, clearDismissal } from '../../src/database/services/dismissed';

applySchema(testDb);

describe('dismissed titles', () => {
  beforeEach(() => testDb.exec('DELETE FROM dismissed_titles'));

  it('remembers a removed title by TMDb or IMDb id, per media type', () => {
    // "Löschen" on a Seerr title did nothing: the next sync added it back.
    dismissTitle({ media_type: 'movie', tmdb_id: 1057265, imdb_id: 'tt9000001', title: 'Grell' });
    expect(isDismissed({ mediaType: 'movie', tmdbId: 1057265 })).toBe(true);
    expect(isDismissed({ mediaType: 'movie', imdbId: 'tt9000001' })).toBe(true);
    expect(isDismissed({ mediaType: 'show', tmdbId: 1057265 })).toBe(false);   // TMDb ids overlap
    expect(isDismissed({ mediaType: 'movie', tmdbId: 42 })).toBe(false);
    expect(isDismissed({ mediaType: 'movie', imdbId: '' })).toBe(false);
  });

  it('forgets it again when the title is asked for on purpose', () => {
    dismissTitle({ media_type: 'show', tmdb_id: 278178, imdb_id: null, title: 'Sandmere' });
    clearDismissal({ mediaType: 'show', tmdbId: 278178 });
    expect(isDismissed({ mediaType: 'show', tmdbId: 278178 })).toBe(false);
  });

  it('does not stack duplicates when removed twice', () => {
    const t = { media_type: 'movie' as const, tmdb_id: 7, imdb_id: 'tt9000007', title: 'Wardline' };
    dismissTitle(t); dismissTitle(t);
    expect((testDb.prepare('SELECT COUNT(*) n FROM dismissed_titles').get() as any).n).toBe(1);
  });
});

describe('a new wish beats an old removal', () => {
  beforeEach(() => testDb.exec('DELETE FROM dismissed_titles'));

  it('lets a request made after the removal through, and clears the removal', async () => {
    const { dismissTitle, isDismissed, pruneDismissals } = await import('../../src/database/services/dismissed');
    dismissTitle({ media_type: 'movie', tmdb_id: 11, imdb_id: null, title: 'Grell' });
    testDb.exec("UPDATE dismissed_titles SET dismissed_at = '2026-10-01 10:00:00'");
    expect(isDismissed({ mediaType: 'movie', tmdbId: 11 }, '2026-09-30T08:00:00.000Z')).toBe(true);   // the old request
    expect(isDismissed({ mediaType: 'movie', tmdbId: 11 }, '2026-10-05T08:00:00.000Z')).toBe(false);  // asked again
    expect(isDismissed({ mediaType: 'movie', tmdbId: 11 })).toBe(false);                                // cleared

    dismissTitle({ media_type: 'show', tmdb_id: 22, imdb_id: null, title: 'Sandmere' });
    expect(pruneDismissals([{ mediaType: 'movie', tmdbId: 99 }])).toBe(1);   // request for 22 is gone
    expect(pruneDismissals([])).toBe(0);                                      // empty list never prunes
  });
});
