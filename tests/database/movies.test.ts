import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
      last_checked_at TEXT,
      not_found_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER NOT NULL,
      season_number INTEGER,
      release_name TEXT,
      quality TEXT,
      audio TEXT,
      hoster TEXT NOT NULL DEFAULT 'example-host',
      download_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      jdownloader_package_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE SET NULL
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

// The movies service references columns the base test schema above omits
// (retry_count, last_retry_at). Add them so the update helpers can be tested.
testDb.exec('ALTER TABLE movies ADD COLUMN last_retry_at TEXT');
testDb.exec('ALTER TABLE movies ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');

import {
  getAllMovies, getMovieById, getMovieByTraktId, getMovieByImdbId, getMovieByTmdbId,
  getMoviesByStatus, addMovie, updateMovieStatus, deleteMovie,
  updateLastChecked, incrementRetryCount, resetRetryCount, updateLastRetryAt,
  updateMovieTraktId, updateMovieTitle,
} from '../../src/database/services/movies';
import {
  addDownload, getDownloadsByMovieId,
} from '../../src/database/services/downloads';
import {
  addLogEntry, getRecentLogs, getLogsByMovieId,
} from '../../src/database/services/activityLog';

describe('Movie DB Service', () => {
  beforeEach(() => {
    testDb.exec('DELETE FROM activity_log');
    testDb.exec('DELETE FROM downloads');
    testDb.exec('DELETE FROM movies');
  });

  it('should add and retrieve a movie', () => {
    const movie = addMovie({
      trakt_id: 12345, imdb_id: 'tt1234567', tmdb_id: 67890,
      title: 'Test Movie', year: 2024, slug: 'test-movie',
      media_type: 'movie', status: 'pending', desired_quality: '1080p',
    });
    expect(movie.title).toBe('Test Movie');
    expect(getMovieById(movie.id)?.title).toBe('Test Movie');
  });

  it('should find movie by trakt_id', () => {
    addMovie({
      trakt_id: 99999, imdb_id: 'tt9999999', tmdb_id: 88888,
      title: 'Trakt Movie', year: 2025, slug: 'trakt-movie',
      media_type: 'movie', status: 'pending', desired_quality: '1080p',
    });
    expect(getMovieByTraktId(99999)?.title).toBe('Trakt Movie');
    expect(getMovieByTraktId(11111)).toBeUndefined();
  });

  it('should get movies by status', () => {
    addMovie({ trakt_id: 1, imdb_id: '', tmdb_id: 1, title: 'Pending', year: 2024, slug: 'a', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    addMovie({ trakt_id: 2, imdb_id: '', tmdb_id: 2, title: 'Done', year: 2024, slug: 'b', media_type: 'movie', status: 'downloaded', desired_quality: '1080p' });
    expect(getMoviesByStatus('pending')).toHaveLength(1);
    expect(getMoviesByStatus('downloaded')).toHaveLength(1);
  });

  it('should update movie status', () => {
    const movie = addMovie({ trakt_id: 10, imdb_id: '', tmdb_id: 10, title: 'Status', year: 2024, slug: 'c', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    updateMovieStatus(movie.id, 'downloading');
    expect(getMovieById(movie.id)?.status).toBe('downloading');
  });

  it('should update status with source URL', () => {
    const movie = addMovie({ trakt_id: 11, imdb_id: '', tmdb_id: 11, title: 'URL', year: 2024, slug: 'd', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    updateMovieStatus(movie.id, 'found', 'https://example.com/movie/12345');
    const updated = getMovieById(movie.id);
    expect(updated?.status).toBe('found');
    expect(updated?.source_url).toBe('https://example.com/movie/12345');
  });

  it('stores not_found_reason when marking not_found, and clears it when leaving not_found', () => {
    const movie = addMovie({ trakt_id: 12, imdb_id: '', tmdb_id: 12, title: 'Reason', year: 2024, slug: 'e', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    updateMovieStatus(movie.id, 'not_found', 'https://example.com/x', 'quality_mismatch');
    expect(getMovieById(movie.id)?.not_found_reason).toBe('quality_mismatch');
    // Any transition away from not_found must clear the stale reason.
    updateMovieStatus(movie.id, 'downloading');
    expect(getMovieById(movie.id)?.not_found_reason).toBeNull();
    // not_found without an explicit reason stores NULL (legacy/unknown).
    updateMovieStatus(movie.id, 'not_found');
    expect(getMovieById(movie.id)?.not_found_reason).toBeNull();
  });

  it('should delete movie and cascade downloads', () => {
    const movie = addMovie({ trakt_id: 20, imdb_id: '', tmdb_id: 20, title: 'Delete', year: 2024, slug: 'e', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    addDownload({ movie_id: movie.id, download_url: 'https://example.com/1' });
    deleteMovie(movie.id);
    expect(getMovieById(movie.id)).toBeUndefined();
    expect(getDownloadsByMovieId(movie.id)).toHaveLength(0);
  });

  it('should ignore duplicate trakt_id', () => {
    addMovie({ trakt_id: 30, imdb_id: '', tmdb_id: 30, title: 'First', year: 2024, slug: 'f', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    addMovie({ trakt_id: 30, imdb_id: '', tmdb_id: 31, title: 'Dup', year: 2024, slug: 'g', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    expect(getAllMovies()).toHaveLength(1);
  });

  it('finds a movie by imdb_id and tmdb_id', () => {
    const m = addMovie({ trakt_id: 40, imdb_id: 'tt4040404', tmdb_id: 4040, title: 'Ids', year: 2024, slug: 'ids', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    expect(getMovieByImdbId('tt4040404')?.id).toBe(m.id);
    expect(getMovieByTmdbId(4040)?.id).toBe(m.id);
    expect(getMovieByImdbId('tt0000000')).toBeUndefined();
    expect(getMovieByTmdbId(999999)).toBeUndefined();
  });

  it('returns the existing row on duplicate insert (resolved by trakt/imdb/tmdb)', () => {
    const first = addMovie({ trakt_id: 50, imdb_id: 'tt5050505', tmdb_id: 5050, title: 'Orig', year: 2024, slug: 'orig', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    const dupByTrakt = addMovie({ trakt_id: 50, imdb_id: '', tmdb_id: 0, title: 'Dup', year: 2024, slug: 'dup', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    expect(dupByTrakt.id).toBe(first.id);
  });

  it('defaults media_type to movie when falsy', () => {
    const m = addMovie({ trakt_id: 70, imdb_id: '', tmdb_id: 70, title: 'NoType', year: 2024, slug: 'notype', media_type: '' as any, status: 'pending', desired_quality: '1080p' });
    expect(getMovieById(m.id)?.media_type).toBe('movie');
  });

  it('updates last_checked_at', () => {
    const m = addMovie({ trakt_id: 80, imdb_id: '', tmdb_id: 80, title: 'Checked', year: 2024, slug: 'checked', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    expect(getMovieById(m.id)?.last_checked_at).toBeNull();
    updateLastChecked(m.id);
    expect(getMovieById(m.id)?.last_checked_at).not.toBeNull();
  });

  it('increments and resets retry_count', () => {
    const m = addMovie({ trakt_id: 81, imdb_id: '', tmdb_id: 81, title: 'Retry', year: 2024, slug: 'retry', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    expect(incrementRetryCount(m.id)).toBe(1);
    expect(incrementRetryCount(m.id)).toBe(2);
    expect(getMovieById(m.id)?.retry_count).toBe(2);
    resetRetryCount(m.id);
    expect(getMovieById(m.id)?.retry_count).toBe(0);
  });

  it('incrementRetryCount returns 0 for an unknown id', () => {
    expect(incrementRetryCount(999999)).toBe(0);
  });

  it('updates last_retry_at', () => {
    const m = addMovie({ trakt_id: 82, imdb_id: '', tmdb_id: 82, title: 'LastRetry', year: 2024, slug: 'lastretry', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    expect(getMovieById(m.id)?.last_retry_at).toBeNull();
    updateLastRetryAt(m.id);
    expect(getMovieById(m.id)?.last_retry_at).not.toBeNull();
  });

  it('updates trakt_id and title', () => {
    const m = addMovie({ trakt_id: 83, imdb_id: '', tmdb_id: 83, title: 'Old Title', year: 2024, slug: 'old', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    updateMovieTraktId(m.id, 9999);
    updateMovieTitle(m.id, 'New Title');
    const updated = getMovieById(m.id);
    expect(updated?.trakt_id).toBe(9999);
    expect(updated?.title).toBe('New Title');
  });
});

describe('Download DB Service', () => {
  beforeEach(() => {
    testDb.exec('DELETE FROM downloads');
    testDb.exec('DELETE FROM movies');
  });

  it('should add and retrieve downloads', () => {
    const movie = addMovie({ trakt_id: 100, imdb_id: '', tmdb_id: 100, title: 'DL', year: 2024, slug: 'dl', media_type: 'movie', status: 'found', desired_quality: '1080p' });
    addDownload({ movie_id: movie.id, release_name: 'DL 1080p', quality: '1080p', audio: '5.1', hoster: 'example-host', download_url: 'https://example.com/abc' });
    const downloads = getDownloadsByMovieId(movie.id);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].hoster).toBe('example-host');
  });

  it('should skip duplicate downloads for same movie', () => {
    const movie = addMovie({ trakt_id: 101, imdb_id: '', tmdb_id: 101, title: 'Dup', year: 2024, slug: 'dup', media_type: 'movie', status: 'found', desired_quality: '1080p' });
    addDownload({ movie_id: movie.id, download_url: 'https://example.com/1' });
    addDownload({ movie_id: movie.id, download_url: 'https://example.com/1' });
    expect(getDownloadsByMovieId(movie.id)).toHaveLength(1);
  });
});

describe('Activity Log DB Service', () => {
  beforeEach(() => {
    testDb.exec('DELETE FROM activity_log');
    testDb.exec('DELETE FROM movies');
  });

  it('should add and retrieve log entries', () => {
    addLogEntry(null, 'sync_started', 'Test sync');
    const logs = getRecentLogs(10);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('sync_started');
  });

  it('should associate log with movie', () => {
    const movie = addMovie({ trakt_id: 200, imdb_id: '', tmdb_id: 200, title: 'Log', year: 2024, slug: 'log', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
    addLogEntry(movie.id, 'search_started', 'Searching...');
    addLogEntry(movie.id, 'release_found', 'Found!');
    expect(getLogsByMovieId(movie.id)).toHaveLength(2);
  });

  it('should respect limit parameter', () => {
    for (let i = 0; i < 10; i++) addLogEntry(null, 'test', `Entry ${i}`);
    expect(getRecentLogs(3)).toHaveLength(3);
  });
});
