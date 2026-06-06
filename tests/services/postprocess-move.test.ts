import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';

/**
 * moveFolder across devices — the NORMAL path in a container, where /downloads
 * and /movies are separate mounts and rename() fails with EXDEV. This file
 * mocks 'fs' on its own so the other post-processor suites keep the real one.
 */
const fx = vi.hoisted(() => ({ srcRoot: '', crossDevice: true, failCopy: false }));
vi.mock('fs', async (importOriginal) => {
  const actual: any = await importOriginal();
  const renameSync = (a: string, b: string) => {
    if (fx.crossDevice && fx.srcRoot && a.startsWith(fx.srcRoot) && !b.startsWith(fx.srcRoot)) {
      const err: any = new Error('EXDEV: cross-device link not permitted');
      err.code = 'EXDEV';
      throw err;
    }
    return actual.renameSync(a, b);
  };
  const promises = {
    ...actual.promises,
    cp: async (a: string, b: string, o: any) => {
      if (fx.failCopy) {
        // Write half, then fail — a full disk mid-copy.
        actual.writeFileSync(b, 'half');
        throw new Error('ENOSPC: no space left on device');
      }
      return actual.promises.cp(a, b, o);
    },
  };
  const mod = { ...actual, renameSync, promises };
  return { ...mod, default: mod };
});

