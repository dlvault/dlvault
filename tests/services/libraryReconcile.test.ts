import { describe, it, expect, vi, beforeEach } from 'vitest';

const { testDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      year INTEGER,
      imdb_id TEXT,
      tmdb_id INTEGER,
      status TEXT DEFAULT 'pending',
      media_type TEXT DEFAULT 'show',
      desired_quality TEXT
    )
  `);
  testDb.exec(`
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      desired_quality TEXT DEFAULT '1080p',
      source_url TEXT,
      last_checked_at TEXT,
      episode_count INTEGER DEFAULT NULL,
      aired_episodes INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
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
      UNIQUE(season_id, episode_number)
    )
  `);
  testDb.exec(`
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  return { testDb };
});

const mockSettings: Record<string, string> = {};

vi.mock('../../src/database/index', () => ({
  default: testDb,
  initDatabase: vi.fn(),
  getSetting: vi.fn((key: string) => mockSettings[key] ?? ''),
  setSetting: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Provider mock — getShowEpisodes is the only thing reconcile actually calls
const mockProvider = {
  isConfigured: vi.fn(() => true),
  getShowEpisodes: vi.fn(),
};

vi.mock('../../src/services/libraryProvider', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/libraryProvider')>(
    '../../src/services/libraryProvider',
  );
  return {
    ...actual,
    getLibraryProvider: () => mockProvider,
    getLibraryProviderName: () => 'Jellyfin',
  };
});

import { reconcileEpisodesWithLibrary } from '../../src/services/libraryReconcile';
import { addSeason } from '../../src/database/services/seasons';
import { addEpisodes, getEpisodesBySeasonId, updateEpisodeStatus } from '../../src/database/services/episodes';
import type { Movie } from '../../src/database/services/movies';

function makeShow(overrides: Partial<Movie> = {}): Movie {
  testDb.prepare(
    `INSERT INTO movies (title, year, imdb_id, tmdb_id, status, media_type)
     VALUES (?, ?, ?, ?, ?, 'show')`,
  ).run(
    overrides.title ?? 'Scrubs',
    overrides.year ?? 2001,
    overrides.imdb_id ?? 'tt0285403',
    overrides.tmdb_id ?? 4556,
    overrides.status ?? 'downloaded',
  );
  const row = testDb.prepare('SELECT * FROM movies ORDER BY id DESC LIMIT 1').get() as Movie;
  return row;
}

function getSeasonStatus(seasonId: number): string {
  return (testDb.prepare('SELECT status FROM seasons WHERE id = ?').get(seasonId) as any).status;
}

function clearTables() {
  testDb.exec('DELETE FROM episodes; DELETE FROM seasons; DELETE FROM movies; DELETE FROM activity_log;');
}

describe('reconcileEpisodesWithLibrary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    clearTables();
    mockProvider.isConfigured.mockReturnValue(true);
  });

  it('returns no-op when not a show', async () => {
    const movie = makeShow();
    testDb.prepare("UPDATE movies SET media_type = 'movie' WHERE id = ?").run(movie.id);
    const movieRow = testDb.prepare('SELECT * FROM movies WHERE id = ?').get(movie.id) as Movie;

    const r = await reconcileEpisodesWithLibrary(movieRow);
    expect(r.reconciled).toBe(false);
    expect(mockProvider.getShowEpisodes).not.toHaveBeenCalled();
  });

  it('returns no-op when provider not configured', async () => {
    mockProvider.isConfigured.mockReturnValue(false);
    const show = makeShow();
    const r = await reconcileEpisodesWithLibrary(show);
    expect(r.reconciled).toBe(false);
    expect(mockProvider.getShowEpisodes).not.toHaveBeenCalled();
  });

  it('returns no-op when reconcile setting is disabled', async () => {
    mockSettings['library.reconcile_episodes'] = 'false';
    const show = makeShow();
    const r = await reconcileEpisodesWithLibrary(show);
    expect(r.reconciled).toBe(false);
    expect(mockProvider.getShowEpisodes).not.toHaveBeenCalled();
  });

  it('returns no-op when provider call fails (null)', async () => {
    mockProvider.getShowEpisodes.mockResolvedValue(null);
    const show = makeShow();
    const r = await reconcileEpisodesWithLibrary(show);
    expect(r.reconciled).toBe(false);
    expect(r.resetCount).toBe(0);
    expect(r.addedCount).toBe(0);
  });

  it('skips reconciliation when show not in library (found:false)', async () => {
    mockProvider.getShowEpisodes.mockResolvedValue({ found: false, episodes: new Set() });
    const show = makeShow();
    const season = addSeason(show.id, 1);
    addEpisodes(season.id, [1, 2, 3]);
    for (const ep of getEpisodesBySeasonId(season.id)) {
      updateEpisodeStatus(ep.id, 'downloaded');
    }

    const r = await reconcileEpisodesWithLibrary(show);
    expect(r.reconciled).toBe(false);
    // DB untouched
    const eps = getEpisodesBySeasonId(season.id);
    expect(eps.every(e => e.status === 'downloaded')).toBe(true);
  });

  it('drift (A): resets DB-downloaded episodes that are missing from the library', async () => {
    // DB: 5 episodes marked downloaded. Library only has 3.
    mockProvider.getShowEpisodes.mockResolvedValue({
      found: true,
      episodes: new Set(['S01E01', 'S01E02', 'S01E03']),
    });
    const show = makeShow();
    const season = addSeason(show.id, 1);
    addEpisodes(season.id, [1, 2, 3, 4, 5]);
    for (const ep of getEpisodesBySeasonId(season.id)) {
      updateEpisodeStatus(ep.id, 'downloaded');
    }
    testDb.prepare("UPDATE seasons SET status = 'downloaded' WHERE id = ?").run(season.id);

    const r = await reconcileEpisodesWithLibrary(show);
    expect(r.reconciled).toBe(true);
    expect(r.resetCount).toBe(2);
    expect(r.addedCount).toBe(0);

    const eps = getEpisodesBySeasonId(season.id);
    const byNum = Object.fromEntries(eps.map(e => [e.episode_number, e.status]));
    expect(byNum[1]).toBe('downloaded');
    expect(byNum[2]).toBe('downloaded');
    expect(byNum[3]).toBe('downloaded');
    expect(byNum[4]).toBe('pending');
    expect(byNum[5]).toBe('pending');

    // Season was 'downloaded' — reopened because not all episodes downloaded anymore.
    expect(getSeasonStatus(season.id)).toBe('pending');
  });

  it('drift (B): adds library episodes the DB has never seen, as downloaded', async () => {
    // DB knows S01E01..E05. Library actually contains E01..E08 (e.g. season pack
    // had more files than Trakt's aired_episodes count at first sync).
    mockProvider.getShowEpisodes.mockResolvedValue({
      found: true,
      episodes: new Set(['S01E01', 'S01E02', 'S01E03', 'S01E04', 'S01E05', 'S01E06', 'S01E07', 'S01E08']),
    });
    const show = makeShow();
    const season = addSeason(show.id, 1);
    addEpisodes(season.id, [1, 2, 3, 4, 5]);
    for (const ep of getEpisodesBySeasonId(season.id)) {
      updateEpisodeStatus(ep.id, 'downloaded');
    }
    testDb.prepare("UPDATE seasons SET status = 'downloaded' WHERE id = ?").run(season.id);

    const r = await reconcileEpisodesWithLibrary(show);
    expect(r.reconciled).toBe(true);
    expect(r.resetCount).toBe(0);
    expect(r.addedCount).toBe(3);

    const eps = getEpisodesBySeasonId(season.id);
    expect(eps).toHaveLength(8);
    expect(eps.every(e => e.status === 'downloaded')).toBe(true);

    // All episodes downloaded — season stays 'downloaded'
    expect(getSeasonStatus(season.id)).toBe('downloaded');
  });

  it('drift (B): creates the season row when library has a season we never tracked', async () => {
    mockProvider.getShowEpisodes.mockResolvedValue({
      found: true,
      episodes: new Set(['S01E01', 'S02E01', 'S02E02']),
    });
    const show = makeShow();
    const s1 = addSeason(show.id, 1);
    addEpisodes(s1.id, [1]);
    for (const ep of getEpisodesBySeasonId(s1.id)) {
      updateEpisodeStatus(ep.id, 'downloaded');
    }

    const r = await reconcileEpisodesWithLibrary(show);
    expect(r.reconciled).toBe(true);
    expect(r.addedCount).toBe(2);

    const seasons = testDb.prepare('SELECT * FROM seasons WHERE movie_id = ? ORDER BY season_number').all(show.id) as any[];
    expect(seasons).toHaveLength(2);
    const s2 = seasons.find(s => s.season_number === 2)!;
    const s2Eps = getEpisodesBySeasonId(s2.id);
    expect(s2Eps).toHaveLength(2);
    expect(s2Eps.every(e => e.status === 'downloaded')).toBe(true);
  });

  it('does not touch episodes that are currently downloading', async () => {
    mockProvider.getShowEpisodes.mockResolvedValue({
      found: true,
      episodes: new Set(['S01E01']),
    });
    const show = makeShow();
    const season = addSeason(show.id, 1);
    addEpisodes(season.id, [1, 2]);
    // E01 downloaded, E02 downloading — library only has E01
    const eps = getEpisodesBySeasonId(season.id);
    updateEpisodeStatus(eps.find(e => e.episode_number === 1)!.id, 'downloaded');
    updateEpisodeStatus(eps.find(e => e.episode_number === 2)!.id, 'downloading');

    const r = await reconcileEpisodesWithLibrary(show);
    expect(r.reconciled).toBe(true);
    expect(r.resetCount).toBe(0); // downloading stays untouched

    const after = getEpisodesBySeasonId(season.id);
    const byNum = Object.fromEntries(after.map(e => [e.episode_number, e.status]));
    expect(byNum[1]).toBe('downloaded');
    expect(byNum[2]).toBe('downloading');
  });

  it('ignores specials (season 0) from the library', async () => {
    mockProvider.getShowEpisodes.mockResolvedValue({
      found: true,
      episodes: new Set(['S00E01', 'S01E01']),
    });
    const show = makeShow();
    const season = addSeason(show.id, 1);
    addEpisodes(season.id, [1]);
    for (const ep of getEpisodesBySeasonId(season.id)) {
      updateEpisodeStatus(ep.id, 'downloaded');
    }

    const r = await reconcileEpisodesWithLibrary(show);
    expect(r.reconciled).toBe(true);

    // No season 0 row should have been created
    const seasons = testDb.prepare('SELECT * FROM seasons WHERE movie_id = ?').all(show.id) as any[];
    expect(seasons.every(s => s.season_number !== 0)).toBe(true);
  });

  it('writes activity log entries for resets and adds', async () => {
    mockProvider.getShowEpisodes.mockResolvedValue({
      found: true,
      episodes: new Set(['S01E01', 'S01E03']),
    });
    const show = makeShow();
    const season = addSeason(show.id, 1);
    addEpisodes(season.id, [1, 2]);
    for (const ep of getEpisodesBySeasonId(season.id)) {
      updateEpisodeStatus(ep.id, 'downloaded');
    }

    await reconcileEpisodesWithLibrary(show);

    const logs = testDb.prepare(
      "SELECT * FROM activity_log WHERE action = 'library_reconciled' ORDER BY id",
    ).all() as any[];
    // Expect 1 reset (E02) + 1 add (E03)
    expect(logs).toHaveLength(2);
    expect(logs.some(l => l.details.includes('S01E02'))).toBe(true);
    expect(logs.some(l => l.details.includes('S01E03'))).toBe(true);
  });

  it('re-aggregates season status to downloaded when all episodes are present', async () => {
    mockProvider.getShowEpisodes.mockResolvedValue({
      found: true,
      episodes: new Set(['S01E01', 'S01E02', 'S01E03']),
    });
    const show = makeShow();
    const season = addSeason(show.id, 1);
    addEpisodes(season.id, [1, 2, 3]);
    // All in DB as downloaded, season is 'pending' for some reason
    for (const ep of getEpisodesBySeasonId(season.id)) {
      updateEpisodeStatus(ep.id, 'downloaded');
    }
    testDb.prepare("UPDATE seasons SET status = 'pending' WHERE id = ?").run(season.id);

    await reconcileEpisodesWithLibrary(show);
    expect(getSeasonStatus(season.id)).toBe('downloaded');
  });
});
