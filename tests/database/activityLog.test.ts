import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { testDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      year INTEGER,
      status TEXT DEFAULT 'pending'
    )
  `);
  testDb.exec(`
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (movie_id) REFERENCES movies(id)
    )
  `);
  return { testDb };
});

vi.mock('../../src/database/index', () => ({
  default: testDb,
  initDatabase: vi.fn(),
  getSetting: vi.fn(() => ''),
  setSetting: vi.fn(),
}));

import { addLogEntry, getRecentLogs, getLogsByMovieId, getActivityStats } from '../../src/database/services/activityLog';

describe('ActivityLog Database Service', () => {
  beforeEach(() => {
    testDb.exec('DELETE FROM activity_log');
    testDb.exec('DELETE FROM movies');
    testDb.exec("INSERT INTO movies (id, title, year) VALUES (1, 'Test Movie', 2024)");
  });

  describe('addLogEntry', () => {
    it('should add a log entry with movie_id', () => {
      addLogEntry(1, 'search_started', 'Searching for Test Movie');
      const logs = testDb.prepare('SELECT * FROM activity_log').all() as any[];
      expect(logs).toHaveLength(1);
      expect(logs[0].movie_id).toBe(1);
      expect(logs[0].action).toBe('search_started');
      expect(logs[0].details).toBe('Searching for Test Movie');
    });

    it('should add a log entry without movie_id', () => {
      addLogEntry(null, 'watchlist_sync', 'Synced 5 movies');
      const logs = testDb.prepare('SELECT * FROM activity_log').all() as any[];
      expect(logs).toHaveLength(1);
      expect(logs[0].movie_id).toBeNull();
    });

    it('should add a log entry without details', () => {
      addLogEntry(1, 'sync');
      const logs = testDb.prepare('SELECT * FROM activity_log').all() as any[];
      expect(logs).toHaveLength(1);
      expect(logs[0].details).toBeNull();
    });
  });

  describe('getRecentLogs', () => {
    it('should return logs with movie title joined', () => {
      addLogEntry(1, 'search_started', 'Searching');
      const logs = getRecentLogs(10);
      expect(logs).toHaveLength(1);
      expect(logs[0].movie_title).toBe('Test Movie');
    });

    it('should respect limit', () => {
      addLogEntry(1, 'action1', 'Detail 1');
      addLogEntry(1, 'action2', 'Detail 2');
      addLogEntry(1, 'action3', 'Detail 3');
      const logs = getRecentLogs(2);
      expect(logs).toHaveLength(2);
    });

    it('should order by created_at descending', () => {
      // SQLite datetime('now') can have same timestamp for fast inserts
      // So we manually insert with different timestamps
      testDb.prepare("INSERT INTO activity_log (movie_id, action, created_at) VALUES (1, 'first', '2024-01-01 00:00:00')").run();
      testDb.prepare("INSERT INTO activity_log (movie_id, action, created_at) VALUES (1, 'second', '2024-01-01 01:00:00')").run();
      const logs = getRecentLogs(10);
      expect(logs[0].action).toBe('second');
    });
  });

  describe('getLogsByMovieId', () => {
    it('should return only logs for specified movie', () => {
      testDb.exec("INSERT INTO movies (id, title, year) VALUES (2, 'Other Movie', 2025)");
      addLogEntry(1, 'action_a');
      addLogEntry(2, 'action_b');
      addLogEntry(1, 'action_c');

      const logs = getLogsByMovieId(1);
      expect(logs).toHaveLength(2);
      expect(logs.every(l => l.movie_id === 1)).toBe(true);
    });

    it('should return empty for movie with no logs', () => {
      const logs = getLogsByMovieId(999);
      expect(logs).toEqual([]);
    });
  });

  describe('getActivityStats', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('buckets actions into success / error / other totals', () => {
      addLogEntry(1, 'moved_to_library');   // success
      addLogEntry(1, 'release_found');       // success
      addLogEntry(1, 'not_found');           // error
      addLogEntry(1, 'search_started');      // other

      const stats = getActivityStats(30);
      expect(stats.totals.success).toBe(2);
      expect(stats.totals.error).toBe(1);
      expect(stats.totals.other).toBe(1);
      expect(stats.totals.total).toBe(4);
      expect(stats.completed).toBe(1); // only moved_to_library counts as completed
    });

    it('excludes rows older than the requested window', () => {
      // Well outside a 7-day window.
      testDb.prepare(
        "INSERT INTO activity_log (movie_id, action, created_at) VALUES (1, 'moved_to_library', '2000-01-01 00:00:00')"
      ).run();

      const stats = getActivityStats(7);
      expect(stats.totals.total).toBe(0);
      expect(stats.completed).toBe(0);
    });

    // Regression: SQLite stores datetime('now') space-separated ("YYYY-MM-DD HH:MM:SS"),
    // but toISOString() is "T"-separated. The "T" (0x54) sorts lexicographically *after*
    // the space (0x20), so a raw ISO cutoff silently dropped rows whose stored timestamp
    // shared the cutoff's calendar day. The cutoff must be formatted to match SQLite.
    it('counts boundary-day rows despite SQLite vs. ISO datetime formats', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-22T12:00:00.000Z'));

      // 30-day cutoff lands on 2026-04-22 12:00:00. This row is one second later,
      // on the same calendar day — exactly the case the old ISO cutoff dropped.
      testDb.prepare(
        "INSERT INTO activity_log (movie_id, action, created_at) VALUES (1, 'moved_to_library', '2026-04-22 12:00:01')"
      ).run();

      const stats = getActivityStats(30);
      expect(stats.totals.success).toBe(1);
      expect(stats.completed).toBe(1);
    });
  });
});
