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

    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER NOT NULL,
      release_name TEXT,
      quality TEXT,
      audio TEXT,
      hoster TEXT NOT NULL DEFAULT '',
      download_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      jdownloader_package_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE
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

import {
  addDownload, getDownloadsByMovieId, getDownloadsByMovieIds,
  updateDownloadStatus, updateDownloadStatusByMovieId, getAllDownloads,
} from '../../src/database/services/downloads';

function addTestMovie(traktId: number, title: string): number {
  return Number(testDb.prepare(
    `INSERT INTO movies (trakt_id, title, year, media_type, status) VALUES (?, ?, 2024, 'movie', 'found')`
  ).run(traktId, title).lastInsertRowid);
}

describe('Downloads DB Service', () => {
  beforeEach(() => {
    testDb.exec('DELETE FROM downloads');
    testDb.exec('DELETE FROM movies');
  });

  it('should add and retrieve a download', () => {
    const movieId = addTestMovie(1, 'DL Test');
    const dl = addDownload({
      movie_id: movieId,
      release_name: 'Test.2024.1080p',
      quality: '1080p',
      audio: '5.1',
      hoster: 'example-host',
      download_url: 'https://example.com/file/abc',
    });

    expect(dl.movie_id).toBe(movieId);
    const downloads = getDownloadsByMovieId(movieId);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].release_name).toBe('Test.2024.1080p');
  });

  it('should skip duplicate download URLs for same movie', () => {
    const movieId = addTestMovie(2, 'Dup DL');
    addDownload({ movie_id: movieId, download_url: 'https://example.com/1' });
    addDownload({ movie_id: movieId, download_url: 'https://example.com/1' }); // duplicate

    expect(getDownloadsByMovieId(movieId)).toHaveLength(1);
  });

  it('should allow same URL for different movies', () => {
    const movie1 = addTestMovie(3, 'Movie 1');
    const movie2 = addTestMovie(4, 'Movie 2');

    addDownload({ movie_id: movie1, download_url: 'https://example.com/shared' });
    addDownload({ movie_id: movie2, download_url: 'https://example.com/shared' });

    expect(getDownloadsByMovieId(movie1)).toHaveLength(1);
    expect(getDownloadsByMovieId(movie2)).toHaveLength(1);
  });

  it('should update download status', () => {
    const movieId = addTestMovie(5, 'Status DL');
    const dl = addDownload({ movie_id: movieId, download_url: 'https://example.com/2' });

    updateDownloadStatus(dl.id, 'sent_to_jd', 'pkg-123');

    const updated = getDownloadsByMovieId(movieId)[0];
    expect(updated.status).toBe('sent_to_jd');
    expect(updated.jdownloader_package_id).toBe('pkg-123');
  });

  it('should update download status without JD package ID', () => {
    const movieId = addTestMovie(6, 'Status DL 2');
    const dl = addDownload({ movie_id: movieId, download_url: 'https://example.com/3' });

    updateDownloadStatus(dl.id, 'completed');

    const updated = getDownloadsByMovieId(movieId)[0];
    expect(updated.status).toBe('completed');
  });

  it('should batch-load downloads by movie IDs', () => {
    const movie1 = addTestMovie(7, 'Batch 1');
    const movie2 = addTestMovie(8, 'Batch 2');
    const movie3 = addTestMovie(9, 'Batch 3');

    addDownload({ movie_id: movie1, download_url: 'https://example.com/a' });
    addDownload({ movie_id: movie1, download_url: 'https://example.com/b' });
    addDownload({ movie_id: movie2, download_url: 'https://example.com/c' });
    // movie3 has no downloads

    const map = getDownloadsByMovieIds([movie1, movie2, movie3]);

    expect(map.get(movie1)).toHaveLength(2);
    expect(map.get(movie2)).toHaveLength(1);
    expect(map.has(movie3)).toBe(false);
  });

  it('should return empty map for empty movie IDs', () => {
    const map = getDownloadsByMovieIds([]);
    expect(map.size).toBe(0);
  });

  it('should cascade delete downloads when movie is deleted', () => {
    const movieId = addTestMovie(10, 'Cascade DL');
    addDownload({ movie_id: movieId, download_url: 'https://example.com/del' });

    testDb.prepare('DELETE FROM movies WHERE id = ?').run(movieId);
    expect(getDownloadsByMovieId(movieId)).toHaveLength(0);
  });

  it('should get all downloads with movie titles', () => {
    const movieId = addTestMovie(11, 'All DL');
    addDownload({ movie_id: movieId, download_url: 'https://example.com/all' });

    const all = getAllDownloads();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.find((d: any) => d.movie_title === 'All DL')).toBeDefined();
  });

  it('should default hoster to empty string when not specified', () => {
    const movieId = addTestMovie(12, 'Default Hoster');
    addDownload({ movie_id: movieId, download_url: 'https://example.com/file' });

    const downloads = getDownloadsByMovieId(movieId);
    expect(downloads[0].hoster).toBe('');
  });

  it('should bulk-update download status by movie ID', () => {
    const movieId = addTestMovie(13, 'Bulk Status');
    addDownload({ movie_id: movieId, download_url: 'https://example.com/bulk1' });
    addDownload({ movie_id: movieId, download_url: 'https://example.com/bulk2' });
    addDownload({ movie_id: movieId, download_url: 'https://example.com/bulk3' });

    // All start as pending
    const before = getDownloadsByMovieId(movieId);
    expect(before.every(d => d.status === 'pending')).toBe(true);

    // Bulk update to sent_to_jd
    updateDownloadStatusByMovieId(movieId, 'sent_to_jd');

    const after = getDownloadsByMovieId(movieId);
    expect(after.every(d => d.status === 'sent_to_jd')).toBe(true);
  });

  it('should bulk-update only downloads for the specified movie', () => {
    const movie1 = addTestMovie(14, 'Bulk Movie 1');
    const movie2 = addTestMovie(15, 'Bulk Movie 2');
    addDownload({ movie_id: movie1, download_url: 'https://example.com/m1' });
    addDownload({ movie_id: movie2, download_url: 'https://example.com/m2' });

    updateDownloadStatusByMovieId(movie1, 'completed');

    expect(getDownloadsByMovieId(movie1)[0].status).toBe('completed');
    expect(getDownloadsByMovieId(movie2)[0].status).toBe('pending');
  });

  it('should track full download lifecycle: pending → sent_to_jd → completed', () => {
    const movieId = addTestMovie(16, 'Lifecycle');
    addDownload({ movie_id: movieId, download_url: 'https://example.com/lc1' });
    addDownload({ movie_id: movieId, download_url: 'https://example.com/lc2' });

    // Step 1: Send to JD
    updateDownloadStatusByMovieId(movieId, 'sent_to_jd');
    let downloads = getDownloadsByMovieId(movieId);
    expect(downloads.every(d => d.status === 'sent_to_jd')).toBe(true);

    // Step 2: Complete
    updateDownloadStatusByMovieId(movieId, 'completed');
    downloads = getDownloadsByMovieId(movieId);
    expect(downloads.every(d => d.status === 'completed')).toBe(true);
  });
});
