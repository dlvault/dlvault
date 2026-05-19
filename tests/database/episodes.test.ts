import { describe, it, expect, vi, beforeEach } from 'vitest';

const { testDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      year INTEGER,
      status TEXT DEFAULT 'pending',
      media_type TEXT DEFAULT 'show'
    )
  `);
  testDb.exec(`
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      desired_quality TEXT DEFAULT '1080p',
      episode_count INTEGER DEFAULT 0,
      aired_episodes INTEGER DEFAULT 0,
      FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE,
      UNIQUE(movie_id, season_number)
    )
  `);
  testDb.exec(`
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id INTEGER NOT NULL,
      episode_number INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      release_name TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE,
      UNIQUE(season_id, episode_number)
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

import {
  getEpisodesBySeasonId,
  getEpisode,
  addEpisode,
  addEpisodes,
  updateEpisodeStatus,
  markAllEpisodesDownloaded,
  getPendingEpisodes,
  getSeasonCompletionStatus,
} from '../../src/database/services/episodes';

describe('Episodes Database Service', () => {
  beforeEach(() => {
    testDb.exec('DELETE FROM episodes');
    testDb.exec('DELETE FROM seasons');
    testDb.exec('DELETE FROM movies');
    testDb.exec("INSERT INTO movies (id, title, year) VALUES (1, 'Test Show', 2024)");
    testDb.exec("INSERT INTO seasons (id, movie_id, season_number) VALUES (1, 1, 1)");
  });

  describe('addEpisode', () => {
    it('should add a single episode', () => {
      const ep = addEpisode(1, 1);
      expect(ep.season_id).toBe(1);
      expect(ep.episode_number).toBe(1);
      expect(ep.status).toBe('pending');
    });

    it('should not duplicate episodes (INSERT OR IGNORE)', () => {
      addEpisode(1, 1);
      addEpisode(1, 1);
      const eps = getEpisodesBySeasonId(1);
      expect(eps).toHaveLength(1);
    });
  });

  describe('addEpisodes', () => {
    it('should add multiple episodes in a transaction', () => {
      const eps = addEpisodes(1, [1, 2, 3, 4, 5]);
      expect(eps).toHaveLength(5);
      expect(eps.map(e => e.episode_number)).toEqual([1, 2, 3, 4, 5]);
    });

    it('should handle duplicates gracefully', () => {
      addEpisode(1, 1);
      const eps = addEpisodes(1, [1, 2, 3]);
      expect(eps).toHaveLength(3);
    });
  });

  describe('getEpisodesBySeasonId', () => {
    it('should return episodes sorted by number', () => {
      addEpisodes(1, [3, 1, 2]);
      const eps = getEpisodesBySeasonId(1);
      expect(eps.map(e => e.episode_number)).toEqual([1, 2, 3]);
    });

    it('should return empty for unknown season', () => {
      expect(getEpisodesBySeasonId(999)).toEqual([]);
    });
  });

  describe('getEpisode', () => {
    it('should return a specific episode', () => {
      addEpisode(1, 5);
      const ep = getEpisode(1, 5);
      expect(ep).toBeDefined();
      expect(ep!.episode_number).toBe(5);
    });

    it('should return undefined for non-existent episode', () => {
      expect(getEpisode(1, 99)).toBeUndefined();
    });
  });

  describe('updateEpisodeStatus', () => {
    it('should update status', () => {
      const ep = addEpisode(1, 1);
      updateEpisodeStatus(ep.id, 'downloading');
      const updated = getEpisode(1, 1);
      expect(updated!.status).toBe('downloading');
    });

    it('should update status with release name', () => {
      const ep = addEpisode(1, 1);
      updateEpisodeStatus(ep.id, 'downloaded', 'Test.Show.S01E01.1080p');
      const updated = getEpisode(1, 1);
      expect(updated!.status).toBe('downloaded');
      expect(updated!.release_name).toBe('Test.Show.S01E01.1080p');
    });
  });

  describe('markAllEpisodesDownloaded', () => {
    it('should mark all episodes as downloaded', () => {
      addEpisodes(1, [1, 2, 3]);
      markAllEpisodesDownloaded(1);
      const eps = getEpisodesBySeasonId(1);
      expect(eps.every(e => e.status === 'downloaded')).toBe(true);
    });

    it('should set release name when provided', () => {
      addEpisodes(1, [1, 2]);
      markAllEpisodesDownloaded(1, 'Season.Pack.S01');
      const eps = getEpisodesBySeasonId(1);
      expect(eps.every(e => e.release_name === 'Season.Pack.S01')).toBe(true);
    });
  });

  describe('getPendingEpisodes', () => {
    it('should return non-downloaded episodes', () => {
      addEpisodes(1, [1, 2, 3]);
      const ep1 = getEpisode(1, 1)!;
      updateEpisodeStatus(ep1.id, 'downloaded');

      const pending = getPendingEpisodes(1);
      expect(pending).toHaveLength(2);
      expect(pending.map(e => e.episode_number)).toEqual([2, 3]);
    });
  });

  describe('getSeasonCompletionStatus', () => {
    it('should return correct completion when all downloaded', () => {
      addEpisodes(1, [1, 2, 3]);
      markAllEpisodesDownloaded(1);

      const status = getSeasonCompletionStatus(1);
      expect(status).toEqual({ total: 3, downloaded: 3, allDone: true });
    });

    it('should return correct completion when partially done', () => {
      addEpisodes(1, [1, 2, 3]);
      const ep = getEpisode(1, 1)!;
      updateEpisodeStatus(ep.id, 'downloaded');

      const status = getSeasonCompletionStatus(1);
      expect(status).toEqual({ total: 3, downloaded: 1, allDone: false });
    });

    it('should return zero counts for empty season', () => {
      const status = getSeasonCompletionStatus(1);
      expect(status).toEqual({ total: 0, downloaded: 0, allDone: false });
    });
  });
});
