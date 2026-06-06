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
const st = vi.hoisted(() => ({
  disk: new Map<number, Set<string>>(),
  server: new Map<number, { found: boolean; episodes: Set<string> } | null>(),
  refresh: vi.fn(async () => true),
}));
vi.mock('../../src/database/index', () => ({ default: testDb, db: testDb, getSetting: vi.fn(() => '') }));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/services/integrityCheck', () => ({ libraryEpisodesOnDisk: (m: any) => st.disk.get(m.id) ?? null }));
vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: () => ({
    isConfigured: () => true,
    getShowEpisodes: async (_i: any, _t: any, title: string) => st.server.get(title === 'Grell' ? 1 : 2) ?? null,
    refreshLibrary: st.refresh,
  }),
  getLibraryProviderName: () => 'Jellyfin',
}));
applySchema(testDb);

import { checkShowsAgainstServer, checkDatabase, checkJdPackages, checkDownloadFolder, checkLibraryFolders, checkImportStalls, libraryKey, _resetWatchdog } from '../../src/services/watchdog';
import { getAllMovies } from '../../src/database/services/movies';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const show = (id: number, title: string, status = 'downloaded', extra = '') =>
  testDb.prepare(`INSERT INTO movies (id, title, year, media_type, status${extra ? ', ' + extra.split('=')[0] : ''}) VALUES (?, ?, 2024, 'show', ?${extra ? ', ' + extra.split('=')[1] : ''})`).run(id, title, status);

