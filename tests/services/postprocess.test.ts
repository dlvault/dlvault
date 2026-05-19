import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Mutable mock state, reset in beforeEach ────────────────────────────────
const mockSettings: Record<string, string> = {};
let mockMovies: any[] = [];
let mockDownloadsByMovie = new Map<number, any[]>();
let mockSeasonsByShow = new Map<number, any[]>();
// seasonId -> episode rows. Drives markEpisodesDownloaded + getSeasonCompletionStatus
// so per-episode marking and partial-season logic can be asserted realistically.
let mockEpisodesBySeason = new Map<number, { episode_number: number; status: string }[]>();

// JDownloader mock state
const jdState = {
  configured: false,
  downloadPackages: [] as any[],
  linkGrabberPackages: [] as any[],
  downloadLinks: [] as any[],
  linkGrabberLinks: [] as any[],
  // When true, the corresponding query mock resolves to null instead of the
  // array — simulating a failed JD device call (outage / auth blip).
  downloadPackagesReturnsNull: false,
  linkGrabberPackagesReturnsNull: false,
};

// Library provider mock state
const libState = {
  configured: false,
  hasMovie: false,
};

// Trakt mock state
const traktState = {
  configured: false,
  authenticated: false,
};

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] ?? ''),
  setSetting: vi.fn(),
  initDatabase: vi.fn(),
}));

vi.mock('../../src/database/services/movies', () => ({
  getAllMovies: vi.fn(() => mockMovies),
  getMoviesByStatus: vi.fn(() => []),
  updateMovieStatus: vi.fn((id: number, status: string) => {
    const m = mockMovies.find(mm => mm.id === id);
    if (m) m.status = status;
  }),
  incrementRetryCount: vi.fn(),
  markJdSeen: vi.fn((id: number) => {
    const m = mockMovies.find(mm => mm.id === id);
    if (m) m.last_jd_check_at = new Date().toISOString();
  }),
}));

vi.mock('../../src/database/services/downloads', () => ({
  getDownloadsByMovieIds: vi.fn((ids: number[]) => {
    const map = new Map<number, any[]>();
    for (const id of ids) {
      if (mockDownloadsByMovie.has(id)) map.set(id, mockDownloadsByMovie.get(id)!);
    }
    return map;
  }),
  updateDownloadStatusByMovieId: vi.fn(),
}));

vi.mock('../../src/database/services/blocklist', () => ({
  addBlocklistEntry: vi.fn(),
  isReleaseBlocklisted: vi.fn(() => false),
}));

vi.mock('../../src/database/services/activityLog', () => ({
  addLogEntry: vi.fn(),
  hasRecentActivityEntry: vi.fn(() => false),
}));

vi.mock('../../src/database/services/seasons', () => ({
  getSeasonsByShowId: vi.fn((id: number) => mockSeasonsByShow.get(id) || []),
  updateSeasonStatus: vi.fn((seasonId: number, status: string) => {
    for (const seasons of mockSeasonsByShow.values()) {
      const s = seasons.find((ss: any) => ss.id === seasonId);
      if (s) s.status = status;
    }
  }),
}));

vi.mock('../../src/database/services/episodes', () => ({
  markAllEpisodesDownloaded: vi.fn(),
  markEpisodesDownloaded: vi.fn((seasonId: number, nums: number[]) => {
    const eps = mockEpisodesBySeason.get(seasonId) || [];
    for (const n of nums) {
      let e = eps.find(x => x.episode_number === n);
      if (!e) { e = { episode_number: n, status: 'pending' }; eps.push(e); }
      e.status = 'downloaded';
    }
    mockEpisodesBySeason.set(seasonId, eps);
  }),
  getSeasonCompletionStatus: vi.fn((seasonId: number) => {
    const eps = mockEpisodesBySeason.get(seasonId) || [];
    if (eps.length === 0) return { total: 0, downloaded: 0, allDone: false };
    const downloaded = eps.filter(e => e.status === 'downloaded').length;
    return { total: eps.length, downloaded, allDone: downloaded === eps.length };
  }),
}));

