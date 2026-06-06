import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applySchema } from '../../src/database/schema';

const { testDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  return { testDb };
});
vi.mock('../../src/database/index', () => ({ default: testDb, db: testDb, getSetting: vi.fn(() => '') }));
applySchema(testDb);

import { syncSeasonCounts } from '../../src/services/seasonCounts';

const seasons = () => testDb.prepare('SELECT season_number n, status, episode_count c, aired_episodes a FROM seasons WHERE movie_id = 1 ORDER BY n').all();
const eps = (n: number) => testDb.prepare(
  'SELECT e.episode_number e, e.status FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE s.movie_id = 1 AND s.season_number = ? ORDER BY e.episode_number',
).all(n);
const show = (over: Record<string, any> = {}) => ({ id: 1, desired_quality: '1080p', season_cutoff: null, seasons_explicit: 0, ...over });

describe('syncSeasonCounts', () => {
  beforeEach(() => {
    testDb.exec("DELETE FROM episodes; DELETE FROM seasons; DELETE FROM activity_log; DELETE FROM movies; INSERT INTO movies (id, title, media_type) VALUES (1, 'Wardline', 'show');");
  });

  it('creates seasons with counts and rows for the aired episodes', () => {
    expect(syncSeasonCounts(show(), [{ season: 1, episodes: 8, aired: 8 }, { season: 2, episodes: 8, aired: 3 }])).toBe(2);
    expect(seasons()).toEqual([
      { n: 1, status: 'pending', c: 8, a: 8 },
      { n: 2, status: 'pending', c: 8, a: 3 },
    ]);
    expect(eps(2).map((r: any) => r.e)).toEqual([1, 2, 3]);
  });

  it('respects the cutoff and never widens an explicit season list', () => {
    expect(syncSeasonCounts(show({ season_cutoff: 2 }), [{ season: 1, episodes: 6, aired: 6 }, { season: 2, episodes: 6, aired: 6 }])).toBe(1);
    expect(seasons().map((s: any) => s.n)).toEqual([2]);
    testDb.exec('DELETE FROM episodes; DELETE FROM seasons;');
    expect(syncSeasonCounts(show({ seasons_explicit: 1 }), [{ season: 1, episodes: 6, aired: 6 }])).toBe(0);
  });

  it('reopens a closed season when a new episode airs, but not when it is already there', () => {
    syncSeasonCounts(show(), [{ season: 1, episodes: 8, aired: 4 }]);
    testDb.exec("UPDATE seasons SET status = 'downloaded'; UPDATE episodes SET status = 'downloaded';");
    syncSeasonCounts(show(), [{ season: 1, episodes: 8, aired: 5 }]);
    expect(seasons()[0]).toMatchObject({ status: 'pending', a: 5 });
    expect(eps(1).map((r: any) => r.status)).toEqual(['downloaded', 'downloaded', 'downloaded', 'downloaded', 'pending']);

    testDb.exec("UPDATE seasons SET status = 'downloaded'; UPDATE episodes SET status = 'downloaded';");
    syncSeasonCounts(show(), [{ season: 1, episodes: 8, aired: 5 }]);
    expect(seasons()[0].status).toBe('downloaded');
  });

  it('never shrinks the aired count on a lagging answer', () => {
    syncSeasonCounts(show(), [{ season: 1, episodes: 8, aired: 6 }]);
    syncSeasonCounts(show(), [{ season: 1, episodes: 8, aired: 2 }]);
    expect(seasons()[0].a).toBe(6);
  });
});
