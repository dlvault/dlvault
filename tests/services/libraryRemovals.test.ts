import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applySchema } from '../../src/database/schema';

const { testDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  return { testDb };
});
vi.mock('../../src/database/index', () => ({ default: testDb, db: testDb, getSetting: vi.fn(() => '') }));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
applySchema(testDb);

import { isWatched, snapshotWatched, classifyMissing, applyMissingVerdict, moviesRootHealthy, _resetLibraryRemovals } from '../../src/services/libraryRemovals';
import { getMovieById, getAllMovies } from '../../src/database/services/movies';

const add = (id: number, title: string, over: Record<string, any> = {}) => {
  const row = { imdb_id: `tt900000${id}`, tmdb_id: 9000 + id, year: 2024, status: 'downloaded', media_type: 'movie', ...over };
  testDb.prepare(`INSERT INTO movies (id, title, year, imdb_id, tmdb_id, status, media_type, watched_at, removed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, title, row.year, row.imdb_id, row.tmdb_id, row.status, row.media_type, row.watched_at ?? null, row.removed_at ?? null);
};
const logs = (action: string) => testDb.prepare('SELECT movie_id, details FROM activity_log WHERE action = ?').all(action) as any[];

describe('libraryRemovals', () => {
  beforeEach(() => {
    testDb.exec('DELETE FROM activity_log; DELETE FROM movies;');
    _resetLibraryRemovals();
  });

  it('matches watched entries by IMDb, TMDb, or title and year — never by title alone', () => {
    const m = { imdb_id: 'tt9000001', tmdb_id: 77, title: 'Müde Füchse', year: 2024 };
    expect(isWatched(m, [{ imdbId: 'tt9000001', tmdbId: null, name: 'x', year: null }])).toBe(true);
    expect(isWatched(m, [{ imdbId: null, tmdbId: '77', name: 'x', year: null }])).toBe(true);
    expect(isWatched(m, [{ imdbId: null, tmdbId: null, name: 'Muede Fuechse!', year: 2024 }])).toBe(false);
    expect(isWatched(m, [{ imdbId: null, tmdbId: null, name: 'müde füchse', year: 2024 }])).toBe(true);
    expect(isWatched(m, [{ imdbId: null, tmdbId: null, name: 'Müde Füchse', year: 1990 }])).toBe(false);
  });

  it('matches a watched film by its file name when the server misidentified it', () => {
    const m = { imdb_id: null, tmdb_id: null, title: 'Grell', year: 2024 };
    const w = (files: string[]) => [{ imdbId: null, tmdbId: null, name: 'Der Grelle Läufer', year: 2019, files }];
    expect(isWatched(m as any, w(['/data/Filme/Grell (2024)/Grell (2024).mkv']))).toBe(true);
    expect(isWatched(m as any, w(['/data/Filme/Sandmere (2024)/Sandmere (2024).mkv']))).toBe(false);
    expect(isWatched(m as any, w([]))).toBe(false);
  });

  it('snapshots watch state of present films, at most every 6 hours, and never on an unknown answer', async () => {
    add(1, 'Grell'); add(2, 'Sandmere'); add(3, 'Wardline', { status: 'pending' });
    const provider: any = { isConfigured: () => true, getWatchedMovies: vi.fn(async () => [
      { imdbId: 'tt9000001', tmdbId: null, name: 'Grell', year: 2024 },
      { imdbId: 'tt9000003', tmdbId: null, name: 'Wardline', year: 2024 },
    ]) };
    expect(await snapshotWatched(getAllMovies(), provider, 1_000_000_000)).toBe(1);
    expect(getMovieById(1)!.watched_at).toBeTruthy();
    expect(getMovieById(2)!.watched_at).toBeNull();
    expect(getMovieById(3)!.watched_at).toBeNull();          // not in the library yet
    expect(await snapshotWatched(getAllMovies(), provider, 1_000_000_000 + 60_000)).toBe(0);
    expect(provider.getWatchedMovies).toHaveBeenCalledTimes(1);

    _resetLibraryRemovals();
    const down: any = { isConfigured: () => true, getWatchedMovies: async () => null };
    expect(await snapshotWatched(getAllMovies(), down, 2_000_000_000)).toBe(0);
  });

  it('treats an unreadable/empty films folder or many vanished films as a storage problem', () => {
    const films = Array.from({ length: 6 }, (_, i) => ({ id: i, watched_at: null }) as any);
    expect(classifyMissing(films.slice(0, 1), 40, false).mass).toBe(true);
    expect(classifyMissing(films.slice(0, 4), 40, true).mass).toBe(false);
    expect(classifyMissing(films.slice(0, 5), 40, true).mass).toBe(true);     // max(5, 10 % of 40)
    expect(classifyMissing(films.slice(0, 6), 100, true).mass).toBe(false);   // 10 % of 100 = 10
  });

  it('splits single losses into deliberately deleted (watched) and unexplained', () => {
    const v = classifyMissing([{ id: 1, watched_at: '2026-10-01 10:00:00' } as any, { id: 2, watched_at: null } as any], 40, true);
    expect(v.removed.map(m => m.id)).toEqual([1]);
    expect(v.unexplained.map(m => m.id)).toEqual([2]);
  });

  it('marks watched losses silently, lists unexplained ones once a day, warns about mass loss once a day', () => {
    add(1, 'Grell', { watched_at: '2026-10-01 10:00:00' }); add(2, 'Sandmere');
    const notify = vi.fn();
    const v = classifyMissing([getMovieById(1)!, getMovieById(2)!], 40, true);
    applyMissingVerdict(v, 2, notify);
    applyMissingVerdict(v, 2, notify);
    expect(getMovieById(1)!.removed_at).toBeTruthy();
    expect(logs('library_missing').map(r => r.movie_id)).toEqual([2]);
    expect(notify).not.toHaveBeenCalled();

    const mass = classifyMissing([], 40, false);
    applyMissingVerdict(mass, 12, notify);
    applyMissingVerdict(mass, 12, notify);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(logs('library_mass_missing')).toHaveLength(1);
  });

  describe('moviesRootHealthy', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-root-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    it('needs an existing folder with at least one visible entry', () => {
      expect(moviesRootHealthy(undefined)).toBe(false);
      expect(moviesRootHealthy(path.join(dir, 'nope'))).toBe(false);
      fs.mkdirSync(path.join(dir, '.dlvault-backup'));
      expect(moviesRootHealthy(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, 'Grell (2024).mkv'), 'x');
      expect(moviesRootHealthy(dir)).toBe(true);
    });
  });
});