vi.mock('../../src/jdownloader/index', () => ({
  jdownloaderService: {
    isConfigured: vi.fn(() => jdState.configured),
    getDownloadPackages: vi.fn(() => Promise.resolve(jdState.downloadPackagesReturnsNull ? null : jdState.downloadPackages)),
    getLinkGrabberPackages: vi.fn(() => Promise.resolve(jdState.linkGrabberPackagesReturnsNull ? null : jdState.linkGrabberPackages)),
    getDownloadLinks: vi.fn(() => Promise.resolve(jdState.downloadLinks)),
    getLinkGrabberLinks: vi.fn(() => Promise.resolve(jdState.linkGrabberLinks)),
    removeLinkGrabberPackages: vi.fn(() => Promise.resolve()),
    removePackages: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({
    isConfigured: () => libState.configured,
    hasMovie: async () => libState.hasMovie,
  })),
  getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));

vi.mock('../../src/services/trakt', () => ({
  traktService: {
    isConfigured: vi.fn(() => traktState.configured),
    isAuthenticated: vi.fn(() => traktState.authenticated),
    markAsCollected: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../../src/services/notifications', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../../src/services/eventbus', () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock('../../src/services/scheduler', () => ({
  processingMovies: new Set<number>(),
}));

vi.mock('../../src/services/telegram', () => ({
  sendTelegramNotification: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  normalizeTitle,
  folderMatchesMovie,
  startPostProcessor,
  stopPostProcessor,
  applyRenameTemplate,
  pickMainMediaFile,
  parseSeasonEpisode,
  isKidsContent,
  resolveLibraryTarget,
  jdPackageErrorKind,
} from '../../src/services/postprocess';
import { updateMovieStatus } from '../../src/database/services/movies';
import { updateDownloadStatusByMovieId } from '../../src/database/services/downloads';
import { addLogEntry } from '../../src/database/services/activityLog';
import { addBlocklistEntry } from '../../src/database/services/blocklist';
import { updateSeasonStatus } from '../../src/database/services/seasons';
import { markEpisodesDownloaded } from '../../src/database/services/episodes';
import { sendTelegramNotification } from '../../src/services/telegram';
import { jdownloaderService } from '../../src/jdownloader/index';
import { processingMovies } from '../../src/services/scheduler';

// ── Helpers ────────────────────────────────────────────────────────────────
function makeMovie(over: Partial<any> = {}): any {
  return {
    id: 1,
    imdb_id: 'tt0001',
    tmdb_id: 100,
    title: 'Test Movie',
    year: 2024,
    media_type: 'movie',
    status: 'downloading',
    updated_at: new Date().toISOString(),
    last_checked_at: null,
    retry_count: 0,
    ...over,
  };
}

function makeDownload(over: Partial<any> = {}): any {
  return {
    id: 1,
    movie_id: 1,
    release_name: 'Test.Movie.2024.GERMAN.1080p.WEB-DL',
    quality: '1080p',
    audio: 'DTS',
    hoster: 'host-a',
    download_url: 'https://example.com/file.rar',
    status: 'sent_to_jd',
    ...over,
  };
}

function writeMedia(p: string, sizeMB: number) {
  fs.writeFileSync(p, Buffer.alloc(sizeMB * 1024 * 1024));
}

// Drives one full post-processor cycle and waits for async work to settle.
// Uses fake timers: startPostProcessor schedules an initial run at +15s.
async function runOneCycle(): Promise<void> {
  startPostProcessor();
  await vi.advanceTimersByTimeAsync(15_001);
  stopPostProcessor();
  // Flush any trailing microtasks
  await Promise.resolve();
}

// Drives a cycle far enough to trigger the +60s reconcileDatabase pass too.
async function runReconcile(): Promise<void> {
  startPostProcessor();
  await vi.advanceTimersByTimeAsync(60_001);
  stopPostProcessor();
  await Promise.resolve();
}

let tmpRoot: string;
let downloadPath: string;
let moviesPath: string;
let seriesPath: string;

beforeEach(() => {
  vi.clearAllMocks();
  // reset mutable state
  Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
  mockMovies = [];
  mockDownloadsByMovie = new Map();
  mockSeasonsByShow = new Map();
  mockEpisodesBySeason = new Map();
  jdState.configured = false;
  jdState.downloadPackages = [];
  jdState.linkGrabberPackages = [];
  jdState.downloadLinks = [];
  jdState.linkGrabberLinks = [];
  jdState.downloadPackagesReturnsNull = false;
  jdState.linkGrabberPackagesReturnsNull = false;
  libState.configured = false;
  libState.hasMovie = false;
  traktState.configured = false;
  traktState.authenticated = false;
  processingMovies.clear();

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cycle-'));
  downloadPath = path.join(tmpRoot, 'downloads');
  moviesPath = path.join(tmpRoot, 'movies');
  seriesPath = path.join(tmpRoot, 'series');
  fs.mkdirSync(downloadPath, { recursive: true });
  fs.mkdirSync(moviesPath, { recursive: true });
  fs.mkdirSync(seriesPath, { recursive: true });
});

afterEach(() => {
  stopPostProcessor();
  vi.useRealTimers();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ============================================================================
// Pure function tests (existing — preserved)
// ============================================================================
describe('PostProcessor — normalizeTitle', () => {
  it('should lowercase and strip special chars', () => {
    expect(normalizeTitle('Test Movie: The Sequel!')).toBe('test movie the sequel');
  });

  it('should convert German umlauts', () => {
    expect(normalizeTitle('Über den Dächern')).toBe('ueber den daechern');
  });

  it('should convert ß to ss', () => {
    expect(normalizeTitle('Große Straße')).toBe('grosse strasse');
  });

  it('should collapse multiple whitespace', () => {
    expect(normalizeTitle('  Hello   World  ')).toBe('hello world');
  });

  it('should handle dots from release names', () => {
    const normalized = normalizeTitle('Pretty.Lethal.Schoen.Toedlich.2026'.replace(/\./g, ' '));
    expect(normalized).toBe('pretty lethal schoen toedlich 2026');
  });
});

describe('PostProcessor — folderMatchesMovie', () => {
  it('should match folder with exact title and year', () => {
    expect(folderMatchesMovie('Test.Movie.2024.1080p.WEB-DL', { title: 'Test Movie', year: 2024 }, [])).toBe(true);
  });

  it('should not match folder with wrong year', () => {
    expect(folderMatchesMovie('Test.Movie.2023.1080p.WEB-DL', { title: 'Test Movie', year: 2024 }, [])).toBe(false);
  });

  it('should not match folder with missing title words', () => {
    expect(folderMatchesMovie('Other.Movie.2024.1080p', { title: 'Test Movie', year: 2024 }, [])).toBe(false);
  });

  it('should match via release name as PRIMARY method', () => {
    expect(folderMatchesMovie('Die.Unschuld.2024.GERMAN.1080p', { title: 'Monster', year: 2024 }, [{ release_name: 'Die.Unschuld.2024.GERMAN.1080p.WEB-DL' }])).toBe(true);
  });

  it('should match exact release name prefix', () => {
    expect(folderMatchesMovie('Pretty.Lethal.Schoen.Toedlich.2026.GERMAN.1080p.WEB-DL', { title: 'Pretty Lethal', year: 2026 }, [{ release_name: 'Pretty.Lethal.Schoen.Toedlich.2026.GERMAN.1080p.WEB-DL.x264' }])).toBe(true);
  });

  it('should match when folder is a truncated release name', () => {
    expect(folderMatchesMovie('Some.Long.Release.Name.2024', { title: 'Totally Different Title', year: 2024 }, [{ release_name: 'Some.Long.Release.Name.2024.GERMAN.1080p.WEB-DL' }])).toBe(true);
  });

  it('should NOT match release name from a DIFFERENT movie', () => {
    expect(folderMatchesMovie('Love.Actually.2003.GERMAN.1080p', { title: 'Love Story', year: 1970 }, [{ release_name: 'Love.Story.1970.GERMAN.1080p.WEB-DL' }])).toBe(false);
  });

  it('should prefer release name match over ambiguous title match', () => {
    expect(folderMatchesMovie('Der.Film.The.Movie.2024.GERMAN.1080p', { title: 'The Movie', year: 2024 }, [{ release_name: 'Der.Film.The.Movie.2024.GERMAN.1080p.WEB-DL' }])).toBe(true);
  });

  it('should match when movie has no year (year=null)', () => {
    expect(folderMatchesMovie('Test.Movie.1080p.WEB-DL', { title: 'Test Movie', year: null }, [])).toBe(true);
  });

  it('should handle German umlauts in folder names', () => {
    expect(folderMatchesMovie('Schoene.Bescherung.2024.GERMAN.1080p', { title: 'Schöne Bescherung', year: 2024 }, [])).toBe(true);
  });

  it('should not match short title "IT" against "ITEM.2026"', () => {
    expect(folderMatchesMovie('ITEM.2026.1080p', { title: 'IT', year: 2026 }, [])).toBe(false);
  });

  it('should match short title "IT" with exact word boundary and year', () => {
    expect(folderMatchesMovie('IT.2017.GERMAN.1080p.WEB-DL', { title: 'IT', year: 2017 }, [])).toBe(true);
  });
});

describe('PostProcessor — start/stop', () => {
  it('should export start and stop functions', () => {
    expect(typeof startPostProcessor).toBe('function');
    expect(typeof stopPostProcessor).toBe('function');
  });
});

describe('PostProcessor — applyRenameTemplate', () => {
  it('pads {season} to 2 digits', () => {
    expect(applyRenameTemplate('S{season}', { title: 'X', year: null, season: 1 })).toBe('S01');
    expect(applyRenameTemplate('S{season}', { title: 'X', year: null, season: 12 })).toBe('S12');
  });

  it('pads {episode} to 2 digits', () => {
    expect(applyRenameTemplate('E{episode}', { title: 'X', year: null, episode: 3 })).toBe('E03');
  });

  it('renders flat movie file name', () => {
    expect(applyRenameTemplate('{title} ({year})', { title: 'Pretty Lethal', year: 2026 })).toBe('Pretty Lethal (2026)');
  });

  it('renders series file with season + episode', () => {
    expect(applyRenameTemplate('{title} S{season}E{episode}', { title: 'Scrubs', year: 2001, season: 1, episode: 3 })).toBe('Scrubs S01E03');
  });

  it('strips path traversal from title', () => {
    expect(applyRenameTemplate('{title}', { title: '../etc/passwd', year: null })).toBe('. etc passwd');
  });

  it('substitutes quality, audio and release tokens', () => {
    expect(applyRenameTemplate('{title} {quality} {audio} [{release}]', {
      title: 'X', year: 2024, quality: '1080p', audio: 'DTS', release: 'Some.Rel',
    })).toBe('X 1080p DTS [Some.Rel]');
  });

  it('uses Unknown when year is null in {year} token', () => {
    expect(applyRenameTemplate('{title} ({year})', { title: 'X', year: null })).toBe('X (Unknown)');
  });
});

describe('PostProcessor — parseSeasonEpisode', () => {
  it('parses standard SxxExx', () => {
    expect(parseSeasonEpisode('Scrubs.S01E03.GERMAN.1080p')).toEqual({ season: 1, episode: 3 });
  });

  it('parses 1-digit season + 1-digit episode', () => {
    expect(parseSeasonEpisode('Show S1E5 release')).toEqual({ season: 1, episode: 5 });
  });

  it('returns episode null for season-only folder', () => {
    const r = parseSeasonEpisode('Show.S02.GERMAN.COMPLETE');
    expect(r.season).toBe(2);
    expect(r.episode).toBeNull();
  });

  it('parses German "Staffel N" pattern', () => {
    const r = parseSeasonEpisode('Serie.Staffel.3.GERMAN');
    expect(r.season).toBe(3);
  });

  it('returns nulls when nothing matches', () => {
    expect(parseSeasonEpisode('random.folder.name')).toEqual({ season: null, episode: null });
  });
});

describe('PostProcessor — pickMainMediaFile', () => {
  function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-test-'));
  }

  it('returns the largest media file above the threshold', () => {
    const dir = makeTempDir();
    try {
      writeMedia(path.join(dir, 'sample.mkv'), 50);
      writeMedia(path.join(dir, 'movie.mkv'), 400);
      writeMedia(path.join(dir, 'extra.mkv'), 310);
      expect(pickMainMediaFile(dir, 300)).toBe(path.join(dir, 'movie.mkv'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-media files', () => {
    const dir = makeTempDir();
    try {
      writeMedia(path.join(dir, 'huge.nfo'), 500);
      writeMedia(path.join(dir, 'movie.mkv'), 400);
      expect(pickMainMediaFile(dir, 300)).toBe(path.join(dir, 'movie.mkv'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans one level of subdirectories', () => {
    const dir = makeTempDir();
    try {
      const sub = path.join(dir, 'release');
      fs.mkdirSync(sub);
      writeMedia(path.join(sub, 'movie.mp4'), 400);
      expect(pickMainMediaFile(dir, 300)).toBe(path.join(sub, 'movie.mp4'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when nothing meets the threshold', () => {
    const dir = makeTempDir();
    try {
      writeMedia(path.join(dir, 'tiny.mkv'), 10);
      expect(pickMainMediaFile(dir, 300)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a non-existent directory', () => {
    expect(pickMainMediaFile('/no/such/dir/here', 300)).toBeNull();
  });
});

// ============================================================================
// Orchestration tests — driven through startPostProcessor + fake timers
// ============================================================================
describe('PostProcessor — runPostProcessCycle (orchestration)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSettings['paths.downloads'] = '';
    mockSettings['paths.movies'] = '';
    mockSettings['paths.series'] = '';
  });

  function configurePaths() {
    mockSettings['paths.downloads'] = downloadPath;
    mockSettings['paths.movies'] = moviesPath;
    mockSettings['paths.series'] = seriesPath;
  }

  it('runs cleanly with no movies and unconfigured paths', async () => {
    await runOneCycle();
    expect(updateMovieStatus).not.toHaveBeenCalled();
  });

  it('moves a completed movie download into the movie library', async () => {
    configurePaths();
    const movie = makeMovie({ status: 'downloading' });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    // Build a ready download folder with a large media file, stable size cached as ready.
    const relFolder = 'Test.Movie.2024.GERMAN.1080p.WEB-DL';
    const folder = path.join(downloadPath, relFolder);
    fs.mkdirSync(folder);
    writeMedia(path.join(folder, 'movie.mkv'), 400);

    // First cycle records the size (treats as "still extracting"); second cycle past 30s = stable.
    await runOneCycle();
    // advance > 30s so size becomes stable, then run a second cycle
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    const moved = fs.readdirSync(moviesPath);
    expect(moved.some(f => f.startsWith('Test Movie (2024)'))).toBe(true);
    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'downloaded');
    expect(updateDownloadStatusByMovieId).toHaveBeenCalledWith(1, 'completed');
    expect(sendTelegramNotification).toHaveBeenCalled();
    // source folder removed after move
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('skips a folder still extracting (archive present, no extracted media yet)', async () => {
    configurePaths();
    mockMovies = [makeMovie({ status: 'downloading' })];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    const folder = path.join(downloadPath, 'Test.Movie.2024.GERMAN.1080p.WEB-DL');
    fs.mkdirSync(folder);
    // Archive present, extraction NOT done yet (no extracted media file) → wait.
    fs.writeFileSync(path.join(folder, 'archive.rar'), Buffer.alloc(1024));

    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'downloaded');
    expect(fs.existsSync(folder)).toBe(true);
  });

  it('moves a folder once extraction is done even if source archives linger (JD keeps archives)', async () => {
    configurePaths();
    mockMovies = [makeMovie({ status: 'downloading' })];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    const folder = path.join(downloadPath, 'Test.Movie.2024.GERMAN.1080p.WEB-DL');
    fs.mkdirSync(folder);
    writeMedia(path.join(folder, 'movie.mkv'), 400);
    // JD with "delete archives after extraction" OFF leaves the .rar behind. Once
    // the extracted media is stable, the lingering archive must NOT block the move.
    fs.writeFileSync(path.join(folder, 'archive.rar'), Buffer.alloc(1024));

    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    expect(fs.readdirSync(moviesPath).some(f => f.startsWith('Test Movie (2024)'))).toBe(true);
    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'downloaded');
  });

  it('skips when no media file meets the junk size threshold', async () => {
    configurePaths();
    mockSettings['rename.junk_min_size_mb'] = '300';
    mockMovies = [makeMovie()];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    const folder = path.join(downloadPath, 'Test.Movie.2024.GERMAN.1080p.WEB-DL');
    fs.mkdirSync(folder);
    writeMedia(path.join(folder, 'sample.mkv'), 10); // below threshold

    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    // hasMediaFiles is true (it's a media file regardless of size), but pickMainMediaFile rejects it.
    // markMovieDownloaded should bail without moving.
    expect(fs.readdirSync(moviesPath).length).toBe(0);
    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'downloaded');
  });

  it('marks a movie downloaded via checkLibraryFolders when present in library', async () => {
    configurePaths();
    const movie = makeMovie({ status: 'pending' });
    mockMovies = [movie];

    // Place a matching folder directly in the movie library
    fs.mkdirSync(path.join(moviesPath, 'Test Movie (2024)'));

    await runOneCycle();

    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'downloaded');
    expect(updateDownloadStatusByMovieId).toHaveBeenCalledWith(1, 'completed');
  });

  it('skips movies that are currently being processed by the scheduler', async () => {
    configurePaths();
    mockMovies = [makeMovie({ status: 'downloading' })];
    mockDownloadsByMovie.set(1, [makeDownload()]);
    processingMovies.add(1);

    const folder = path.join(downloadPath, 'Test.Movie.2024.GERMAN.1080p.WEB-DL');
    fs.mkdirSync(folder);
    writeMedia(path.join(folder, 'movie.mkv'), 400);

    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'downloaded');
  });

  it('moves separate episode folders into the series library', async () => {
    configurePaths();
    const show = makeMovie({ id: 2, title: 'My Show', year: 2020, media_type: 'show', status: 'downloading' });
    mockMovies = [show];
    mockDownloadsByMovie.set(2, [makeDownload({ id: 2, movie_id: 2, release_name: 'My.Show.S01E01.GERMAN.1080p' })]);
    mockSeasonsByShow.set(2, [{ id: 50, movie_id: 2, season_number: 1, status: 'downloading' }]);

    // Two episode folders for season 1
    for (const ep of ['My.Show.S01E01.GERMAN.1080p', 'My.Show.S01E02.GERMAN.1080p']) {
      const f = path.join(downloadPath, ep);
      fs.mkdirSync(f);
      writeMedia(path.join(f, 'ep.mkv'), 400);
    }

    // Several cycles: isStillExtracting first records each folder's size, then needs the
    // size to stay stable for >30s. `.every(...)` short-circuits so folders are cached
    // one-per-cycle in the worst case — run enough cycles to settle both episodes.
    for (let i = 0; i < 4; i++) {
      await runOneCycle();
      await vi.advanceTimersByTimeAsync(31_000);
    }

    // Only the delivered episodes are marked — and since both make the season
    // complete (no other episode rows), the season flips to downloaded.
    expect(markEpisodesDownloaded).toHaveBeenCalledWith(50, expect.arrayContaining([1, 2]), expect.anything());
    expect(updateSeasonStatus).toHaveBeenCalledWith(50, 'downloaded');
    const seriesDir = path.join(seriesPath, 'My Show');
    expect(fs.existsSync(seriesDir)).toBe(true);
    expect(fs.readdirSync(seriesDir).length).toBe(2);
  });

  it('moves a REAL season pack (one folder, many files) without losing episodes', async () => {
    // Regression for the data-loss bug: a single pack folder with no SxxExx in
    // its name, holding several episode files, used to collapse to the largest
    // file (pickMainMediaFile) and rmSync the rest. Now every episode is moved.
    configurePaths();
    const show = makeMovie({ id: 3, title: 'Pack Show', year: 2021, media_type: 'show', status: 'downloading' });
    mockMovies = [show];
    mockDownloadsByMovie.set(3, [makeDownload({ id: 3, movie_id: 3, release_name: 'Pack.Show.S01.GERMAN.1080p.WEB.h264-GRP' })]);
    mockSeasonsByShow.set(3, [{ id: 60, movie_id: 3, season_number: 1, status: 'downloading' }]);

    const packFolder = path.join(downloadPath, 'Pack.Show.S01.GERMAN.1080p.WEB.h264-GRP');
    fs.mkdirSync(packFolder);
    for (const ep of ['Pack.Show.S01E01.GERMAN.1080p.mkv', 'Pack.Show.S01E02.GERMAN.1080p.mkv', 'Pack.Show.S01E03.GERMAN.1080p.mkv']) {
      writeMedia(path.join(packFolder, ep), 400);
    }

    for (let i = 0; i < 3; i++) {
      await runOneCycle();
      await vi.advanceTimersByTimeAsync(31_000);
    }

    // All three episodes landed in the library
    const seriesDir = path.join(seriesPath, 'Pack Show');
    expect(fs.existsSync(seriesDir)).toBe(true);
    expect(fs.readdirSync(seriesDir).length).toBe(3);
    // All three (not just the largest) were marked downloaded
    expect(markEpisodesDownloaded).toHaveBeenCalledWith(60, expect.arrayContaining([1, 2, 3]), expect.anything());
    expect(updateSeasonStatus).toHaveBeenCalledWith(60, 'downloaded');
    // Source pack folder removed only after all episodes moved
    expect(fs.existsSync(packFolder)).toBe(false);
  });

  it('does NOT mark a partial season complete (weekly releases)', async () => {
    // Season has 5 aired episodes (from Trakt) but only E01+E02 are available.
    // Only those two may be marked downloaded; the season must stay 'downloading'
    // and the show must NOT flip to downloaded.
    configurePaths();
    const show = makeMovie({ id: 4, title: 'Weekly Show', year: 2022, media_type: 'show', status: 'downloading' });
    mockMovies = [show];
    mockDownloadsByMovie.set(4, [makeDownload({ id: 4, movie_id: 4, release_name: 'Weekly.Show.S01E01.GERMAN.1080p' })]);
    mockSeasonsByShow.set(4, [{ id: 70, movie_id: 4, season_number: 1, status: 'downloading' }]);
    mockEpisodesBySeason.set(70, [1, 2, 3, 4, 5].map(n => ({ episode_number: n, status: 'pending' })));

    for (const ep of ['Weekly.Show.S01E01.GERMAN.1080p', 'Weekly.Show.S01E02.GERMAN.1080p']) {
      const f = path.join(downloadPath, ep);
      fs.mkdirSync(f);
      writeMedia(path.join(f, 'ep.mkv'), 400);
    }

    for (let i = 0; i < 4; i++) {
      await runOneCycle();
      await vi.advanceTimersByTimeAsync(31_000);
    }

    expect(markEpisodesDownloaded).toHaveBeenCalledWith(70, expect.arrayContaining([1, 2]), expect.anything());
    // Season stays downloading — 2 of 5 → not complete
    expect(updateSeasonStatus).toHaveBeenCalledWith(70, 'downloading');
    expect(updateSeasonStatus).not.toHaveBeenCalledWith(70, 'downloaded');
    // Show must NOT be flagged downloaded
    expect(updateMovieStatus).not.toHaveBeenCalledWith(4, 'downloaded');
  });

  it('cleans up orphaned download folders once confirmed in library', async () => {
    configurePaths();
    const movie = makeMovie({ status: 'downloaded' });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload({ release_name: 'Test.Movie.2024.GERMAN.1080p.WEB-DL' })]);

    // leftover download folder
    const leftover = path.join(downloadPath, 'Test.Movie.2024.GERMAN.1080p.WEB-DL');
    fs.mkdirSync(leftover);
    writeMedia(path.join(leftover, 'movie.mkv'), 400);

    // confirmed-in-library: a flat media file with matching title
    writeMedia(path.join(moviesPath, 'Test Movie (2024).mkv'), 400);

    // First cycle records size (still-extracting guard defers cleanup)
    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    expect(fs.existsSync(leftover)).toBe(false);
  });

  it('does NOT clean up download folders when not confirmed in library', async () => {
    configurePaths();
    const movie = makeMovie({ status: 'downloaded' });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload({ release_name: 'Test.Movie.2024.GERMAN.1080p.WEB-DL' })]);

    const leftover = path.join(downloadPath, 'Test.Movie.2024.GERMAN.1080p.WEB-DL');
    fs.mkdirSync(leftover);
    // Still archives, nothing extracted yet → not moveable (no media file); with an
    // empty library (not confirmed) the cleanup must leave the folder alone rather
    // than delete a download that may still be needed.
    fs.writeFileSync(path.join(leftover, 'part.rar'), Buffer.alloc(1024));
    // library is empty → not confirmed

    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    expect(fs.existsSync(leftover)).toBe(true);
  });

  it('marks movie as collected in trakt after a successful move', async () => {
    configurePaths();
    traktState.configured = true;
    traktState.authenticated = true;
    mockMovies = [makeMovie({ status: 'downloading' })];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    const folder = path.join(downloadPath, 'Test.Movie.2024.GERMAN.1080p.WEB-DL');
    fs.mkdirSync(folder);
    writeMedia(path.join(folder, 'movie.mkv'), 400);

    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    const { traktService } = await import('../../src/services/trakt');
    expect(traktService.markAsCollected).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Test Movie', year: 2024 }),
    );
  });

  it('finds an orphaned direct-download file via recursive scan', async () => {
    configurePaths();
    const movie = makeMovie({ status: 'downloading' });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload({ download_url: 'https://archive.org/download/x/test.movie.2024.mkv', release_name: null })]);

    // Nested working dir like JD's unfertige/<pkg>/, folder name matches the movie
    const nested = path.join(downloadPath, 'unfertige', 'Test.Movie.2024.GERMAN');
    fs.mkdirSync(nested, { recursive: true });
    writeMedia(path.join(nested, 'test.movie.2024.mkv'), 400);

    await runOneCycle();

    // Direct files skip the stability check and move immediately
    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'downloaded');
    expect(fs.readdirSync(moviesPath).some(f => f.startsWith('Test Movie (2024)'))).toBe(true);
  });
});

describe('PostProcessor — syncDownloadingStatus (JD + library)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSettings['paths.downloads'] = downloadPath;
    mockSettings['paths.movies'] = moviesPath;
    mockSettings['paths.series'] = seriesPath;
  });

  it('moves the folder when JD reports the package finished (Status sync)', async () => {
    jdState.configured = true;
    jdState.downloadPackages = [{
      uuid: 21, name: 'Test Movie (2024) [src]', finished: true, status: 'finished',
      saveTo: path.join(downloadPath, 'Test.Movie.2024.GERMAN.1080p.WEB-DL'),
    }];
    const movie = makeMovie({ status: 'downloading' });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    const folder = path.join(downloadPath, 'Test.Movie.2024.GERMAN.1080p.WEB-DL');
    fs.mkdirSync(folder);
    writeMedia(path.join(folder, 'movie.mkv'), 400);

    // syncDownloadingStatus path also requires file stability
    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'downloaded');
  });

  it('keeps status when JD package gone but download folder still present', async () => {
    jdState.configured = true;
    jdState.downloadPackages = [];
    jdState.linkGrabberPackages = [];
    const movie = makeMovie({ status: 'downloading' });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    const folder = path.join(downloadPath, 'Test.Movie.2024.GERMAN.1080p.WEB-DL');
    fs.mkdirSync(folder);
    writeMedia(path.join(folder, 'movie.mkv'), 400);

    // Stabilize so syncDownloadingStatus sees a ready folder and keeps status (no stale reset)
    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    // checkCompletedDownloads will have moved it; but with a recent updated_at there is
    // no stale 'pending' reset. Assert the movie was never reset to pending.
    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'pending');
  });

  it('detects offline via individual linkgrabber link availability', async () => {
    jdState.configured = true;
    jdState.linkGrabberPackages = [{ uuid: 9, name: 'Test Movie (2024)', offlineCount: 0, childCount: 2, status: 'online' }];
    jdState.linkGrabberLinks = [
      { uuid: 1, availability: 'OFFLINE', status: 'offline' },
      { uuid: 2, availability: 'ONLINE', status: 'OK' },
    ];
    const movie = makeMovie({ status: 'downloading' });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();

    expect(addBlocklistEntry).toHaveBeenCalled();
    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'not_found', undefined, 'no_download');
  });

  it('marks movie downloaded when found in library provider', async () => {
    libState.configured = true;
    libState.hasMovie = true;
    mockMovies = [makeMovie({ status: 'found' })];

    await runOneCycle();

    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'downloaded');
    expect(addLogEntry).toHaveBeenCalledWith(1, 'already_in_library', expect.any(String));
  });

  it('blocklists and marks not_found when download-list links are offline', async () => {
    jdState.configured = true;
    jdState.downloadPackages = [{ uuid: 7, name: 'Test Movie (2024)', finished: false, status: 'downloading' }];
    jdState.downloadLinks = [
      { uuid: 1, status: 'Offline' },
      { uuid: 2, status: 'OK' },
    ];
    const movie = makeMovie({ status: 'downloading' });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();

    expect(addBlocklistEntry).toHaveBeenCalled();
    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'not_found', undefined, 'no_download');
    expect(addLogEntry).toHaveBeenCalledWith(1, 'links_offline', expect.any(String));
  });

  it('removes dead linkgrabber package with offline links and marks not_found', async () => {
    jdState.configured = true;
    jdState.downloadPackages = [];
    jdState.linkGrabberPackages = [{ uuid: 9, name: 'Test Movie (2024)', offlineCount: 2, childCount: 3, status: 'incomplete' }];
    const movie = makeMovie({ status: 'downloading' });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();

    expect(jdownloaderService.removeLinkGrabberPackages).toHaveBeenCalledWith([9]);
    expect(addBlocklistEntry).toHaveBeenCalled();
    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'not_found', undefined, 'no_download');
  });

  it('resets stale linkgrabber package (>2h) back to found', async () => {
    jdState.configured = true;
    jdState.linkGrabberPackages = [{ uuid: 9, name: 'Test Movie (2024)', offlineCount: 0, childCount: 3, status: 'online' }];
    jdState.linkGrabberLinks = [{ uuid: 1, availability: 'ONLINE', status: 'OK' }];
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const movie = makeMovie({ status: 'downloading', updated_at: old, last_checked_at: old });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();

    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'found');
    expect(addLogEntry).toHaveBeenCalledWith(1, 'linkgrabber_stuck', expect.any(String));
  });

  it('stale-resets to pending when JD package gone and not in library (>1h)', async () => {
    jdState.configured = true;
    jdState.downloadPackages = [];
    jdState.linkGrabberPackages = [];
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const movie = makeMovie({ status: 'downloading', updated_at: old });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();

    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'pending');
    expect(addLogEntry).toHaveBeenCalledWith(1, 'download_stale', expect.any(String));
  });

  it('does NOT stale-reset anything when JD is unreachable (getDownloadPackages returns null)', async () => {
    // Long JD outage scenario: dlPackages/lgPackages come back as null, not [].
    // Without the bail-out, every 'downloading' movie would be treated as
    // "package gone" and stale-reset to pending — devastating during a 2h JD blip.
    jdState.configured = true;
    jdState.downloadPackagesReturnsNull = true;
    jdState.linkGrabberPackagesReturnsNull = true;
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const movie = makeMovie({ status: 'downloading', updated_at: old });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();

    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'pending');
    expect(addLogEntry).not.toHaveBeenCalledWith(1, 'download_stale', expect.any(String));
  });

  it('does NOT stale-reset when last_jd_check_at is recent but updated_at is old', async () => {
    // Pre-fix this would have false-reset: updated_at = 2h ago, JD missed the
    // package once, stale threshold tripped. With last_jd_check_at recent (2m
    // ago — JD confirmed it on the previous sync, well within the threshold),
    // the threshold must not fire.
    jdState.configured = true;
    jdState.downloadPackages = [];
    jdState.linkGrabberPackages = [];
    const veryOld = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const movie = makeMovie({
      status: 'downloading',
      updated_at: veryOld,
      last_jd_check_at: recent,
    });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();

    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'pending');
    expect(addLogEntry).not.toHaveBeenCalledWith(1, 'download_stale', expect.any(String));
  });

  it('markJdSeen runs whenever the JD package is sighted (download list or linkgrabber)', async () => {
    jdState.configured = true;
    jdState.downloadPackages = [{ uuid: 7, name: 'Test Movie (2024)', finished: false, status: 'downloading' }];
    const movie = makeMovie({ status: 'downloading' });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();

    const { markJdSeen } = await import('../../src/database/services/movies');
    expect(markJdSeen).toHaveBeenCalledWith(1);
  });

  it('handles a JD extraction error: removes the package, blocklists, resets to not_found (Bug A)', async () => {
    // Wolf-Man scenario: download bytes complete but JD's unpacker errored. The
    // package is neither "finished+moved" nor "offline links", so pre-fix it sat
    // as 'downloading' forever while the downloads page showed red "Fehler".
    jdState.configured = true;
    jdState.downloadPackages = [{
      uuid: 42, name: 'Test Movie (2024) - 1080p', finished: false,
      status: 'Entpacken fehlgeschlagen', statusIconKey: 'extractError',
    }];
    const movie = makeMovie({ status: 'downloading' });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();

    expect(jdownloaderService.removePackages).toHaveBeenCalledWith([42]);
    expect(addBlocklistEntry).toHaveBeenCalled();
    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'not_found', undefined, 'no_download');
    expect(addLogEntry).toHaveBeenCalledWith(1, 'extraction_failed', expect.any(String));
  });

  it('does NOT treat an in-progress extraction as an error', async () => {
    jdState.configured = true;
    jdState.downloadPackages = [{
      uuid: 43, name: 'Test Movie (2024) - 1080p', finished: false,
      status: 'wird entpackt', statusIconKey: 'extract',
    }];
    const movie = makeMovie({ status: 'downloading' });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();

    expect(jdownloaderService.removePackages).not.toHaveBeenCalled();
    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'not_found', undefined, 'no_download');
  });

  it('linkgrabber janitor sweeps a fully-offline dead package not tied to any movie (Bug D)', async () => {
    // Wolf-Man leftover: a dead package sits in the linkgrabber with every child
    // offline, no longer mapped to any 'downloading' movie. The per-movie sync
    // can't reach it; the standalone janitor must remove it.
    jdState.configured = true;
    jdState.downloadPackages = [];
    jdState.linkGrabberPackages = [
      { uuid: 99, name: 'Wolf Man (2025) - 1080p', childCount: 3, onlineCount: 0, offlineCount: 3 },
    ];
    mockMovies = []; // no tracked movie references this package

    await runOneCycle();

    expect(jdownloaderService.removeLinkGrabberPackages).toHaveBeenCalledWith([99]);
  });

  it('linkgrabber janitor leaves a package with online links alone', async () => {
    jdState.configured = true;
    jdState.downloadPackages = [];
    jdState.linkGrabberPackages = [
      { uuid: 100, name: 'Some Movie (2024)', childCount: 3, onlineCount: 2, offlineCount: 1 },
    ];
    mockMovies = [];

    await runOneCycle();

    expect(jdownloaderService.removeLinkGrabberPackages).not.toHaveBeenCalled();
  });
});

