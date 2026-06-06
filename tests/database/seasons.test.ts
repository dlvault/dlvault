import { describe, it, expect, beforeEach, vi } from 'vitest';

const { testDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');

  testDb.exec(`
    CREATE TABLE IF NOT EXISTS movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trakt_id INTEGER UNIQUE,
      imdb_id TEXT,
      tmdb_id INTEGER,
      title TEXT NOT NULL,
      year INTEGER,
      slug TEXT,
      media_type TEXT NOT NULL DEFAULT 'movie',
      status TEXT NOT NULL DEFAULT 'pending',
      desired_quality TEXT DEFAULT '1080p',
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      source_url TEXT,
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      desired_quality TEXT DEFAULT '1080p',
      source_url TEXT,
      last_checked_at TEXT,
      not_found_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE,
      UNIQUE(movie_id, season_number)
    );
  `);

  return { testDb };
});

vi.mock('../../src/database/index', () => ({
  default: testDb,
  db: testDb,
  getSetting: vi.fn(() => ''),
  setSetting: vi.fn(),
  getAllSettings: vi.fn(() => ({})),
  initDatabase: vi.fn(),
  invalidateSettingsCache: vi.fn(),
}));

// The seasons service references columns the base test schema above omits
// (episode_count, aired_episodes). Add them so the count helper can be tested.
testDb.exec('ALTER TABLE seasons ADD COLUMN episode_count INTEGER');
testDb.exec('ALTER TABLE seasons ADD COLUMN aired_episodes INTEGER');

import {
  getSeasonsByShowId, getSeasonsByShowIds, getSeason, addSeason, addSeasons,
  updateSeasonStatus, updateSeasonLastChecked, updateSeasonEpisodeCount, deleteSeason,
} from '../../src/database/services/seasons';

function addShow(traktId: number, title: string): number {
  const stmt = testDb.prepare(`
    INSERT INTO movies (trakt_id, title, year, media_type, status)
    VALUES (?, ?, 2024, 'show', 'pending')
  `);
  return Number(stmt.run(traktId, title).lastInsertRowid);
}

describe('Season DB Service', () => {
  beforeEach(() => {
    testDb.exec('DELETE FROM seasons');
    testDb.exec('DELETE FROM movies');
  });

  it('should add and retrieve a season', () => {
    const showId = addShow(1, 'Test Show');
    const season = addSeason(showId, 1, '1080p');

    expect(season.season_number).toBe(1);
    expect(season.status).toBe('pending');
    expect(season.desired_quality).toBe('1080p');
  });

  it('should retrieve season by show and number', () => {
    const showId = addShow(2, 'Another Show');
    addSeason(showId, 3);

    const season = getSeason(showId, 3);
    expect(season).toBeDefined();
    expect(season!.season_number).toBe(3);
  });

  it('should return undefined for non-existent season', () => {
    const showId = addShow(3, 'Show');
    expect(getSeason(showId, 99)).toBeUndefined();
  });

  it('should add multiple seasons at once', () => {
    const showId = addShow(4, 'Multi Season');
    const seasons = addSeasons(showId, [1, 2, 3], '2160p');

    expect(seasons).toHaveLength(3);
    expect(seasons[0].season_number).toBe(1);
    expect(seasons[2].season_number).toBe(3);
  });

  it('should ignore duplicate season inserts', () => {
    const showId = addShow(5, 'Dup Show');
    addSeason(showId, 1);
    addSeason(showId, 1); // duplicate

    expect(getSeasonsByShowId(showId)).toHaveLength(1);
  });

  it('should update season status', () => {
    const showId = addShow(6, 'Status Show');
    const season = addSeason(showId, 1);

    updateSeasonStatus(season.id, 'downloading');
    expect(getSeason(showId, 1)!.status).toBe('downloading');
  });

  it('should update season status with source URL', () => {
    const showId = addShow(7, 'URL Show');
    const season = addSeason(showId, 2);

    updateSeasonStatus(season.id, 'found', 'https://example.com/show/12345');
    const updated = getSeason(showId, 2)!;
    expect(updated.status).toBe('found');
    expect(updated.source_url).toBe('https://example.com/show/12345');
  });

  it('should delete a single season', () => {
    const showId = addShow(8, 'Delete Show');
    const season = addSeason(showId, 1);
    addSeason(showId, 2);

    deleteSeason(season.id);
    expect(getSeasonsByShowId(showId)).toHaveLength(1);
  });

  it('should cascade delete seasons when show is deleted', () => {
    const showId = addShow(10, 'Cascade Show');
    addSeasons(showId, [1, 2]);

    testDb.prepare('DELETE FROM movies WHERE id = ?').run(showId);
    expect(getSeasonsByShowId(showId)).toHaveLength(0);
  });

  it('getSeasonsByShowIds returns an empty map for an empty id list', () => {
    expect(getSeasonsByShowIds([]).size).toBe(0);
  });

  it('getSeasonsByShowIds groups seasons per show', () => {
    const a = addShow(11, 'Show A');
    const b = addShow(12, 'Show B');
    addSeasons(a, [1, 2]);
    addSeason(b, 1);

    const map = getSeasonsByShowIds([a, b]);
    expect(map.get(a)).toHaveLength(2);
    expect(map.get(b)).toHaveLength(1);
    // Shows with no seasons are simply absent from the map.
    expect(map.has(99999)).toBe(false);
  });

  it('updates season last_checked_at', () => {
    const showId = addShow(13, 'Checked Show');
    const season = addSeason(showId, 1);
    expect(getSeason(showId, 1)!.last_checked_at).toBeNull();
    updateSeasonLastChecked(season.id);
    expect(getSeason(showId, 1)!.last_checked_at).not.toBeNull();
  });

  it('updates episode counts, defaulting aired to episode count', () => {
    const showId = addShow(14, 'Episode Show');
    const season = addSeason(showId, 1);

    updateSeasonEpisodeCount(season.id, 10, 7);
    let updated = getSeason(showId, 1)!;
    expect(updated.episode_count).toBe(10);
    expect(updated.aired_episodes).toBe(7);

    // When aired is omitted it falls back to the episode count.
    updateSeasonEpisodeCount(season.id, 12);
    updated = getSeason(showId, 1)!;
    expect(updated.episode_count).toBe(12);
    expect(updated.aired_episodes).toBe(12);
  });
});