describe('watchdog', () => {
  beforeEach(() => {
    testDb.exec('DELETE FROM episodes; DELETE FROM seasons; DELETE FROM downloads; DELETE FROM activity_log; DELETE FROM movies;');
    st.disk.clear(); st.server.clear(); st.refresh.mockClear(); _resetWatchdog();
  });

  describe('episodes on disk vs media server', () => {
    it('reports episodes the server does not list and asks for a rescan', async () => {
      show(1, 'Grell');
      testDb.prepare("INSERT INTO activity_log (movie_id, action, created_at) VALUES (1, 'moved_to_library', '2026-10-13 10:00:00')").run();
      st.disk.set(1, new Set(['1x1', '1x2', '2x1']));
      st.server.set(1, { found: true, episodes: new Set(['S01E01']) });
      const f = await checkShowsAgainstServer(getAllMovies(), NOW);
      expect(f).toHaveLength(1);
      expect(f[0].detail).toContain('S01E02, S02E01');
      expect(st.refresh).toHaveBeenCalledTimes(1);
    });

    it('stays quiet right after a move, when everything is listed, or when the server is unreachable', async () => {
      show(1, 'Grell'); show(2, 'Sandmere');
      testDb.prepare("INSERT INTO activity_log (movie_id, action, created_at) VALUES (1, 'moved_to_library', '2026-10-14 09:00:00')").run();
      st.disk.set(1, new Set(['1x1'])); st.server.set(1, { found: true, episodes: new Set() });
      st.disk.set(2, new Set(['1x1'])); st.server.set(2, null);
      expect(await checkShowsAgainstServer(getAllMovies(), NOW)).toEqual([]);
    });
  });

  describe('database consistency', () => {
    it('flags a season marked done with fewer episodes than aired, and a done show with an open season', () => {
      show(1, 'Grell');
      testDb.exec(`INSERT INTO seasons (id, movie_id, season_number, status, aired_episodes) VALUES (10, 1, 1, 'downloaded', 8), (11, 1, 2, 'pending', 8);
        INSERT INTO episodes (season_id, episode_number, status) VALUES (10, 1, 'downloaded'), (10, 2, 'downloaded');`);
      const f = checkDatabase(getAllMovies());
      expect(f.map(x => x.kind).sort()).toEqual(['Serie fertig, Staffel offen', 'Staffel falsch als fertig markiert']);
    });

    it('ignores seasons below the cutoff and seasons without episode rows', () => {
      show(1, 'Grell', 'downloaded', 'season_cutoff=2');
      testDb.exec(`INSERT INTO seasons (id, movie_id, season_number, status, aired_episodes) VALUES (10, 1, 1, 'pending', 8), (11, 1, 2, 'downloaded', 8);`);
      expect(checkDatabase(getAllMovies())).toEqual([]);
    });
  });

  it('reports JD packages that belong to no title, also accepting old "(0)" names', () => {
    testDb.exec("INSERT INTO movies (id, title, year, media_type, status) VALUES (1, 'Grell', 2026, 'show', 'downloading')");
    const f = checkJdPackages(getAllMovies(), [
      { uuid: 1, name: 'Grell (0) - S01 - 1080p' }, { uuid: 2, name: 'Grell (2026) - S02 - 1080p' }, { uuid: 3, name: 'Fremdes Paket' },
    ] as any);
    expect(f.map(x => x.title)).toEqual(['Fremdes Paket']);
  });

  describe('files on disk', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-wd-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const old = (p: string) => { const t = (NOW - 3 * 86400_000) / 1000; fs.utimesSync(p, t, t); };

    it('lists stale download leftovers, but not running downloads, JD folders, music or fresh files', () => {
      testDb.exec("INSERT INTO movies (id, title, year, media_type, status) VALUES (1, 'Grell', 2026, 'show', 'downloading')");
      for (const d of ['Wardline.2020.GERMAN.1080p-GRP', 'unfertige/Grell (0) - S01 - 1080p', 'unfertige/Paket X', 'music']) fs.mkdirSync(path.join(dir, d), { recursive: true });
      fs.writeFileSync(path.join(dir, 'grell.s01e01.german.1080p-grp.mkv'), 'x');
      // The age uses ctime too, which utimes cannot set back: measure from the real clock.
      const created = Date.now();
      const f = checkDownloadFolder(dir, getAllMovies(), [{ uuid: 9, name: 'Paket X', saveTo: '/output/unfertige/Paket X' }] as any, created + 3 * 86400_000);
      expect(f.map(x => x.title)).toEqual(['Wardline.2020.GERMAN.1080p-GRP']);
      expect(checkDownloadFolder(dir, getAllMovies(), [], created)).toEqual([]);   // nothing is a day old yet
    });

    it('finds "(Unknown)" folders, junk in the films root and the same film twice', () => {
      const films = path.join(dir, 'Filme'); const series = path.join(dir, 'Serien');
      fs.mkdirSync(films); fs.mkdirSync(path.join(series, 'Wardline (Unknown)'), { recursive: true });
      fs.writeFileSync(path.join(films, 'Grell (2024).mkv'), 'x');
      fs.mkdirSync(path.join(films, 'Grell.2024.German.DL.1080p.BluRay.x264-GRP'));
      fs.writeFileSync(path.join(films, 'Grell.2024.German.DL.1080p.BluRay.x264-GRP', 'grell.mkv'), 'x');
      fs.writeFileSync(path.join(films, 'Sandmere (1990).mkv'), 'x');
      fs.writeFileSync(path.join(films, 'Sandmere (2022).mkv'), 'x');
      fs.mkdirSync(path.join(films, 'Sample'));
      fs.writeFileSync(path.join(films, 'PREMIUM FULL SPEED.url'), 'x');
      const f = checkLibraryFolders([{ label: 'Filme', dir: films, films: true }, { label: 'Serien', dir: series, films: false }]);
      expect(f.map(x => x.kind).sort()).toEqual(['Film doppelt in der Bibliothek', 'Ordner ohne Jahr', 'Reste in der Bibliothek']);
      expect(f.find(x => x.kind === 'Film doppelt in der Bibliothek')!.detail).toContain('Grell (2024).mkv');
    });
  });

  describe('end of the chain', () => {
    const H = 3600_000;
    it('reports a package finished for over an hour whose title never reached the library', () => {
      testDb.exec("INSERT INTO movies (id, title, year, media_type, status, updated_at) VALUES (1, 'Grell', 2024, 'movie', 'downloading', '2026-10-14 08:00:00')");
      const pkgs = [{ uuid: 7, name: 'Grell (2024) - 2160p', finished: true }] as any;
      expect(checkImportStalls(getAllMovies(), pkgs, NOW)).toEqual([]);              // first sighting
      expect(checkImportStalls(getAllMovies(), pkgs, NOW + 30 * 60_000)).toEqual([]); // still inside the hour
      const f = checkImportStalls(getAllMovies(), pkgs, NOW + 2 * H);
      expect(f.map(x => x.kind)).toEqual(['Import hängt']);
      expect(checkImportStalls(getAllMovies(), [{ ...pkgs[0], finished: false }], NOW + 3 * H)).toEqual([]);
    });

    it('raises one alarm when titles download for days and nothing gets imported', () => {
      testDb.exec("INSERT INTO movies (id, title, year, media_type, status, updated_at) VALUES (1, 'Grell', 2024, 'movie', 'downloading', '2026-10-10 08:00:00')");
      testDb.exec("INSERT INTO activity_log (movie_id, action, created_at) VALUES (NULL, 'moved_to_library', '2026-10-09 10:00:00')");
      expect(checkImportStalls(getAllMovies(), [], NOW).map(x => x.kind)).toEqual(['Seit Tagen kein Import']);
      testDb.exec("INSERT INTO activity_log (movie_id, action, created_at) VALUES (NULL, 'moved_to_library', '2026-10-14 10:00:00')");
      expect(checkImportStalls(getAllMovies(), [], NOW)).toEqual([]);
    });
  });

  it('reads title and year from library and release names alike', () => {
    expect(libraryKey('Grell (2024).mkv')).toEqual({ title: 'grell', year: '2024' });
    expect(libraryKey('Grell.2024.German.DL.1080p-GRP')).toEqual({ title: 'grell', year: '2024' });
    expect(libraryKey('Sandmere Ein Fall (Unknown)').year).toBeNull();
  });
});