describe('PostProcessor — jdPackageErrorKind', () => {
  it('flags extractError icon as an extraction failure', () => {
    expect(jdPackageErrorKind({ uuid: 1, name: 'x', statusIconKey: 'extractError' })).toBe('extraction');
  });
  it('flags a German extraction-failure status string', () => {
    expect(jdPackageErrorKind({ uuid: 1, name: 'x', status: 'Entpacken fehlgeschlagen' })).toBe('extraction');
  });
  it('flags a CRC/extraction error string', () => {
    expect(jdPackageErrorKind({ uuid: 1, name: 'x', status: 'Extraction error: CRC' })).toBe('extraction');
  });
  it('flags a generic fatal download error as download', () => {
    expect(jdPackageErrorKind({ uuid: 1, name: 'x', status: 'Fehler' })).toBe('download');
  });
  it('returns null for the live extract spinner', () => {
    expect(jdPackageErrorKind({ uuid: 1, name: 'x', statusIconKey: 'extract', status: 'wird entpackt' })).toBeNull();
  });
  it('returns null for a successful/finished package', () => {
    expect(jdPackageErrorKind({ uuid: 1, name: 'x', statusIconKey: 'extractOk', status: 'Fertig' })).toBeNull();
  });
  it('returns null for an offline status (handled by the per-link check)', () => {
    expect(jdPackageErrorKind({ uuid: 1, name: 'x', status: 'offline' })).toBeNull();
  });
  it('returns null for a normal downloading status', () => {
    expect(jdPackageErrorKind({ uuid: 1, name: 'x', status: 'Downloading', running: true })).toBeNull();
  });
});