vi.mock('../../src/database/index', () => ({ getSetting: vi.fn(() => ''), db: {} }));
vi.mock('../../src/database/services/movies', () => ({
  getAllMovies: vi.fn(() => []), updateMovieStatus: vi.fn(), incrementRetryCount: vi.fn(),
}));
vi.mock('../../src/database/services/downloads', () => ({
  getDownloadsByMovieIds: vi.fn(() => []), updateDownloadStatusByMovieId: vi.fn(),
}));
vi.mock('../../src/database/services/blocklist', () => ({
  addBlocklistEntry: vi.fn(), isReleaseBlocklisted: vi.fn(() => false),
}));
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: vi.fn() }));
vi.mock('../../src/database/services/seasons', () => ({
  getSeasonsByShowId: vi.fn(() => []), updateSeasonStatus: vi.fn(),
}));
vi.mock('../../src/database/services/episodes', () => ({ markAllEpisodesDownloaded: vi.fn() }));
vi.mock('../../src/jdownloader/index', () => ({ jdownloaderService: {} }));
vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({ isConfigured: () => false })), getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));
vi.mock('../../src/services/trakt', () => ({ traktService: {} }));
vi.mock('../../src/services/telegram', () => ({ sendTelegramNotification: vi.fn() }));
vi.mock('../../src/services/eventbus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn() } }));
vi.mock('../../src/services/scheduler', () => ({ processingMovies: new Set() }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import fs from 'fs';
import { moveFolder, removeOtherCopies } from '../../src/services/postprocess';

describe('moveFolder across devices', () => {
  let root: string, src: string, lib: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-xdev-'));
    src = path.join(root, 'downloads');
    lib = path.join(root, 'movies');
    fs.mkdirSync(src); fs.mkdirSync(lib);
    fx.srcRoot = src; fx.crossDevice = true; fx.failCopy = false;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lands the file under its final name with no temporary left behind', async () => {
    fs.writeFileSync(path.join(src, 'film.mkv'), 'new-content');
    await moveFolder(path.join(src, 'film.mkv'), path.join(lib, 'Film (2024).mkv'));

    expect(fs.readFileSync(path.join(lib, 'Film (2024).mkv'), 'utf8')).toBe('new-content');
    expect(fs.readdirSync(lib)).toEqual(['Film (2024).mkv']);
    expect(fs.existsSync(path.join(src, 'film.mkv'))).toBe(false);
  });

  it('keeps the existing library file when the copy of an upgrade fails midway', async () => {
    // The old file used to be deleted BEFORE the copy: a full disk left a
    // truncated file under the real name and the good one gone.
    fs.writeFileSync(path.join(lib, 'Film (2024).mkv'), 'good-old-copy');
    fs.writeFileSync(path.join(src, 'film.mkv'), 'upgrade-content');
    fx.failCopy = true;

    await expect(moveFolder(path.join(src, 'film.mkv'), path.join(lib, 'Film (2024).mkv'), { isUpgrade: true }))
      .rejects.toThrow('ENOSPC');

    expect(fs.readFileSync(path.join(lib, 'Film (2024).mkv'), 'utf8')).toBe('good-old-copy');
    expect(fs.readdirSync(lib)).toEqual(['Film (2024).mkv']);          // no half file, no temp
    expect(fs.existsSync(path.join(src, 'film.mkv'))).toBe(true);      // source kept for a retry
  });

  it('never replaces a library file with one that is not larger (re-delivered pack, worse release)', async () => {
    // Seen live: a season pack delivered twice — the same-size copy must be
    // discarded, not copied over the file the media server already indexed.
    fs.writeFileSync(path.join(lib, 'Film (2024).mkv'), 'library-copy');        // 12 bytes
    fs.writeFileSync(path.join(src, 'same.mkv'), 'samesize-new');               // 12 bytes
    fs.writeFileSync(path.join(src, 'smaller.mkv'), 'tiny');
    await moveFolder(path.join(src, 'same.mkv'), path.join(lib, 'Film (2024).mkv'));
    await moveFolder(path.join(src, 'smaller.mkv'), path.join(lib, 'Film (2024).mkv'));
    expect(fs.readFileSync(path.join(lib, 'Film (2024).mkv'), 'utf8')).toBe('library-copy');
    expect(fs.existsSync(path.join(src, 'same.mkv'))).toBe(false);              // discarded, not left behind
    expect(fs.existsSync(path.join(src, 'smaller.mkv'))).toBe(false);
    // A larger one does replace it.
    fs.writeFileSync(path.join(src, 'bigger.mkv'), 'a-clearly-larger-copy');
    await moveFolder(path.join(src, 'bigger.mkv'), path.join(lib, 'Film (2024).mkv'));
    expect(fs.readFileSync(path.join(lib, 'Film (2024).mkv'), 'utf8')).toBe('a-clearly-larger-copy');
  });

  it('replaces the library file only once the new copy is complete', async () => {
    fs.writeFileSync(path.join(lib, 'Film (2024).mkv'), 'old');
    fs.writeFileSync(path.join(src, 'film.mkv'), 'upgrade-content');
    await moveFolder(path.join(src, 'film.mkv'), path.join(lib, 'Film (2024).mkv'), { isUpgrade: true });
    expect(fs.readFileSync(path.join(lib, 'Film (2024).mkv'), 'utf8')).toBe('upgrade-content');
  });

  it('removes the replaced copy also under an older name scheme, never another film', () => {
    const put = (n: string) => { const f = path.join(root, n); fs.writeFileSync(f, 'x'); return f; };
    const keep = put('Grell (2017) [imdbid-tt9000001].mkv');
    put('Grell (2017).mkv');                              // old template — replaced
    put('Grell (2017) [imdbid-tt9000002].mkv');          // same name, other film
    put('Grell 2 (2017).mkv');                            // sequel
    put('Grell (2018).mkv');                              // remake
    removeOtherCopies(root, 'Grell (2017) [imdbid-tt9000001]', keep, 'Test',
      { id: 1, title: 'Grell', year: 2017, imdb_id: 'tt9000001' } as any);
    expect(fs.readdirSync(root).filter(n => n.endsWith('.mkv')).sort()).toEqual([
      'Grell (2017) [imdbid-tt9000001].mkv', 'Grell (2017) [imdbid-tt9000002].mkv', 'Grell (2018).mkv', 'Grell 2 (2017).mkv',
    ]);
  });

  it('removes a copy imported before the year was known only when its id says so', () => {
    const put = (n: string) => { const f = path.join(root, n); fs.writeFileSync(f, 'x'); return f; };
    const keep = put('Grell (2017) [imdbid-tt9000001].mkv');
    put('Grell [imdbid-tt9000001].mkv');                 // same film, no year yet — replaced
    put('Grell [imdbid-tt9000002].mkv');                 // other film
    put('Grell.mkv');                                     // no id: could be a remake
    removeOtherCopies(root, 'Grell (2017) [imdbid-tt9000001]', keep, 'Test',
      { id: 1, title: 'Grell', year: 2017, imdb_id: 'tt9000001' } as any);
    expect(fs.readdirSync(root).filter(n => n.endsWith('.mkv')).sort()).toEqual([
      'Grell (2017) [imdbid-tt9000001].mkv', 'Grell [imdbid-tt9000002].mkv', 'Grell.mkv',
    ]);
  });
});
