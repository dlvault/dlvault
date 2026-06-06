import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// postprocess.ts imports the DB layer + several services at module load. Mock
// the side-effecting modules so the import is inert; fs/path stay real because
// pathSizeBytes is exercised against an actual temp directory tree.
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

import { pathSizeBytes } from '../../src/services/postprocess';

describe('postprocess pathSizeBytes — cross-device copy verification primitive', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-size-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the byte size of a single file', () => {
    const f = path.join(tmp, 'a.bin');
    fs.writeFileSync(f, Buffer.alloc(1234));
    expect(pathSizeBytes(f)).toBe(1234);
  });

  it('sums all files recursively in a directory tree', () => {
    fs.writeFileSync(path.join(tmp, 'top.bin'), Buffer.alloc(100));
    const sub = path.join(tmp, 'season', 'extras');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'season', 'ep.bin'), Buffer.alloc(2000));
    fs.writeFileSync(path.join(sub, 'sample.bin'), Buffer.alloc(50));
    expect(pathSizeBytes(tmp)).toBe(2150);
  });

  it('returns 0 for a missing path (so verification fails closed)', () => {
    expect(pathSizeBytes(path.join(tmp, 'does-not-exist'))).toBe(0);
  });

  it('detects a truncated/partial copy (dest smaller than source)', () => {
    // Mirrors the moveFolder check: a dest with fewer bytes than the source
    // must be flagged so the source is never deleted after an incomplete copy.
    const src = path.join(tmp, 'src');
    const dst = path.join(tmp, 'dst');
    fs.mkdirSync(src); fs.mkdirSync(dst);
    fs.writeFileSync(path.join(src, 'movie.mkv'), Buffer.alloc(5000));
    fs.writeFileSync(path.join(dst, 'movie.mkv'), Buffer.alloc(1500)); // interrupted copy
    expect(pathSizeBytes(dst)).toBeLessThan(pathSizeBytes(src));
  });
});