describe('PostProcessor — trackJdPackageTransitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSettings['paths.downloads'] = downloadPath;
    mockSettings['paths.movies'] = moviesPath;
    mockSettings['paths.series'] = seriesPath;
  });

  it('logs a download_finished transition for a matched movie', async () => {
    jdState.configured = true;
    mockMovies = [makeMovie({ title: 'Test Movie', year: 2024 })];
    // package finished, matches "Test Movie (2024)"
    jdState.downloadPackages = [{ uuid: 11, name: 'Test Movie (2024) [src]', finished: true, status: 'finished', bytesTotal: 1024 * 1024 * 500 }];

    await runOneCycle();

    expect(addLogEntry).toHaveBeenCalledWith(1, 'download_finished', expect.any(String));
  });
});

describe('PostProcessor — reconcileDatabase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSettings['paths.movies'] = moviesPath;
    mockSettings['paths.series'] = seriesPath;
  });

  it('resets a stuck searching movie to pending', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockMovies = [makeMovie({ status: 'searching', updated_at: old })];

    await runReconcile();

    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'pending');
    expect(addLogEntry).toHaveBeenCalledWith(1, 'reconcile', expect.stringContaining('searching'));
  });

  it('resets a stuck found movie (>2h) to pending', async () => {
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    mockMovies = [makeMovie({ status: 'found', updated_at: old })];

    await runReconcile();

    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'pending');
  });

  it('fixes stuck seasons when show already downloaded', async () => {
    mockMovies = [makeMovie({ id: 3, media_type: 'show', status: 'downloaded' })];
    mockSeasonsByShow.set(3, [
      { id: 60, movie_id: 3, season_number: 1, status: 'downloaded' },
      { id: 61, movie_id: 3, season_number: 2, status: 'downloading' },
    ]);

    await runReconcile();

    expect(updateSeasonStatus).toHaveBeenCalledWith(61, 'downloaded');
  });

  it('corrects show status to downloaded when all seasons done', async () => {
    mockMovies = [makeMovie({ id: 3, media_type: 'show', status: 'downloading' })];
    mockSeasonsByShow.set(3, [
      { id: 60, movie_id: 3, season_number: 1, status: 'downloaded' },
      { id: 61, movie_id: 3, season_number: 2, status: 'downloaded' },
    ]);

    await runReconcile();

    expect(updateMovieStatus).toHaveBeenCalledWith(3, 'downloaded');
    expect(addLogEntry).toHaveBeenCalledWith(3, 'reconcile', expect.any(String));
  });

  it('warns (no fix) when a downloaded movie is missing from the library', async () => {
    // empty movies library → not confirmed
    mockMovies = [makeMovie({ status: 'downloaded' })];

    await runReconcile();

    // No status change expected; reconcile only warns.
    expect(updateMovieStatus).not.toHaveBeenCalled();
  });
});

