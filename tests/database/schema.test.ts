import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { applySchema } from '../../src/database/schema';

/**
 * The schema and its migrations run against the user's real database on every
 * boot, so a mistake here is the least recoverable kind this project can ship —
 * and until now not one line of it was executed by a test. It was mocked away in
 * 48 test files, and each DB test hand-copied its own CREATE TABLE instead.
 */
function fresh(): DatabaseType {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function columns(db: DatabaseType, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
}

describe('applySchema', () => {
  describe('fresh install', () => {
    let db: DatabaseType;
    beforeEach(() => { db = fresh(); applySchema(db); });

    it('creates every table', () => {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map(t => t.name);
      expect(tables).toEqual(expect.arrayContaining([
        'settings', 'movies', 'downloads', 'activity_log', 'seasons', 'episodes', 'blocklist',
      ]));
    });

    it('ends up with the full movies shape, base columns and migrated ones alike', () => {
      // The relabel migration used to run BEFORE the ALTER that adds
      // watchlist_source. On a brand-new database that threw
      // `no such column: watchlist_source` and initDatabase() aborted, so the app
      // could not start at all. Upgraded databases already had the column, which
      // is how it reached a release unnoticed.
      expect(columns(db, 'movies')).toEqual(expect.arrayContaining([
        'id', 'trakt_id', 'imdb_id', 'tmdb_id', 'title', 'year', 'media_type', 'status',
        'retry_count', 'last_retry_at', 'last_jd_check_at', 'downloaded_at',
        'plot', 'genres', 'rating', 'runtime', 'director', 'studio', 'country',
        'metadata_fetched_at', 'not_found_reason', 'season_cutoff', 'repair',
        'quality_override', 'seasons_explicit', 'tvdb_id', 'watchlist_source',
      ]));
    });

    it('adds the migrated seasons and downloads columns', () => {
      expect(columns(db, 'seasons')).toEqual(
        expect.arrayContaining(['episode_count', 'aired_episodes', 'not_found_reason']));
      expect(columns(db, 'downloads')).toEqual(expect.arrayContaining(['season_number']));
    });

    it('enforces one download row per (movie, url)', () => {
      db.prepare("INSERT INTO movies (id, title) VALUES (1, 'X')").run();
      const insert = () => db.prepare(
        "INSERT INTO downloads (movie_id, download_url) VALUES (1, 'http://h/f')").run();
      insert();
      expect(insert).toThrow(/UNIQUE/i);
    });

    it('is idempotent', () => {
      const before = columns(db, 'movies');
      expect(() => { applySchema(db); applySchema(db); }).not.toThrow();
      expect(columns(db, 'movies')).toEqual(before);
    });
  });

  describe('upgrading an old database', () => {
    /** A v0-shaped database: the original tables, none of the later columns. */
    function legacy(): DatabaseType {
      const db = fresh();
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE movies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trakt_id INTEGER UNIQUE,
          imdb_id TEXT,
          tmdb_id INTEGER,
          title TEXT NOT NULL,
          year INTEGER,
          status TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE TABLE activity_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          movie_id INTEGER, action TEXT NOT NULL, details TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      return db;
    }

    it('adds every column the current code expects, keeping the rows', () => {
      const db = legacy();
      db.prepare("INSERT INTO movies (id, title, status) VALUES (1, 'Alter Film', 'downloaded')").run();

      applySchema(db);

      expect(columns(db, 'movies')).toEqual(expect.arrayContaining([
        'media_type', 'retry_count', 'season_cutoff', 'repair',
        'quality_override', 'seasons_explicit', 'tvdb_id', 'watchlist_source',
      ]));
      const row = db.prepare('SELECT title, status FROM movies WHERE id = 1').get() as any;
      expect(row).toEqual({ title: 'Alter Film', status: 'downloaded' });
    });

    it('buckets existing not_found rows from their last activity entry', () => {
      const db = legacy();
      db.prepare("INSERT INTO movies (id, title, status) VALUES (1, 'A', 'not_found')").run();
      db.prepare("INSERT INTO movies (id, title, status) VALUES (2, 'B', 'not_found')").run();
      db.prepare("INSERT INTO activity_log (movie_id, action) VALUES (1, 'quality_mismatch')").run();
      db.prepare("INSERT INTO activity_log (movie_id, action) VALUES (2, 'links_offline')").run();

      applySchema(db);

      const reason = (id: number) =>
        (db.prepare('SELECT not_found_reason AS r FROM movies WHERE id = ?').get(id) as any).r;
      expect(reason(1)).toBe('quality_mismatch');
      expect(reason(2)).toBe('no_download');
    });

    it('carries jellyseerr settings over to the seerr keys', () => {
      const db = legacy();
      db.prepare("INSERT INTO settings (key, value) VALUES ('jellyseerr.url', 'http://seerr:5055')").run();
      db.prepare("INSERT INTO settings (key, value) VALUES ('watchlist.provider', 'jellyseerr')").run();

      applySchema(db);

      const value = (k: string) =>
        (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as any)?.value;
      expect(value('seerr.url')).toBe('http://seerr:5055');
      expect(value('jellyseerr.url')).toBeUndefined();
      expect(value('watchlist.provider')).toBe('seerr');
    });

    it('does not clobber a seerr key that is already set', () => {
      const db = legacy();
      db.prepare("INSERT INTO settings (key, value) VALUES ('jellyseerr.api_key', 'alt')").run();
      db.prepare("INSERT INTO settings (key, value) VALUES ('seerr.api_key', 'neu')").run();

      applySchema(db);

      const value = (k: string) =>
        (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as any)?.value;
      expect(value('seerr.api_key')).toBe('neu');
    });

    it('undoes the TMDb-id-as-trakt_id substitution on Plex rows', () => {
      const db = legacy();
      // What the old Plex sync wrote: the TMDb id stuffed into trakt_id.
      db.prepare("INSERT INTO movies (id, title, trakt_id, tmdb_id) VALUES (1, 'Plex', 550, 550)").run();
      // A genuine Trakt row, where the two ids differ.
      db.prepare("INSERT INTO movies (id, title, trakt_id, tmdb_id) VALUES (2, 'Trakt', 11, 22)").run();

      applySchema(db);

      const one = db.prepare('SELECT watchlist_source AS s, trakt_id AS t FROM movies WHERE id = 1').get() as any;
      expect(one).toEqual({ s: 'plex', t: null });
      const two = db.prepare('SELECT watchlist_source AS s, trakt_id AS t FROM movies WHERE id = 2').get() as any;
      expect(two).toEqual({ s: null, t: 11 });
    });

    it('drops duplicate download rows before the unique index goes on', () => {
      const db = legacy();
      db.prepare("INSERT INTO movies (id, title) VALUES (1, 'X')").run();
      db.exec(`
        CREATE TABLE downloads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          movie_id INTEGER NOT NULL,
          download_url TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          hoster TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const dup = db.prepare("INSERT INTO downloads (movie_id, download_url) VALUES (1, 'http://h/f')");
      dup.run(); dup.run(); dup.run();

      // Without the de-dup pass the CREATE UNIQUE INDEX would throw here.
      expect(() => applySchema(db)).not.toThrow();
      const rows = db.prepare('SELECT id FROM downloads').all();
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).id).toBe(1);   // the oldest survives
    });
  });
});