describe('PostProcessor — stop is idempotent', () => {
  it('can be called repeatedly without throwing', () => {
    stopPostProcessor();
    stopPostProcessor();
    expect(true).toBe(true);
  });
});

describe('kids content routing', () => {
  beforeEach(() => {
    mockSettings['paths.movies'] = '/movies';
    mockSettings['paths.series'] = '/series';
    mockSettings['kids.genres'] = 'Family,Animation';
    mockSettings['paths.kids_movies'] = '/kids_movies';
    mockSettings['paths.kids_series'] = '/kids_series';
  });

  it('isKidsContent matches a configured kids genre (case-insensitive)', () => {
    expect(isKidsContent(makeMovie({ genres: 'Animation, Comedy' }))).toBe(true);
    expect(isKidsContent(makeMovie({ genres: 'family' }))).toBe(true);
    expect(isKidsContent(makeMovie({ genres: 'Crime, Drama' }))).toBe(false);
    expect(isKidsContent(makeMovie({ genres: null }))).toBe(false);
  });

  it('routes kids titles to the kids library, others to the normal one', () => {
    expect(resolveLibraryTarget(makeMovie({ genres: 'Animation' }))).toBe('/kids_movies');
    expect(resolveLibraryTarget(makeMovie({ media_type: 'show', genres: 'Family' }))).toBe('/kids_series');
    expect(resolveLibraryTarget(makeMovie({ genres: 'Drama' }))).toBe('/movies');
  });

  it('falls back to the normal library when no kids path is set', () => {
    mockSettings['paths.kids_movies'] = '';
    expect(resolveLibraryTarget(makeMovie({ genres: 'Animation' }))).toBe('/movies');
  });

  it('respects a custom kids genre list', () => {
    mockSettings['kids.genres'] = 'Kids,Children';
    expect(isKidsContent(makeMovie({ genres: 'Animation' }))).toBe(false);
    expect(isKidsContent(makeMovie({ genres: 'Kids' }))).toBe(true);
  });
});
