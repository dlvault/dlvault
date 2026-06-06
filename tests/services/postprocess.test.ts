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
  blockingDialogs: [] as any[],
};

// Library provider mock state
const libState = {
  configured: false,
  hasMovie: false,
  cachedMovieCount: 0,
  refresh: vi.fn(async () => true),
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
  getMovieById: vi.fn((id: number) => mockMovies.find((m: any) => m.id === id)),
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
  updateDownloadStatusBySeason: vi.fn(),
}));

const blocklistCount = vi.hoisted(() => ({ value: 0 }));
vi.mock('../../src/database/services/blocklist', () => ({
  addBlocklistEntry: vi.fn(),
  countAutoBlocklisted: () => blocklistCount.value,
  isReleaseBlocklisted: vi.fn(() => false),
  countBlocklistedWithReason: vi.fn(() => 0),
}));

vi.mock('../../src/database/services/activityLog', () => ({
  addLogEntry: vi.fn(),
  hasRecentActivityEntry: vi.fn(() => false),
  pruneOldActivityLogs: vi.fn(() => 0),
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
  getEpisodesBySeasonId: vi.fn((seasonId: number) => mockEpisodesBySeason.get(seasonId) || []),
  updateEpisodeStatus: vi.fn(),
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
  // Mirrors the real rule: aired_episodes (from the season row) raises the total.
  getSeasonCompletionStatus: vi.fn((seasonId: number) => {
    const eps = mockEpisodesBySeason.get(seasonId) || [];
    if (eps.length === 0) return { total: 0, downloaded: 0, allDone: false, rowsDone: false };
    const downloaded = eps.filter(e => e.status === 'downloaded').length;
    const season = [...mockSeasonsByShow.values()].flat().find((x: any) => x.id === seasonId);
    const total = Math.max(eps.length, season?.aired_episodes || 0);
    const rowsDone = downloaded === eps.length;
    return { total, downloaded, allDone: rowsDone && downloaded >= total, rowsDone };
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
    answerBlockingDialogs: vi.fn(() => Promise.resolve(jdState.blockingDialogs)),
  },
}));

vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({
    isConfigured: () => libState.configured,
    hasMovie: async () => libState.hasMovie,
    getCachedMovieCount: () => libState.cachedMovieCount,
    refreshLibrary: libState.refresh,
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
  sendTelegramSystemAlert: vi.fn(),
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
  renameLibraryForImdbId,
  normalizeLibraryName,
  pickMainMediaFile,
  parseSeasonEpisode,
  isKidsContent,
  resolveLibraryTarget,
  jdPackageErrorKind,
  jdPackageMatchesMovie,
  jdPackageExtracting,
  moveCompanionSubtitles,
  renameShowFolderForYear,
  _resetMoveFailures,
  _awaitCurrentCycle,
  visibleBelowDownloadPath,
} from '../../src/services/postprocess';
import { updateMovieStatus } from '../../src/database/services/movies';
import { updateDownloadStatusByMovieId } from '../../src/database/services/downloads';
import { addLogEntry, hasRecentActivityEntry } from '../../src/database/services/activityLog';
import { addBlocklistEntry } from '../../src/database/services/blocklist';
import { incrementRetryCount } from '../../src/database/services/movies';
import { updateSeasonStatus } from '../../src/database/services/seasons';
import { markEpisodesDownloaded, updateEpisodeStatus } from '../../src/database/services/episodes';
import { sendTelegramNotification, sendTelegramSystemAlert } from '../../src/services/telegram';
import { updateDownloadStatusBySeason } from '../../src/database/services/downloads';
import { jdownloaderService } from '../../src/jdownloader/index';
const ffprobeState = vi.hoisted(() => ({ tags: null as string[] | null, seconds: null as number | null }));
vi.mock('../../src/utils/ffprobe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/ffprobe')>();
  return {
    ...actual,
    audioLanguageTags: vi.fn(async () => ffprobeState.tags),
    mediaDurationSeconds: vi.fn(async () => ffprobeState.seconds),
  };
});
import { processingMovies, upgradingMovies } from '../../src/services/processingState';

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
// _awaitCurrentCycle() is the real sync point — the cycle now contains genuine
// async fs I/O (fs.promises.rm) that outlives the timer tick.
async function runOneCycle(): Promise<void> {
  startPostProcessor();
  await vi.advanceTimersByTimeAsync(15_001);
  await _awaitCurrentCycle();
  stopPostProcessor();
}

// Drives a cycle far enough to trigger the +60s reconcileDatabase pass too.
async function runReconcile(): Promise<void> {
  startPostProcessor();
  await vi.advanceTimersByTimeAsync(60_001);
  await _awaitCurrentCycle();
  stopPostProcessor();
  await Promise.resolve();
}

let tmpRoot: string;
let downloadPath: string;
let moviesPath: string;
let seriesPath: string;

beforeEach(() => {
  blocklistCount.value = 0;
  _resetMoveFailures();
  vi.clearAllMocks();
  // clearAllMocks wipes recorded calls but NOT implementations set with
  // mockReturnValue, so a test that stubs this one would otherwise leak its
  // answer into every test after it.
  vi.mocked(hasRecentActivityEntry).mockReturnValue(false);
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
  jdState.blockingDialogs = [];
  libState.configured = false;
  libState.hasMovie = false;
  libState.cachedMovieCount = 0;
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
    const normalized = normalizeTitle('Quiet.Ember.Leise.Glut.2026'.replace(/\./g, ' '));
    expect(normalized).toBe('quiet ember leise glut 2026');
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
    expect(folderMatchesMovie('Die.Stille.2024.GERMAN.1080p', { title: 'Ungeheuer', year: 2024 }, [{ release_name: 'Die.Stille.2024.GERMAN.1080p.WEB-DL' }])).toBe(true);
  });

  it('should match exact release name prefix', () => {
    expect(folderMatchesMovie('Quiet.Ember.Leise.Glut.2026.GERMAN.1080p.WEB-DL', { title: 'Quiet Ember', year: 2026 }, [{ release_name: 'Quiet.Ember.Leise.Glut.2026.GERMAN.1080p.WEB-DL.x264' }])).toBe(true);
  });

  it('should match when folder is a truncated release name', () => {
    expect(folderMatchesMovie('Some.Long.Release.Name.2024', { title: 'Totally Different Title', year: 2024 }, [{ release_name: 'Some.Long.Release.Name.2024.GERMAN.1080p.WEB-DL' }])).toBe(true);
  });

  it('should NOT match release name from a DIFFERENT movie', () => {
    expect(folderMatchesMovie('Love.Actually.2003.GERMAN.1080p', { title: 'Paper Story', year: 1970 }, [{ release_name: 'Paper.Story.1970.GERMAN.1080p.WEB-DL' }])).toBe(false);
  });

  it('should prefer release name match over ambiguous title match', () => {
    expect(folderMatchesMovie('Der.Film.The.Movie.2024.GERMAN.1080p', { title: 'The Movie', year: 2024 }, [{ release_name: 'Der.Film.The.Movie.2024.GERMAN.1080p.WEB-DL' }])).toBe(true);
  });

  it('should match when movie has no year (year=null)', () => {
    expect(folderMatchesMovie('Test.Movie.1080p.WEB-DL', { title: 'Test Movie', year: null }, [])).toBe(true);
  });

  it('should handle German umlauts in folder names', () => {
    expect(folderMatchesMovie('Muede.Fuechse.2024.GERMAN.1080p', { title: 'Müde Füchse', year: 2024 }, [])).toBe(true);
  });

  it('should not match short title "Ix" against "IXEN.2026"', () => {
    expect(folderMatchesMovie('IXEN.2026.1080p', { title: 'Ix', year: 2026 }, [])).toBe(false);
  });

  it('should match short title "Ix" with exact word boundary and year', () => {
    expect(folderMatchesMovie('Ix.2017.GERMAN.1080p.WEB-DL', { title: 'Ix', year: 2017 }, [])).toBe(true);
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
    expect(applyRenameTemplate('{title} ({year})', { title: 'Quiet Ember', year: 2026 })).toBe('Quiet Ember (2026)');
  });

  it('renders series file with season + episode', () => {
    expect(applyRenameTemplate('{title} S{season}E{episode}', { title: 'Wardline', year: 2001, season: 1, episode: 3 })).toBe('Wardline S01E03');
  });

  it('strips path traversal from title', () => {
    expect(applyRenameTemplate('{title}', { title: '../etc/passwd', year: null })).toBe('. etc passwd');
  });

  it('substitutes quality, audio and release tokens', () => {
    expect(applyRenameTemplate('{title} {quality} {audio} [{release}]', {
      title: 'X', year: 2024, quality: '1080p', audio: 'DTS', release: 'Some.Rel',
    })).toBe('X 1080p DTS [Some.Rel]');
  });

  it('leaves a missing year out, parentheses and all', () => {
    // Plex matched "Grell (Unknown)" to another film; "Grell" it found.
    expect(applyRenameTemplate('{title} ({year})', { title: 'X', year: null })).toBe('X');
    expect(applyRenameTemplate('{title} ({year}) [imdbid-{imdbid}]', { title: 'X', year: null, imdbId: 'tt9000001' }))
      .toBe('X [imdbid-tt9000001]');
    expect(applyRenameTemplate('{title} - {year}', { title: 'X', year: null })).toBe('X');
    expect(applyRenameTemplate('{title} - {year} [imdbid-{imdbid}]', { title: 'X', year: null, imdbId: 'tt1' })).toBe('X [imdbid-tt1]');
    expect(applyRenameTemplate('{title} - {year}/{title} - {year}', { title: 'X', year: null })).toBe('X/X');
    // A dash that belongs to the name stays.
    expect(applyRenameTemplate('{title} - S{season}', { title: 'X - Y', year: null, season: 1 })).toBe('X - Y - S01');
  });

  // The default template carries an id marker since 2026-08-26: Jellyfin matched
  // "/filme/Grell (2020).mkv" to Grell Island and dlvault then reported the film as
  // missing from the library every day. `[imdbid-tt…]` makes the match
  // deterministic for both Jellyfin and Plex.
  it('substitutes the provider id tokens', () => {
    expect(applyRenameTemplate('{title} ({year}) [imdbid-{imdbid}]', {
      title: 'Grell', year: 2020, imdbId: 'tt0000303',
    })).toBe('Grell (2020) [imdbid-tt0000303]');
    expect(applyRenameTemplate('{title} [tmdbid-{tmdbid}] [tvdbid-{tvdbid}]', {
      title: 'Wardline', year: 2001, tmdbId: 100101, tvdbId: 200101,
    })).toBe('Wardline [tmdbid-100101] [tvdbid-200101]');
  });

  it('drops the marker when the id is unknown instead of leaving it dangling', () => {
    // Every title reaches the mover, id or no id. "Grell (2020) [imdbid-]" would be
    // worse than no marker at all — Jellyfin reads it as part of the title.
    expect(applyRenameTemplate('{title} ({year}) [imdbid-{imdbid}]', {
      title: 'Grell', year: 2020, imdbId: null,
    })).toBe('Grell (2020)');
    expect(applyRenameTemplate('{title} [imdbid-{imdbid}] ({year})', {
      title: 'Grell', year: 2020,
    })).toBe('Grell (2020)');
    expect(applyRenameTemplate('{title} [tmdbid-{tmdbid}]', { title: 'X', year: null })).toBe('X');
  });

  it('leaves a bracket group that has content', () => {
    expect(applyRenameTemplate('{title} [{release}]', {
      title: 'X', year: null, release: 'Some.Rel-GROUP',
    })).toBe('X [Some.Rel-GROUP]');
  });

  it('renders the shipped movie default end to end', () => {
    const DEFAULT = '{title} ({year}) [imdbid-{imdbid}]';
    expect(applyRenameTemplate(DEFAULT, {
      title: 'The Velvet Ledger 2', year: 2026, imdbId: 'tt0000202',
    })).toBe('The Velvet Ledger 2 (2026) [imdbid-tt0000202]');
  });
});

describe('PostProcessor — parseSeasonEpisode', () => {
  it('parses standard SxxExx', () => {
    expect(parseSeasonEpisode('Wardline.S01E03.GERMAN.1080p')).toEqual({ season: 1, episode: 3 });
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

  it('does not close a reopened season of a downloaded show, nor seasons below the cutoff', async () => {
    // The missing-episodes check reopens a season and the show; closing it
    // again within the next cycle meant the gap was never fetched.
    configurePaths();
    mockMovies = [makeMovie({ id: 5, title: 'Wardline', media_type: 'show', status: 'downloaded', season_cutoff: 6 })];
    mockSeasonsByShow.set(5, [
      { id: 71, movie_id: 5, season_number: 1, status: 'pending' },     // below cutoff
      { id: 76, movie_id: 5, season_number: 6, status: 'pending' },     // reopened
    ]);
    await runOneCycle();
    expect(updateSeasonStatus).not.toHaveBeenCalledWith(71, 'downloaded');
    expect(updateSeasonStatus).not.toHaveBeenCalledWith(76, 'downloaded');
    expect(updateMovieStatus).toHaveBeenCalledWith(5, 'pending');
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

    // Place a matching folder (holding the film) directly in the movie library
    fs.mkdirSync(path.join(moviesPath, 'Test Movie (2024)'));
    writeMedia(path.join(moviesPath, 'Test Movie (2024)', 'test.movie.2024.mkv'), 400);

    await runOneCycle();

    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'downloaded');
    expect(updateDownloadStatusByMovieId).toHaveBeenCalledWith(1, 'completed');
  });

  it('does not take an empty or sample-only folder for the film', async () => {
    configurePaths();
    mockMovies = [makeMovie({ status: 'pending' })];
    fs.mkdirSync(path.join(moviesPath, 'Test Movie (2024)', 'Sample'), { recursive: true });
    writeMedia(path.join(moviesPath, 'Test Movie (2024)', 'Sample', 'test.movie.2024-sample.mkv'), 1);

    await runOneCycle();

    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'downloaded');
  });

  it('does not take a longer title of the same year for the film', async () => {
    // "Grell Diaries (2026)" in the library marked "Grell" (2026) as
    // downloaded — it then never was.
    configurePaths();
    mockMovies = [makeMovie({ status: 'pending' })];
    writeMedia(path.join(moviesPath, 'Test Movie Returns (2024).mkv'), 400);

    await runOneCycle();

    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'downloaded');
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
    // One commit per episode folder (crash-safe) — together they cover both episodes.
    const marked50 = vi.mocked(markEpisodesDownloaded).mock.calls.filter(c => c[0] === 50).flatMap(c => c[1] as number[]);
    expect(marked50).toEqual(expect.arrayContaining([1, 2]));
    // Two folders → two commits: a restart between them keeps the first one recorded.
    expect(vi.mocked(markEpisodesDownloaded).mock.calls.filter(c => c[0] === 50)).toHaveLength(2);
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

  it('rejects a season pack without the wanted audio language (strict mode)', async () => {
    configurePaths();
    mockSettings['quality.language_strict'] = 'true';
    ffprobeState.tags = ['eng'];
    const show = makeMovie({ id: 3, title: 'Pack Show', year: 2021, media_type: 'show', status: 'downloading' });
    mockMovies = [show];
    mockDownloadsByMovie.set(3, [makeDownload({ id: 3, movie_id: 3, season_number: 1, release_name: 'Pack.Show.S01.1080p.WEB.h264-GRP' })]);
    mockSeasonsByShow.set(3, [{ id: 60, movie_id: 3, season_number: 1, status: 'downloading' }]);
    const packFolder = path.join(downloadPath, 'Pack.Show.S01.1080p.WEB.h264-GRP');
    fs.mkdirSync(packFolder);
    writeMedia(path.join(packFolder, 'Pack.Show.S01E01.1080p.mkv'), 400);
    writeMedia(path.join(packFolder, 'Pack.Show.S01E02.1080p.mkv'), 400);

    for (let i = 0; i < 3; i++) {
      await runOneCycle();
      await vi.advanceTimersByTimeAsync(31_000);
    }

    expect(fs.existsSync(path.join(seriesPath, 'Pack Show'))).toBe(false);
    expect(fs.existsSync(packFolder)).toBe(false);
    expect(updateSeasonStatus).toHaveBeenCalledWith(60, 'pending');
    expect(addBlocklistEntry).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('Tonspur') }));
    ffprobeState.tags = null;
    delete mockSettings['quality.language_strict'];
  });

  it('keeps a season open when a pack delivers fewer episodes than have aired', async () => {
    // An extraction cut short (JD restarted mid-unpack) left 3 of 10 episodes.
    // Episode rows only exist for delivered files, so "3/3" used to close the season.
    configurePaths();
    const show = makeMovie({ id: 3, title: 'Pack Show', year: 2021, media_type: 'show', status: 'downloading' });
    mockMovies = [show];
    mockDownloadsByMovie.set(3, [makeDownload({ id: 3, movie_id: 3, release_name: 'Pack.Show.S01.GERMAN.1080p.WEB.h264-GRP' })]);
    mockSeasonsByShow.set(3, [{ id: 60, movie_id: 3, season_number: 1, status: 'downloading', aired_episodes: 10 }]);

    const packFolder = path.join(downloadPath, 'Pack.Show.S01.GERMAN.1080p.WEB.h264-GRP');
    fs.mkdirSync(packFolder);
    for (const ep of ['Pack.Show.S01E01.GERMAN.1080p.mkv', 'Pack.Show.S01E02.GERMAN.1080p.mkv', 'Pack.Show.S01E03.GERMAN.1080p.mkv']) {
      writeMedia(path.join(packFolder, ep), 400);
    }

    for (let i = 0; i < 3; i++) {
      await runOneCycle();
      await vi.advanceTimersByTimeAsync(31_000);
    }

    expect(markEpisodesDownloaded).toHaveBeenCalledWith(60, expect.arrayContaining([1, 2, 3]), expect.anything());
    expect(updateSeasonStatus).toHaveBeenCalledWith(60, 'downloading');
    expect(updateSeasonStatus).not.toHaveBeenCalledWith(60, 'downloaded');
  });

  it('does NOT move a season pack while JD still reports the package busy (not finished)', async () => {
    // Regression for the truncated-episode bug: checkCompletedDownloads used to
    // move a show's files as soon as the folder size was 30s-stable, without
    // consulting JD's finished flag. A still-downloading episode that stalls for
    // 30s would then be moved half-written. Now the move waits for JD finished.
    configurePaths();
    mockSettings['rename.junk_min_size_mb'] = '1';
    jdState.configured = true;
    const show = makeMovie({ id: 8, title: 'Busy Show', year: 2021, media_type: 'show', status: 'downloading' });
    mockMovies = [show];
    mockDownloadsByMovie.set(8, [makeDownload({ id: 8, movie_id: 8, release_name: 'Busy.Show.S01.GERMAN.1080p.WEB.h264-GRP' })]);
    mockSeasonsByShow.set(8, [{ id: 80, movie_id: 8, season_number: 1, status: 'downloading' }]);

    const packFolder = path.join(downloadPath, 'Busy.Show.S01.GERMAN.1080p.WEB.h264-GRP');
    fs.mkdirSync(packFolder);
    for (const ep of ['Busy.Show.S01E01.GERMAN.1080p.mkv', 'Busy.Show.S01E02.GERMAN.1080p.mkv', 'Busy.Show.S01E03.GERMAN.1080p.mkv']) {
      writeMedia(path.join(packFolder, ep), 2);
    }

    // JD still downloading this package → must NOT move (would truncate).
    jdState.downloadPackages = [{ uuid: 80, name: 'Busy Show (2021) S01', finished: false, status: 'Downloading' }];
    for (let i = 0; i < 3; i++) {
      await runOneCycle();
      await vi.advanceTimersByTimeAsync(31_000);
    }
    expect(fs.existsSync(path.join(seriesPath, 'Busy Show'))).toBe(false); // nothing moved
    expect(fs.existsSync(packFolder)).toBe(true);                          // source intact
    expect(markEpisodesDownloaded).not.toHaveBeenCalled();

    // JD now reports the package finished → the move proceeds.
    jdState.downloadPackages = [{ uuid: 80, name: 'Busy Show (2021) S01', finished: true, status: 'Finished' }];
    for (let i = 0; i < 3; i++) {
      await runOneCycle();
      await vi.advanceTimersByTimeAsync(31_000);
    }
    expect(fs.existsSync(path.join(seriesPath, 'Busy Show'))).toBe(true);
    expect(markEpisodesDownloaded).toHaveBeenCalledWith(80, expect.arrayContaining([1, 2, 3]), expect.anything());
  });

  it('moves a finished season while ANOTHER season of the show is still loading', async () => {
    // S01 still downloading must not hold back S04, which is extracted and done —
    // the whole show used to wait for the slowest package.
    configurePaths();
    mockSettings['rename.junk_min_size_mb'] = '1';
    jdState.configured = true;
    const show = makeMovie({ id: 8, title: 'Busy Show', year: 2021, media_type: 'show', status: 'downloading' });
    mockMovies = [show];
    mockDownloadsByMovie.set(8, [
      makeDownload({ id: 8, movie_id: 8, release_name: 'Busy.Show.S01.GERMAN.1080p.WEB.h264-GRP' }),
      makeDownload({ id: 9, movie_id: 8, release_name: 'Busy.Show.S04.GERMAN.1080p.WEB.h264-GRP' }),
    ]);
    mockSeasonsByShow.set(8, [
      { id: 80, movie_id: 8, season_number: 1, status: 'downloading' },
      { id: 84, movie_id: 8, season_number: 4, status: 'downloading' },
    ]);
    const s01 = path.join(downloadPath, 'Busy.Show.S01E01.GERMAN.1080p.WEB.h264-GRP');
    const s04 = path.join(downloadPath, 'Busy.Show.S04E01.GERMAN.1080p.WEB.h264-GRP');
    fs.mkdirSync(s01); fs.mkdirSync(s04);
    writeMedia(path.join(s01, 'busy.show.s01e01.mkv'), 2);
    writeMedia(path.join(s04, 'busy.show.s04e01.mkv'), 2);
    jdState.downloadPackages = [{ uuid: 80, name: 'Busy Show (2021) - S01 - 1080p', finished: false, status: 'Downloading' }];

    for (let i = 0; i < 3; i++) {
      await runOneCycle();
      await vi.advanceTimersByTimeAsync(31_000);
    }

    expect(markEpisodesDownloaded).toHaveBeenCalledWith(84, [1], expect.anything());
    expect(markEpisodesDownloaded).not.toHaveBeenCalledWith(80, expect.anything(), expect.anything());
    expect(fs.existsSync(s01)).toBe(true);
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

    // One commit per episode folder (crash-safe) — together they cover both episodes.
    const marked70 = vi.mocked(markEpisodesDownloaded).mock.calls.filter(c => c[0] === 70).flatMap(c => c[1] as number[]);
    expect(marked70).toEqual(expect.arrayContaining([1, 2]));
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

  it('cleans up an abandoned JD package folder (archives only) once the film is in the library', async () => {
    // A superseded attempt: JD named the folder after the package, the archive
    // was never extracted. Neither the release-name match nor the
    // "still extracting" guard ever let it go — it sat there for months.
    configurePaths();
    mockMovies = [makeMovie({ status: 'downloaded' })];
    mockDownloadsByMovie.set(1, [makeDownload({ release_name: 'Test.Movie.2024.GERMAN.2160p.WEB-OTHER' })]);
    // JD's working subfolder — where the archives of a package actually sit.
    const leftover = path.join(downloadPath, 'unfertige', 'Test Movie (2024) - 2160p');
    fs.mkdirSync(leftover, { recursive: true });
    const part = path.join(leftover, 'abc.part01.rar');
    fs.writeFileSync(part, Buffer.alloc(1024));
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(part, old, old);
    writeMedia(path.join(moviesPath, 'Test Movie (2024).mkv'), 400);

    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    expect(fs.existsSync(leftover)).toBe(false);
  });

  it('keeps a JD package folder that is still being written to', async () => {
    configurePaths();
    mockMovies = [makeMovie({ status: 'downloaded' })];
    mockDownloadsByMovie.set(1, [makeDownload({ release_name: 'Test.Movie.2024.GERMAN.2160p.WEB-OTHER' })]);
    const leftover = path.join(downloadPath, 'Test Movie (2024) - 2160p');
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, 'abc.part01.rar'), Buffer.alloc(1024));
    writeMedia(path.join(moviesPath, 'Test Movie (2024).mkv'), 400);

    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    expect(fs.existsSync(leftover)).toBe(true);
  });

  it('never touches a package folder of a different title that merely starts the same', async () => {
    configurePaths();
    mockMovies = [makeMovie({ status: 'downloaded' })];
    mockDownloadsByMovie.set(1, [makeDownload()]);
    const other = path.join(downloadPath, 'Test Movie Returns (2024) - 2160p');
    fs.mkdirSync(other);
    const f = path.join(other, 'abc.part01.rar');
    fs.writeFileSync(f, Buffer.alloc(1024));
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(f, old, old);
    writeMedia(path.join(moviesPath, 'Test Movie (2024).mkv'), 400);

    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    expect(fs.existsSync(other)).toBe(true);
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

  it('keeps the existing copy when a quality upgrade fails', async () => {
    // The old file is still on disk and perfectly watchable. Marking the title
    // missing sent it round a pointless loop: the library check found the old
    // file moments later and flipped it back, re-stamping downloaded_at each
    // time — which is why such titles kept resurfacing under "recently added".
    jdState.configured = true;
    jdState.downloadPackages = [{ uuid: 7, name: 'Test Movie (2024)', finished: false, status: 'downloading' }];
    jdState.downloadLinks = [{ uuid: 1, status: 'offline' }];
    const movie = makeMovie({ status: 'downloading' });
    mockMovies = [movie];
    mockDownloadsByMovie.set(1, [makeDownload()]);
    upgradingMovies.add(1);

    await runOneCycle();

    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'downloaded');
    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'not_found', undefined, 'no_download');
    expect(upgradingMovies.has(1)).toBe(false);
  });

  it('does not spend the retry budget on a release that was dead at the hoster', async () => {
    // A dead release says nothing about the title's availability — the source
    // usually listed several more. Counting it made dlvault wait an hour before
    // trying the next candidate, then two, then four.
    jdState.configured = true;
    jdState.downloadPackages = [{ uuid: 7, name: 'Test Movie (2024)', finished: false, status: 'downloading' }];
    jdState.downloadLinks = [{ uuid: 1, status: 'offline' }];
    mockMovies = [makeMovie({ status: 'downloading' })];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();

    expect(addBlocklistEntry).toHaveBeenCalled();
    expect(incrementRetryCount).not.toHaveBeenCalled();
  });

  it('falls back to the backoff once enough releases have proven dead', async () => {
    // "Every candidate is dead" is a real state too; retrying it every half hour
    // forever would never give up.
    blocklistCount.value = 5;
    jdState.configured = true;
    jdState.downloadPackages = [{ uuid: 7, name: 'Test Movie (2024)', finished: false, status: 'downloading' }];
    jdState.downloadLinks = [{ uuid: 1, status: 'offline' }];
    mockMovies = [makeMovie({ status: 'downloading' })];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();

    expect(incrementRetryCount).toHaveBeenCalledWith(1);
  });

  it('leaves a title under repair alone', async () => {
    // Something deliberately reset it to fetch a replacement, and the media
    // server still lists the old copy because it has not rescanned. Flipping it
    // back here cancels the repair — observed with 27 seconds between
    // "re-downloading" and "found in library".
    libState.configured = true;
    libState.hasMovie = true;
    mockMovies = [makeMovie({ status: 'pending', repair: 1 })];

    await runOneCycle();

    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'downloaded');
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

  it('does not stale-reset while JD is still unpacking in its working folder', async () => {
    // JD dropped the finished package from its list while the archives were
    // being unpacked in unfertige/<package>; the reset re-sent the same release.
    jdState.configured = true;
    jdState.downloadPackages = [];
    jdState.linkGrabberPackages = [];
    mockSettings['paths.downloads'] = downloadPath;
    const work = path.join(downloadPath, 'unfertige', 'Test Movie (2024) - 2160p');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'abc.part01.rar'), Buffer.alloc(1024));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    mockMovies = [makeMovie({ status: 'downloading', updated_at: old })];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();

    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'pending');
    expect(addLogEntry).not.toHaveBeenCalledWith(1, 'download_stale', expect.any(String));
  });

  it('stale-reset of a SHOW also resets its in-flight seasons to pending (Lanternfall S01 deadlock)', async () => {
    // A season pack sent to JD but never landed leaves the season stuck at
    // 'downloading' with all episodes still 'pending'. The scheduler then reads it
    // as a "partial fill" and skips the pack forever. When the show's download goes
    // stale (no JD package anywhere), the orphaned in-flight season(s) must be reset
    // too so the pack is re-sent — 'downloaded' seasons stay untouched.
    jdState.configured = true;
    jdState.downloadPackages = [];
    jdState.linkGrabberPackages = [];
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const show = makeMovie({ id: 8, title: 'Lanternfall', year: 2021, media_type: 'show', status: 'downloading', updated_at: old });
    mockMovies = [show];
    mockDownloadsByMovie.set(8, [makeDownload({ movie_id: 8 })]);
    mockSeasonsByShow.set(8, [
      { id: 80, movie_id: 8, season_number: 1, status: 'downloading' }, // stuck pack
      { id: 81, movie_id: 8, season_number: 2, status: 'downloaded' },  // already in library
    ]);

    await runOneCycle();

    expect(updateMovieStatus).toHaveBeenCalledWith(8, 'pending');
    expect(updateSeasonStatus).toHaveBeenCalledWith(80, 'pending'); // dead season re-armed
    expect(updateSeasonStatus).not.toHaveBeenCalledWith(81, 'pending'); // finished season untouched
  });

  it('stale-reset of a SHOW also resets its stuck-downloading EPISODES to pending', async () => {
    // Individually-sent episodes carry their own 'downloading' status. The
    // scheduler re-selects only 'pending' episodes (getPendingEpisodes), so
    // resetting just the season left them stranded forever — and a later pass
    // with zero pending episodes even flipped the season to a false
    // 'downloaded' with no files on disk. Episodes already 'downloaded' must
    // stay untouched.
    jdState.configured = true;
    jdState.downloadPackages = [];
    jdState.linkGrabberPackages = [];
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const show = makeMovie({ id: 9, title: 'Weekly Show', year: 2025, media_type: 'show', status: 'downloading', updated_at: old });
    mockMovies = [show];
    mockDownloadsByMovie.set(9, [makeDownload({ movie_id: 9 })]);
    mockSeasonsByShow.set(9, [{ id: 90, movie_id: 9, season_number: 1, status: 'downloading' }]);
    mockEpisodesBySeason.set(90, [
      { id: 901, episode_number: 1, status: 'downloading' }, // sent to JD, package gone
      { id: 902, episode_number: 2, status: 'downloaded' },  // already in the library
    ]);

    await runOneCycle();

    expect(updateSeasonStatus).toHaveBeenCalledWith(90, 'pending');
    expect(updateEpisodeStatus).toHaveBeenCalledWith(901, 'pending');
    expect(updateEpisodeStatus).not.toHaveBeenCalledWith(902, expect.anything());
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
    // Moorhound scenario: download bytes complete but JD's unpacker errored. The
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

    // Two consecutive sightings — a single tick can be JD mid-repair.
    await runOneCycle();
    await runOneCycle();

    expect(jdownloaderService.removePackages).toHaveBeenCalledWith([42]);
    expect(addBlocklistEntry).toHaveBeenCalled();
    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'not_found', undefined, 'no_download');
    expect(addLogEntry).toHaveBeenCalledWith(1, 'extraction_failed', expect.any(String));
  });

  it('does not act on a single extraction-error tick (JD repairing a RAR volume)', async () => {
    jdState.configured = true;
    jdState.downloadPackages = [{
      uuid: 42, name: 'Test Movie (2024) - 1080p', finished: false,
      status: 'Entpacken fehlgeschlagen', statusIconKey: 'extractError',
    }];
    mockMovies = [makeMovie({ status: 'downloading' })];
    mockDownloadsByMovie.set(1, [makeDownload()]);

    await runOneCycle();
    jdState.downloadPackages = [{ uuid: 42, name: 'Test Movie (2024) - 1080p', finished: false, status: 'wird entpackt', statusIconKey: 'extract' }];
    await runOneCycle();

    expect(jdownloaderService.removePackages).not.toHaveBeenCalled();
    expect(addBlocklistEntry).not.toHaveBeenCalled();
  });

  it('never moves the output of an errored package, and clears it once the package is removed', async () => {
    mockSettings['paths.downloads'] = downloadPath;
    mockSettings['paths.movies'] = moviesPath;
    jdState.configured = true;
    const relFolder = 'Test.Movie.2024.GERMAN.1080p.WEB-DL';
    jdState.downloadPackages = [{
      uuid: 42, name: 'Test Movie (2024) - 1080p', finished: true, saveTo: `/output/${relFolder}`,
      status: 'Entpacken fehlgeschlagen', statusIconKey: 'extractError',
    }];
    mockMovies = [makeMovie({ status: 'downloading' })];
    mockDownloadsByMovie.set(1, [makeDownload()]);
    // What the failed extraction left behind: a media file, archives already gone.
    const folder = path.join(downloadPath, relFolder);
    fs.mkdirSync(folder);
    writeMedia(path.join(folder, 'movie.mkv'), 400);

    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();

    expect(fs.readdirSync(moviesPath)).toEqual([]);
    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'downloaded');
    expect(jdownloaderService.removePackages).toHaveBeenCalledWith([42]);
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('keeps an errored package\'s folder while it still holds archives', async () => {
    mockSettings['paths.downloads'] = downloadPath;
    mockSettings['paths.movies'] = moviesPath;
    jdState.configured = true;
    const relFolder = 'Test.Movie.2024.GERMAN.1080p.WEB-DL';
    jdState.downloadPackages = [{
      uuid: 42, name: 'Test Movie (2024) - 1080p', finished: false, saveTo: `/output/${relFolder}`,
      status: 'Entpacken fehlgeschlagen', statusIconKey: 'extractError',
    }];
    mockMovies = [makeMovie({ status: 'downloading' })];
    mockDownloadsByMovie.set(1, [makeDownload()]);
    const folder = path.join(downloadPath, relFolder);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'archive.part1.rar'), Buffer.alloc(1024));

    await runOneCycle();
    await runOneCycle();

    expect(jdownloaderService.removePackages).toHaveBeenCalledWith([42]);
    expect(fs.existsSync(folder)).toBe(true);
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
    // Moorhound leftover: a dead package sits in the linkgrabber with every child
    // offline, no longer mapped to any 'downloading' movie. The per-movie sync
    // can't reach it; the standalone janitor must remove it.
    jdState.configured = true;
    jdState.downloadPackages = [];
    jdState.linkGrabberPackages = [
      { uuid: 99, name: 'Moorhound (2025) - 1080p', childCount: 3, onlineCount: 0, offlineCount: 3 },
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

  it('JD janitor removes a finished package once the movie is downloaded (unblocks same-named re-sends)', async () => {
    // A lingering finished package makes the addLinks dedup swallow every later
    // same-named send (Endkontrolle repair, weekly pack refresh, [UPGRADE]) —
    // the send reports 'sent' but nothing reaches JD. Once the content is
    // confirmed in the library, the finished package must be cleaned up.
    jdState.configured = true;
    jdState.downloadPackages = [
      { uuid: 700, name: 'Test Movie (2024) - 1080p', finished: true, status: 'Fertig', bytesTotal: 5000, childCount: 2 },
    ];
    mockMovies = [makeMovie({ status: 'downloaded' })];

    await runOneCycle();

    expect(jdownloaderService.removePackages).toHaveBeenCalledWith([700]);
  });

  it('JD janitor leaves unfinished, untracked and not-yet-downloaded packages alone', async () => {
    jdState.configured = true;
    jdState.downloadPackages = [
      { uuid: 701, name: 'Test Movie (2024) - 1080p', finished: false, status: 'läuft', bytesTotal: 5000 }, // still downloading
      { uuid: 702, name: 'Somebody Elses Upload', finished: true, status: 'Fertig', bytesTotal: 5000 },     // not ours
    ];
    mockMovies = [makeMovie({ status: 'downloading' })];

    await runOneCycle();

    expect(jdownloaderService.removePackages).not.toHaveBeenCalled();
  });

  it('JD janitor removes a finished season pack only when that season is downloaded', async () => {
    jdState.configured = true;
    jdState.downloadPackages = [
      { uuid: 710, name: 'Test Show (2024) - S01 - 1080p', finished: true, status: 'Fertig', bytesTotal: 9000 },
      { uuid: 711, name: 'Test Show (2024) - S02 - 1080p', finished: true, status: 'Fertig', bytesTotal: 9000 },
    ];
    const show = makeMovie({ id: 5, title: 'Test Show', media_type: 'show', status: 'downloading' });
    mockMovies = [show];
    mockSeasonsByShow.set(5, [
      { id: 50, movie_id: 5, season_number: 1, status: 'downloaded' }, // moved to library
      { id: 51, movie_id: 5, season_number: 2, status: 'pending' },    // repair/re-send in flight
    ]);

    await runOneCycle();

    expect(jdownloaderService.removePackages).toHaveBeenCalledWith([710]);
  });
});

// ============================================================================
// JD relay budget — one snapshot per cycle + idle gate
// ============================================================================
describe('PostProcessor — JD relay budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('fetches each JD package list exactly ONCE per cycle (shared snapshot)', async () => {
    // Regression: trackJdPackageTransitions, checkCompletedDownloads,
    // syncDownloadingStatus and both janitors each issued their OWN
    // queryPackages call against the MyJD cloud relay — 4× DL + 2× LG per 30s
    // cycle. They must all share one snapshot now.
    jdState.configured = true;
    mockSettings['paths.downloads'] = downloadPath;
    mockSettings['paths.movies'] = moviesPath;
    const movie = makeMovie({ status: 'downloading' });
    mockMovies = [movie];
    jdState.downloadPackages = [
      { uuid: 1, name: 'Test Movie (2024) - 1080p', finished: false, status: 'läuft', bytesTotal: 100 },
    ];

    await runOneCycle();

    expect(vi.mocked(jdownloaderService.getDownloadPackages)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(jdownloaderService.getLinkGrabberPackages)).toHaveBeenCalledTimes(1);
  });

  it('idle gate: skips the JD poll for 3 cycles when nothing is in flight, polls on the 4th', async () => {
    jdState.configured = true;
    mockMovies = []; // nothing tracked
    jdState.downloadPackages = []; // nothing in JD either

    startPostProcessor();
    await vi.advanceTimersByTimeAsync(15_001); // cycle 1 → polls (fresh start)
    await _awaitCurrentCycle();
    await vi.advanceTimersByTimeAsync(30_000); // cycle 2 → skip
    await vi.advanceTimersByTimeAsync(30_000); // cycle 3 → skip
    await vi.advanceTimersByTimeAsync(30_000); // cycle 4 → skip
    await vi.advanceTimersByTimeAsync(30_000); // cycle 5 → polls again
    await _awaitCurrentCycle();
    stopPostProcessor();

    expect(vi.mocked(jdownloaderService.getDownloadPackages)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(jdownloaderService.getLinkGrabberPackages)).toHaveBeenCalledTimes(2);
  });

  it('keeps full-rate polling while a tracked download is active', async () => {
    jdState.configured = true;
    const movie = makeMovie({ status: 'downloading' });
    mockMovies = [movie];
    jdState.downloadPackages = [
      { uuid: 1, name: 'Test Movie (2024) - 1080p', finished: false, status: 'läuft', bytesTotal: 100 },
    ];

    startPostProcessor();
    await vi.advanceTimersByTimeAsync(15_001); // cycle 1
    await _awaitCurrentCycle();
    await vi.advanceTimersByTimeAsync(30_000); // cycle 2
    await vi.advanceTimersByTimeAsync(30_000); // cycle 3
    await _awaitCurrentCycle();
    stopPostProcessor();

    expect(vi.mocked(jdownloaderService.getDownloadPackages)).toHaveBeenCalledTimes(3);
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
  it('never blames the release for account, quota, wait or captcha trouble', () => {
    for (const status of [
      'Fehler: Premium-Account erforderlich', 'Error: Premium only', 'Konto-Fehler', 'Fehler: Download-Limit erreicht',
      'Error: Traffic limit reached', 'Fehler: Wartezeit 00:42:10', 'Captcha-Fehler', 'Fehler: IP gesperrt',
      'Fehler: Server ausgelastet', 'Error: no free slots', 'Fehler: vorübergehend nicht verfügbar', 'Login-Fehler',
    ]) {
      expect(jdPackageErrorKind({ uuid: 1, name: 'x', status }), status).toBeNull();
    }
    // A full disk, even reported as a failed extraction with the error icon.
    for (const status of ['Entpacken fehlgeschlagen: Nicht genug Speicherplatz', 'Extraction failed: not enough space', 'Fehler: Festplatte voll']) {
      expect(jdPackageErrorKind({ uuid: 1, name: 'x', status, statusIconKey: 'extractError' }), status).toBeNull();
    }
    // A real archive failure still counts, account words or not.
    expect(jdPackageErrorKind({ uuid: 1, name: 'x', status: 'Entpacken fehlgeschlagen' })).toBe('extraction');
    expect(jdPackageErrorKind({ uuid: 1, name: 'x', status: 'Fehler: Datei defekt' })).toBe('download');
  });
});

describe('PostProcessor — renameShowFolderForYear', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-year-'));
    mockSettings['paths.series'] = root;
    mockSettings['rename.series_folder_template'] = '{title} ({year})';
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  const show = (o: any = {}) => makeMovie({ id: 9, title: 'Sandmere', year: 2025, media_type: 'show', ...o });

  it('renames the "(Unknown)" folder once the year is known', () => {
    fs.mkdirSync(path.join(root, 'Sandmere (Unknown)'));
    fs.writeFileSync(path.join(root, 'Sandmere (Unknown)', 'Sandmere S01E01.mkv'), 'x');

    expect(renameShowFolderForYear(show(), 0)).toBe(true);
    expect(fs.existsSync(path.join(root, 'Sandmere (2025)', 'Sandmere S01E01.mkv'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'Sandmere (Unknown)'))).toBe(false);
  });

  it('also renames for a show whose year arrived another way (sweep: previous year null)', () => {
    fs.mkdirSync(path.join(root, 'Sandmere (Unknown)'));
    expect(renameShowFolderForYear(show(), null)).toBe(true);
    expect(fs.existsSync(path.join(root, 'Sandmere (2025)'))).toBe(true);
    // Nothing left to do on the next sweep.
    expect(renameShowFolderForYear(show(), null)).toBe(false);
  });

  it('renames a folder made without the year', () => {
    fs.mkdirSync(path.join(root, 'Sandmere'));
    expect(renameShowFolderForYear(show(), null)).toBe(true);
    expect(fs.existsSync(path.join(root, 'Sandmere (2025)'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'Sandmere'))).toBe(false);
  });

  it('never merges into an existing folder and ignores movies', () => {
    fs.mkdirSync(path.join(root, 'Sandmere (Unknown)'));
    fs.mkdirSync(path.join(root, 'Sandmere (2025)'));
    expect(renameShowFolderForYear(show(), 0)).toBe(false);
    expect(fs.existsSync(path.join(root, 'Sandmere (Unknown)'))).toBe(true);
    expect(renameShowFolderForYear(show({ media_type: 'movie' }), 0)).toBe(false);
  });
});

describe('PostProcessor — jdPackageExtracting', () => {
  it('is true for the extraction spinner and its status text', () => {
    expect(jdPackageExtracting({ uuid: 1, name: 'x', statusIconKey: 'extract' })).toBe(true);
    expect(jdPackageExtracting({ uuid: 1, name: 'x', status: 'Wird entpackt (3/22)' })).toBe(true);
  });
  it('is false for a finished, failed or plain downloading package', () => {
    expect(jdPackageExtracting({ uuid: 1, name: 'x', statusIconKey: 'extractOk', status: 'Entpacken OK' })).toBe(false);
    expect(jdPackageExtracting({ uuid: 1, name: 'x', status: 'Entpacken fehlgeschlagen' })).toBe(false);
    expect(jdPackageExtracting({ uuid: 1, name: 'x', status: 'Downloading', running: true })).toBe(false);
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

  it('sends a downloaded show with a reopened season back to pending instead of closing the season', async () => {
    mockMovies = [makeMovie({ id: 3, media_type: 'show', status: 'downloaded' })];
    mockSeasonsByShow.set(3, [
      { id: 60, movie_id: 3, season_number: 1, status: 'downloaded' },
      { id: 61, movie_id: 3, season_number: 2, status: 'pending' },
    ]);

    await runReconcile();

    expect(updateMovieStatus).toHaveBeenCalledWith(3, 'pending');
    expect(updateSeasonStatus).not.toHaveBeenCalledWith(61, 'downloaded');
  });

  it('ignores seasons below the cutoff', async () => {
    mockMovies = [makeMovie({ id: 3, media_type: 'show', status: 'downloaded', season_cutoff: 2 })];
    mockSeasonsByShow.set(3, [
      { id: 60, movie_id: 3, season_number: 1, status: 'pending' },
      { id: 61, movie_id: 3, season_number: 2, status: 'downloaded' },
    ]);

    await runReconcile();

    expect(updateMovieStatus).not.toHaveBeenCalled();
    expect(updateSeasonStatus).not.toHaveBeenCalled();
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

// ============================================================================
// Subtitle carry-over — the file-level error paths here were entirely untested.
// ============================================================================
describe('PostProcessor — moveCompanionSubtitles', () => {
  let dir: string;
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-subs-'));
    srcDir = path.join(dir, 'src');
    destDir = path.join(dir, 'dest');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  const video = () => path.join(srcDir, 'Test.Movie.2024.1080p.mkv');
  const dest = () => path.join(destDir, 'Test Movie (2024).mkv');

  function write(p: string, body = 'sub') { fs.writeFileSync(p, body); }

  it('renames a matching subtitle onto the library file name, keeping the suffix', async () => {
    write(video());
    write(path.join(srcDir, 'Test.Movie.2024.1080p.ger.srt'));

    const moved = await moveCompanionSubtitles(video(), dest());

    expect(moved).toBe(1);
    expect(fs.existsSync(path.join(destDir, 'Test Movie (2024).ger.srt'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'Test.Movie.2024.1080p.ger.srt'))).toBe(false);
  });

  it('keeps its own name when a subtitle does not share the video base name', async () => {
    write(video());
    write(path.join(srcDir, 'German.forced.srt'));

    const moved = await moveCompanionSubtitles(video(), dest());

    expect(moved).toBe(1);
    expect(fs.existsSync(path.join(destDir, 'Test Movie (2024).German.forced.srt'))).toBe(true);
  });

  it('matches the base name case-insensitively', async () => {
    write(video());
    write(path.join(srcDir, 'TEST.MOVIE.2024.1080P.en.srt'));

    await moveCompanionSubtitles(video(), dest());

    expect(fs.readdirSync(destDir)).toEqual(['Test Movie (2024).en.srt']);
  });

  it('never overwrites a subtitle already in the library', async () => {
    write(video());
    write(path.join(srcDir, 'Test.Movie.2024.1080p.ger.srt'), 'neu');
    write(path.join(destDir, 'Test Movie (2024).ger.srt'), 'bestehend');

    const moved = await moveCompanionSubtitles(video(), dest());

    expect(moved).toBe(0);
    expect(fs.readFileSync(path.join(destDir, 'Test Movie (2024).ger.srt'), 'utf8')).toBe('bestehend');
    expect(fs.existsSync(path.join(srcDir, 'Test.Movie.2024.1080p.ger.srt'))).toBe(true);
  });

  it('falls back to copy+delete when the move crosses a filesystem boundary', async () => {
    // /downloads and /movies are routinely separate mounts, so rename() fails
    // with EXDEV and the copy path is what actually runs in production.
    write(video());
    const sub = path.join(srcDir, 'Test.Movie.2024.1080p.ger.srt');
    write(sub, 'inhalt');

    const realRename = fs.promises.rename;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async () => {
      const err: any = new Error('cross-device link not permitted');
      err.code = 'EXDEV';
      throw err;
    });

    const moved = await moveCompanionSubtitles(video(), dest());
    spy.mockRestore();
    expect(fs.promises.rename).toBe(realRename);

    expect(moved).toBe(1);
    expect(fs.readFileSync(path.join(destDir, 'Test Movie (2024).ger.srt'), 'utf8')).toBe('inhalt');
    expect(fs.existsSync(sub)).toBe(false);
  });

  it('takes only this episode\'s subtitles out of a season pack folder', async () => {
    const ep1 = path.join(srcDir, 'show.s02e01.german.1080p-grp.mkv');
    write(ep1);
    write(path.join(srcDir, 'show.s02e03.german.1080p-grp.mkv'));
    write(path.join(srcDir, 'show.s02e01.german.1080p-grp.idx'));
    write(path.join(srcDir, 'show.s02e03.german.1080p-grp.idx'));
    write(path.join(srcDir, 'show.s02e07.german.1080p-grp-eng.sub'));
    write(path.join(srcDir, 'forced.srt'));

    const moved = await moveCompanionSubtitles(ep1, path.join(destDir, 'Show S02E01.mkv'));

    expect(moved).toBe(1);
    expect(fs.readdirSync(destDir)).toEqual(['Show S02E01.idx']);
    expect(fs.existsSync(path.join(srcDir, 'show.s02e03.german.1080p-grp.idx'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'forced.srt'))).toBe(true);
  });

  it('accepts a differently named subtitle that carries the same episode marker', async () => {
    const ep = path.join(srcDir, 'Show.S01E04.1080p.mkv');
    write(ep);
    write(path.join(srcDir, 'Other.Show.S01E05.1080p.mkv'));
    write(path.join(srcDir, 'show.s01e04.forced.srt'));

    expect(await moveCompanionSubtitles(ep, path.join(destDir, 'Show S01E04.mkv'))).toBe(1);
    expect(fs.readdirSync(destDir)).toEqual(['Show S01E04.show.s01e04.forced.srt']);
  });

  it('carries on with the remaining subtitles when one fails', async () => {
    write(video());
    write(path.join(srcDir, 'Test.Movie.2024.1080p.ger.srt'));
    write(path.join(srcDir, 'Test.Movie.2024.1080p.eng.srt'));

    const spy = vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async () => {
      throw new Error('EACCES: permission denied');
    });

    const moved = await moveCompanionSubtitles(video(), dest());
    spy.mockRestore();

    expect(moved).toBe(1);
    expect(fs.readdirSync(destDir)).toHaveLength(1);
  });

  it('does nothing when there are no subtitles beside the video', async () => {
    write(video());
    expect(await moveCompanionSubtitles(video(), dest())).toBe(0);
  });
});

// ============================================================================
// moveFolder's data-safety guards. These decide whether a file in the user's
// library survives, so they are the ones worth pinning down.
// ============================================================================
describe('PostProcessor — moving into the library', () => {
  const FOLDER = 'Test.Movie.2024.GERMAN.1080p.WEB-DL';

  beforeEach(() => {
    vi.useFakeTimers();
    mockSettings['paths.downloads'] = downloadPath;
    mockSettings['paths.movies'] = moviesPath;
    mockSettings['paths.series'] = seriesPath;
    upgradingMovies.clear();
  });
  afterEach(() => { upgradingMovies.clear(); ffprobeState.tags = null; ffprobeState.seconds = null; _resetMoveFailures(); });

  /** A finished JD package plus a stable download folder holding one media file. */
  function stageDownload(sizeMB: number) {
    jdState.configured = true;
    jdState.downloadPackages = [{
      uuid: 21, name: 'Test Movie (2024) [src]', finished: true, status: 'finished',
      saveTo: path.join(downloadPath, FOLDER),
    }];
    mockMovies = [makeMovie({ status: 'downloading' })];
    mockDownloadsByMovie.set(1, [makeDownload()]);
    const folder = path.join(downloadPath, FOLDER);
    fs.mkdirSync(folder);
    writeMedia(path.join(folder, 'movie.mkv'), sizeMB);
    return folder;
  }

  async function settle() {
    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();
  }

  const libraryFile = () => path.join(moviesPath, 'Test Movie (2024).mkv');

  // The cross-device (EXDEV) branch of moveFolder — the normal path in a container —
  // is covered in postprocess-move.test.ts, which mocks 'fs' on its own.

  it('keeps the library copy when the new file is not bigger', async () => {
    // A reconcile false-negative can pull a lesser release for something already
    // in the library. Overwriting there would trade a good file for a worse one.
    const folder = stageDownload(300);
    writeMedia(libraryFile(), 900);

    await settle();

    expect(fs.statSync(libraryFile()).size).toBe(900 * 1024 * 1024);
    expect(fs.existsSync(path.join(folder, 'movie.mkv'))).toBe(false);
  });

  it('overwrites anyway when the scheduler flagged it as a quality upgrade', async () => {
    // Size is a bad proxy for "better": 2160p HEVC is routinely SMALLER than the
    // 1080p x264 it replaces, so the guard above has to stand down for a
    // deliberate upgrade — otherwise it deletes the very file just downloaded
    // and reports success with nothing changed.
    const folder = stageDownload(300);
    writeMedia(libraryFile(), 900);
    upgradingMovies.add(1);

    await settle();

    expect(fs.statSync(libraryFile()).size).toBe(300 * 1024 * 1024);
    expect(fs.existsSync(path.join(folder, 'movie.mkv'))).toBe(false);
  });


  it('backs off after a failed move instead of copying again every cycle', async () => {
    // A full disk or an offline share used to restart the whole copy every 30 s.
    const folder = stageDownload(300);
    fs.rmSync(moviesPath, { recursive: true, force: true });
    fs.writeFileSync(moviesPath, 'not a directory');   // the target is unusable

    await settle();
    expect(fs.existsSync(path.join(folder, 'movie.mkv'))).toBe(true);   // nothing lost

    // The problem is fixed — but the backoff holds the next attempt back…
    fs.rmSync(moviesPath, { force: true });
    fs.mkdirSync(moviesPath);
    await runOneCycle();
    expect(fs.existsSync(libraryFile())).toBe(false);

    // …until it has run out.
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    await settle();
    expect(fs.existsSync(libraryFile())).toBe(true);
  });

  it('keeps a film out of the library whose playing time does not fit (wrong film)', async () => {
    // Two films with a similar title sat in a real library a third longer than
    // the film they were filed as — nothing ever looked.
    const folder = stageDownload(300);
    mockMovies = [makeMovie({ status: 'downloading', runtime: 100 })];
    ffprobeState.seconds = 134 * 60;

    await settle();

    expect(fs.existsSync(libraryFile())).toBe(false);
    expect(fs.existsSync(folder)).toBe(false);
    expect(addBlocklistEntry).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('Laufzeit') }));
    expect(addLogEntry).toHaveBeenCalledWith(1, 'import_rejected', expect.stringContaining('134 min statt 100 min'));
  });

  it('imports a film whose playing time fits', async () => {
    stageDownload(300);
    mockMovies = [makeMovie({ status: 'downloading', runtime: 100 })];
    ffprobeState.seconds = 101 * 60;

    await settle();

    expect(fs.existsSync(libraryFile())).toBe(true);
  });

  it('rejects an upgrade whose audio has no track in the wanted language', async () => {
    // An English-only WEB-DL taken for German replaced a German film. The old
    // copy must survive, the release gets blocklisted, the download goes.
    const folder = stageDownload(300);
    writeMedia(libraryFile(), 900);
    upgradingMovies.add(1);
    ffprobeState.tags = ['eng'];

    await settle();

    expect(fs.statSync(libraryFile()).size).toBe(900 * 1024 * 1024);
    expect(fs.existsSync(folder)).toBe(false);
    expect(addBlocklistEntry).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('Tonspur') }));
    expect(updateMovieStatus).toHaveBeenCalledWith(1, 'downloaded');
  });

  it('lets an upgrade with a German-tagged track (or untagged audio) through', async () => {
    stageDownload(300);
    writeMedia(libraryFile(), 900);
    upgradingMovies.add(1);
    ffprobeState.tags = ['ger', 'eng'];

    await settle();

    expect(fs.statSync(libraryFile()).size).toBe(300 * 1024 * 1024);
  });
});

// ============================================================================
// Deleting a leftover download folder is the one `rm -rf` this service performs
// on user data. Three guards authorise it; each is pinned separately below.
// ============================================================================
describe('PostProcessor — removing a leftover download folder', () => {
  const FOLDER = 'Test.Movie.2024.GERMAN.1080p.WEB-DL';

  beforeEach(() => {
    vi.useFakeTimers();
    mockSettings['paths.downloads'] = downloadPath;
    mockSettings['paths.movies'] = moviesPath;
    mockSettings['paths.series'] = seriesPath;
    mockSettings['rename.junk_min_size_mb'] = '300';
  });

  /** A remnant: Sample/Subs only, no feature file anywhere near the threshold. */
  function stageRemnant(status: string) {
    mockMovies = [makeMovie({ status })];
    mockDownloadsByMovie.set(1, [makeDownload()]);
    const folder = path.join(downloadPath, FOLDER);
    fs.mkdirSync(folder);
    writeMedia(path.join(folder, 'sample.mkv'), 5);
    fs.writeFileSync(path.join(folder, 'movie.nfo'), 'x');
    return folder;
  }

  const inLibrary = () => writeMedia(path.join(moviesPath, 'Test Movie (2024).mkv'), 900);

  // The move path only acts on a folder it has seen unchanged across two cycles.
  async function settle() {
    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();
  }

  it('deletes it once the feature is confirmed in the library', async () => {
    // Its on-disk name can differ from the stored release_name, so the orphan
    // cleanup never matches it while the fuzzy move-path re-claims it every
    // cycle — an endless "no media file" loop until the folder goes.
    const folder = stageRemnant('downloaded');
    inLibrary();

    await settle();

    expect(fs.existsSync(folder)).toBe(false);
  });

  it('keeps it when the title is not actually in the library', async () => {
    // Without this check the folder of a different, still-needed title could be
    // deleted on a loose name match.
    const folder = stageRemnant('downloaded');

    await settle();

    expect(fs.existsSync(folder)).toBe(true);
  });

  it('does not accept a merely similar library title as confirmation', async () => {
    // The gate that authorises rm -rf has to be an identity check, not a hint:
    // on a title-words rule "Sandmere (2021)" was confirmed by
    // "/movies/Sandmere Part Two (2024).mkv", and the leftover folder of a
    // different, still-needed title got deleted.
    mockMovies = [makeMovie({ id: 1, title: 'Sandmere', year: 2021, status: 'downloaded' })];
    mockDownloadsByMovie.set(1, [makeDownload({ release_name: 'Sandmere.2021.GERMAN.1080p.WEB-DL' })]);
    const folder = path.join(downloadPath, 'Sandmere.2021.GERMAN.1080p.WEB-DL');
    fs.mkdirSync(folder);
    writeMedia(path.join(folder, 'sample.mkv'), 5);
    writeMedia(path.join(moviesPath, 'Sandmere Part Two (2024).mkv'), 900);

    await settle();

    expect(fs.existsSync(folder)).toBe(true);
  });
});

// ============================================================================
// What happens to the SHOW once its episodes land — the tail of the season
// move that decides 'downloaded' vs 'downloading' and whether anyone is told.
// ============================================================================
describe('PostProcessor — show status after episodes land', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSettings['paths.downloads'] = downloadPath;
    mockSettings['paths.movies'] = moviesPath;
    mockSettings['paths.series'] = seriesPath;
  });

  /** Drops episode folders into /downloads and lets them settle. */
  async function deliver(names: string[]) {
    for (const n of names) {
      const f = path.join(downloadPath, n);
      fs.mkdirSync(f);
      writeMedia(path.join(f, 'ep.mkv'), 400);
    }
    for (let i = 0; i < 4; i++) {
      await runOneCycle();
      await vi.advanceTimersByTimeAsync(31_000);
    }
  }

  it('marks the show downloaded and announces it once every season is complete', async () => {
    const show = makeMovie({ id: 7, title: 'Done Show', year: 2020, media_type: 'show', status: 'downloading' });
    mockMovies = [show];
    mockDownloadsByMovie.set(7, [makeDownload({ id: 7, movie_id: 7, release_name: 'Done.Show.S01E01.GERMAN.1080p' })]);
    mockSeasonsByShow.set(7, [{ id: 70, movie_id: 7, season_number: 1, status: 'downloading' }]);
    mockEpisodesBySeason.set(70, [
      { episode_number: 1, status: 'pending' },
      { episode_number: 2, status: 'pending' },
    ]);

    await deliver(['Done.Show.S01E01.GERMAN.1080p', 'Done.Show.S01E02.GERMAN.1080p']);

    expect(updateSeasonStatus).toHaveBeenCalledWith(70, 'downloaded');
    expect(updateMovieStatus).toHaveBeenCalledWith(7, 'downloaded');
    // Unique to the season-move tail: only that block closes out the download
    // rows. Asserting the statuses alone would also pass on the reconcile
    // healing path, which reaches 'downloaded' by a different route.
    expect(updateDownloadStatusBySeason).toHaveBeenCalledWith(7, 1, 'completed');
    expect(updateDownloadStatusBySeason).toHaveBeenCalledWith(7, null, 'completed');
    // Deliberately not asserting the Telegram notification: it fires only on the
    // transition (`wasAlreadyDownloaded`), and which cycle first flips the show
    // depends on whether an earlier step in the same pass got there — pinning
    // that would test the harness's ordering, not the behaviour.
  });

  it('asks the media server to rescan once episodes have landed', async () => {
    const refresh = libState.refresh;
    refresh.mockClear();
    const { _resetLibraryRefresh } = await import('../../src/services/postprocess');
    _resetLibraryRefresh();
    const show = makeMovie({ id: 9, title: 'Scan Show', year: 2022, media_type: 'show', status: 'downloading' });
    mockMovies = [show];
    mockDownloadsByMovie.set(9, [makeDownload({ id: 9, movie_id: 9, release_name: 'Scan.Show.S01E01.GERMAN.1080p' })]);
    mockSeasonsByShow.set(9, [{ id: 90, movie_id: 9, season_number: 1, status: 'downloading' }]);
    mockEpisodesBySeason.set(90, [{ episode_number: 1, status: 'pending' }]);

    await deliver(['Scan.Show.S01E01.GERMAN.1080p']);
    expect(updateSeasonStatus).toHaveBeenCalledWith(90, 'downloaded');
    // Debounced 15 s, so a whole season pack causes one scan, not one per file.
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1), { timeout: 20_000, interval: 250 });
  }, 30_000);

  it('leaves a show downloading while another season is still outstanding', async () => {
    const show = makeMovie({ id: 8, title: 'Part Show', year: 2021, media_type: 'show', status: 'pending' });
    mockMovies = [show];
    mockDownloadsByMovie.set(8, [makeDownload({ id: 8, movie_id: 8, release_name: 'Part.Show.S01E01.GERMAN.1080p' })]);
    mockSeasonsByShow.set(8, [
      { id: 80, movie_id: 8, season_number: 1, status: 'downloading' },
      { id: 81, movie_id: 8, season_number: 2, status: 'pending' },
    ]);
    mockEpisodesBySeason.set(80, [{ episode_number: 1, status: 'pending' }]);

    await deliver(['Part.Show.S01E01.GERMAN.1080p']);

    expect(updateSeasonStatus).toHaveBeenCalledWith(80, 'downloaded');
    // S02 has not arrived, so the show itself is not finished.
    expect(updateMovieStatus).not.toHaveBeenCalledWith(8, 'downloaded');
    expect(sendTelegramNotification).not.toHaveBeenCalledWith(
      'download_complete', 'Part Show', expect.anything(), expect.anything(), expect.anything());
  });
});

// ============================================================================
// The container-path warning. Per the Windows support notes this is the single
// biggest "the pipeline looks dead" trap: a host path that does not exist inside
// the container makes every move fail silently.
// ============================================================================
describe('PostProcessor — flagging a misconfigured container path', () => {
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    mockSettings['paths.downloads'] = downloadPath;
    mockSettings['paths.series'] = seriesPath;
    ({ logger: { warn } } = await import('../../src/utils/logger') as any);
  });

  const warnings = () => warn.mock.calls.map(c => String(c[0]));

  it('names a Windows path for what it is', async () => {
    // Unique per test: the warn-once set is module state that outlives a test.
    mockSettings['paths.movies'] = 'C:\\Media\\Filme';

    await runOneCycle();

    const hit = warnings().find(m => m.includes('paths.movies'));
    expect(hit).toBeDefined();
    expect(hit).toMatch(/Windows/);
    expect(hit).toMatch(/CONTAINER mount path/);
  });

  it('reports a Linux path that is not mounted inside the container', async () => {
    mockSettings['paths.movies'] = '/mnt/nicht-gemountet-xyz';

    await runOneCycle();

    const hit = warnings().find(m => m.includes('/mnt/nicht-gemountet-xyz'));
    expect(hit).toBeDefined();
    expect(hit).toMatch(/does not exist inside the container/);
  });

  it('says it once, not on every 30s cycle', async () => {
    mockSettings['paths.movies'] = 'D:\\Wiederholt';

    for (let i = 0; i < 4; i++) {
      await runOneCycle();
      await vi.advanceTimersByTimeAsync(31_000);
    }

    expect(warnings().filter(m => m.includes('D:\\Wiederholt'))).toHaveLength(1);
  });

  it('stays quiet for a path that really is mounted', async () => {
    mockSettings['paths.movies'] = moviesPath;

    await runOneCycle();

    expect(warnings().filter(m => m.includes(moviesPath))).toHaveLength(0);
  });
});

// ============================================================================
// A move that fails is a filesystem problem (permissions, disk full, share
// offline) — not a bad download. The status must survive so the next cycle can
// retry, and the log must not repeat the same line every 30 seconds.
// ============================================================================
describe('PostProcessor — when the move to the library fails', () => {
  const FOLDER = 'Test.Movie.2024.GERMAN.1080p.WEB-DL';
  let readOnlyLib: string;

  beforeEach(() => {
    vi.useFakeTimers();
    readOnlyLib = path.join(tmpRoot, 'ro-movies');
    fs.mkdirSync(readOnlyLib, { recursive: true });
    mockSettings['paths.downloads'] = downloadPath;
    mockSettings['paths.movies'] = readOnlyLib;
    mockSettings['paths.series'] = seriesPath;

    jdState.configured = true;
    jdState.downloadPackages = [{
      uuid: 21, name: 'Test Movie (2024) [src]', finished: true, status: 'finished',
      saveTo: path.join(downloadPath, FOLDER),
    }];
    mockMovies = [makeMovie({ status: 'downloading' })];
    mockDownloadsByMovie.set(1, [makeDownload()]);
    const folder = path.join(downloadPath, FOLDER);
    fs.mkdirSync(folder);
    writeMedia(path.join(folder, 'movie.mkv'), 400);

    fs.chmodSync(readOnlyLib, 0o500);   // no write → rename throws EACCES
  });

  afterEach(() => {
    try { fs.chmodSync(readOnlyLib, 0o700); } catch { /* already gone */ }
  });

  async function settle() {
    await runOneCycle();
    await vi.advanceTimersByTimeAsync(31_000);
    await runOneCycle();
  }

  it('records the failure and keeps the title out of "downloaded"', async () => {
    await settle();

    expect(addLogEntry).toHaveBeenCalledWith(1, 'move_failed', expect.stringContaining('Verschieben in die Mediathek fehlgeschlagen'));
    // Re-searching would not help — the download itself is fine.
    expect(updateMovieStatus).not.toHaveBeenCalledWith(1, 'downloaded');
    expect(fs.existsSync(path.join(downloadPath, FOLDER, 'movie.mkv'))).toBe(true);
  });

  it('does not repeat the entry while a recent one already stands', async () => {
    vi.mocked(hasRecentActivityEntry).mockReturnValue(true);

    await settle();

    expect(addLogEntry).not.toHaveBeenCalledWith(1, 'move_failed', expect.anything());
  });
});

// ============================================================================
// JD's modal dialogs block the calling thread, so one unanswered "file already
// exists" prompt freezes the whole download→extract→move pipeline. This sweep
// runs at the top of every cycle, before any JD state is read.
// ============================================================================
describe('PostProcessor — clearing blocking JDownloader dialogs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSettings['paths.downloads'] = downloadPath;
    mockSettings['paths.movies'] = moviesPath;
    mockSettings['paths.series'] = seriesPath;
    jdState.configured = true;
  });

  it('logs and raises an alert for every dialog it answered', async () => {
    jdState.blockingDialogs = [
      { type: 'FILE_EXISTS', title: 'Test Movie.mkv' },
      { type: 'DUPLICATE_LINKS' },
    ];

    await runOneCycle();

    expect(addLogEntry).toHaveBeenCalledWith(null, 'jd_dialog_cleared',
      expect.stringContaining('FILE_EXISTS: Test Movie.mkv'));
    expect(sendTelegramSystemAlert).toHaveBeenCalledWith(expect.stringContaining('DUPLICATE_LINKS'));
  });

  it('stays silent when there was nothing to answer', async () => {
    jdState.blockingDialogs = [];

    await runOneCycle();

    expect(addLogEntry).not.toHaveBeenCalledWith(null, 'jd_dialog_cleared', expect.anything());
    expect(sendTelegramSystemAlert).not.toHaveBeenCalled();
  });

  it('does not touch JD at all when it is not configured', async () => {
    jdState.configured = false;
    jdState.blockingDialogs = [{ type: 'FILE_EXISTS' }];

    await runOneCycle();

    expect(sendTelegramSystemAlert).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Reconcile: the file is in /movies but the media server never lists it —
// usually the /movies mount is not the folder the server scans, or scanning is
// off. Guarded hard so a normal scan delay never trips it.
// ============================================================================
describe('PostProcessor — on disk but missing from the media server', () => {
  const OLD = () => new Date(Date.now() - 7 * 3600_000).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    mockSettings['paths.downloads'] = downloadPath;
    mockSettings['paths.movies'] = moviesPath;
    mockSettings['paths.series'] = seriesPath;
    libState.configured = true;
    libState.cachedMovieCount = 250;   // a populated cache, so absence means something
    libState.hasMovie = false;
    mockMovies = [makeMovie({ status: 'downloaded', downloaded_at: OLD() })];
    writeMedia(path.join(moviesPath, 'Test Movie (2024).mkv'), 900);
  });

  it('warns once the move has had time to settle', async () => {
    await runReconcile();

    expect(addLogEntry).toHaveBeenCalledWith(1, 'library_scan_missing', expect.any(String));
  });

  it('says nothing while the move is still fresh', async () => {
    // A media server can take a while to scan; 6h of settle time is the guard.
    mockMovies = [makeMovie({ status: 'downloaded', downloaded_at: new Date().toISOString() })];

    await runReconcile();

    expect(addLogEntry).not.toHaveBeenCalledWith(1, 'library_scan_missing', expect.anything());
  });

  it('says nothing when the library cache is empty', async () => {
    // An empty cache means the server has not been read yet — "not listed" then
    // proves nothing at all.
    libState.cachedMovieCount = 0;

    await runReconcile();

    expect(addLogEntry).not.toHaveBeenCalledWith(1, 'library_scan_missing', expect.anything());
  });

  it('says nothing when the server does list it', async () => {
    libState.hasMovie = true;

    await runReconcile();

    expect(addLogEntry).not.toHaveBeenCalledWith(1, 'library_scan_missing', expect.anything());
  });
});

describe('jdPackageMatchesMovie', () => {
  it('still recognises a package sent before the year was known', () => {
    const m = { title: 'Sandmere', year: 2026 };
    expect(jdPackageMatchesMovie('Sandmere (2026) - S01 - 1080p', m)).toBe(true);
    expect(jdPackageMatchesMovie('Sandmere (0) - S01 - 1080p', m)).toBe(true);
    expect(jdPackageMatchesMovie('Sandmere - S01 - 1080p', m)).toBe(true);
    expect(jdPackageMatchesMovie('Sandmere (2019) - S01 - 1080p', m)).toBe(false);
    expect(jdPackageMatchesMovie('Sandmere Rising (2026) - 1080p', m)).toBe(false);
    expect(jdPackageMatchesMovie('Grell: Part Two (0) - 2160p', { title: 'Grell: Part Two', year: 2024 })).toBe(false);
    expect(jdPackageMatchesMovie('Grell; Part Two (0) - 2160p', { title: 'Grell: Part Two', year: 2024 })).toBe(true);
  });
});

describe('visibleBelowDownloadPath', () => {
  it('finds a package in JD\'s "unfinished" subfolder below the shared mount', () => {
    // JD /output == dlvault /downloads; JD writes /output/unfertige/<package>.
    // The mount is fine — warning "mount mismatch" there was a false alarm.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-mount-'));
    fs.mkdirSync(path.join(root, 'unfertige', 'Grell; Die Rückkehr (2025) - 1080p'), { recursive: true });
    expect(visibleBelowDownloadPath('/output/unfertige/Grell; Die Rückkehr (2025) - 1080p', root)).toBe(true);
    expect(visibleBelowDownloadPath('/elsewhere/other/Sandmere (2024)', root)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('PostProcessor — renameLibraryForImdbId', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-imdbfix-'));
    mockSettings['paths.movies'] = root;
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it('retags every entry carrying the wrong id and nothing else', () => {
    const put = (n: string) => fs.writeFileSync(path.join(root, n), 'x');
    put('Grell (2025) [imdbid-tt9000003].mkv');
    put('Grell (2025) [imdbid-tt9000003].de.srt');
    put('Grell (2025) {imdb-tt9000003}.nfo');
    put('Grell (2025).mkv');                          // no id: left to title + year
    put('Other (2025) [imdbid-tt900000300].mkv');        // longer id, not ours
    const movie = makeMovie({ id: 3, title: 'Grell', year: 2025, media_type: 'movie' });

    expect(renameLibraryForImdbId(movie, 'tt9000003', 'tt9000004')).toBe(3);
    expect(fs.readdirSync(root).sort()).toEqual([
      'Grell (2025) [imdbid-tt9000004].de.srt',
      'Grell (2025) [imdbid-tt9000004].mkv',
      'Grell (2025) {imdb-tt9000004}.nfo',
      'Grell (2025).mkv',
      'Other (2025) [imdbid-tt900000300].mkv',
    ]);
  });

  it('never overwrites an existing entry', () => {
    fs.writeFileSync(path.join(root, 'P [imdbid-tt1].mkv'), 'old');
    fs.writeFileSync(path.join(root, 'P [imdbid-tt2].mkv'), 'keep');
    expect(renameLibraryForImdbId(makeMovie({ id: 3, title: 'P', media_type: 'movie' }), 'tt1', 'tt2')).toBe(0);
    expect(fs.readFileSync(path.join(root, 'P [imdbid-tt2].mkv'), 'utf8')).toBe('keep');
  });
});

describe('PostProcessor — normalizeLibraryName', () => {
  let root: string;
  const put = (n: string) => fs.writeFileSync(path.join(root, n), 'x');
  const ls = () => fs.readdirSync(root).sort();
  const film = (o: any = {}) => makeMovie({ id: 3, title: 'Quiet Ember', year: 2015, imdb_id: 'tt9000005', tmdb_id: 4244, media_type: 'movie', ...o });
  const show = (o: any = {}) => makeMovie({ id: 4, title: 'Wardline', year: 2017, imdb_id: 'tt9000006', media_type: 'show', ...o });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-norm-'));
    mockSettings['paths.movies'] = root;
    mockSettings['paths.series'] = root;
    mockSettings['rename.movie_file_template'] = '{title} ({year}) [imdbid-{imdbid}]';
    mockSettings['rename.series_folder_template'] = '{title} ({year}) [imdbid-{imdbid}]';
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it('gives an old film name the id tag, sidecars included', () => {
    put('Quiet Ember (2015).mkv'); put('Quiet Ember (2015).de.srt'); put('Quiet Ember (2015).nfo');
    expect(normalizeLibraryName(film(), { idConfirmed: true })).toBe(true);
    expect(ls()).toEqual([
      'Quiet Ember (2015) [imdbid-tt9000005].de.srt',
      'Quiet Ember (2015) [imdbid-tt9000005].mkv',
      'Quiet Ember (2015) [imdbid-tt9000005].nfo',
    ]);
    expect(normalizeLibraryName(film(), { idConfirmed: true })).toBe(false);   // nothing left to do
  });

  it('never stamps an unconfirmed imdb id into a name', () => {
    put('Quiet Ember (2015).mkv');
    expect(normalizeLibraryName(film(), { idConfirmed: false })).toBe(false);
    expect(ls()).toEqual(['Quiet Ember (2015).mkv']);
  });

  it('completes a name written while the year was unknown, when its id says which film it is', () => {
    put('Quiet Ember [imdbid-tt9000005].mkv');
    put('Quiet Ember.mkv');                                   // no id, no year: a remake for all we know
    expect(normalizeLibraryName(film(), { idConfirmed: true })).toBe(true);
    expect(ls()).toEqual(['Quiet Ember (2015) [imdbid-tt9000005].mkv', 'Quiet Ember.mkv']);
  });

  it('leaves other films alone: another id, another year, a sequel, a longer title', () => {
    put('Quiet Ember (2015) [imdbid-tt9999999].mkv');
    put('Quiet Ember (2007).mkv');
    put('Quiet Ember 2 (2015).mkv');
    put('Quiet Ember Rising (2015).mkv');
    expect(normalizeLibraryName(film(), { idConfirmed: true })).toBe(false);
    expect(ls()).toHaveLength(4);
  });

  it('does nothing when two entries qualify or the new name is taken', () => {
    put('Quiet Ember (2015).mkv'); put('Quiet Ember (2015).mp4');
    expect(normalizeLibraryName(film(), { idConfirmed: true })).toBe(false);
    fs.rmSync(path.join(root, 'Quiet Ember (2015).mp4'));
    put('Quiet Ember (2015) [imdbid-tt9000005].mkv');
    expect(normalizeLibraryName(film(), { idConfirmed: true })).toBe(false);
    expect(ls()).toEqual(['Quiet Ember (2015) [imdbid-tt9000005].mkv', 'Quiet Ember (2015).mkv']);
  });

  it('skips templates only an import can fill', () => {
    mockSettings['rename.movie_file_template'] = '{title} ({year}) {quality}';
    put('Quiet Ember (2015).mkv');
    expect(normalizeLibraryName(film(), { idConfirmed: true })).toBe(false);
  });

  it('moves a show folder to a changed template, never into an existing one', () => {
    fs.mkdirSync(path.join(root, 'Wardline (2017)', 'Season 01'), { recursive: true });
    put('Wardline (2017)/Season 01/Wardline S01E01.mkv');
    expect(normalizeLibraryName(show(), { idConfirmed: true })).toBe(true);
    expect(fs.existsSync(path.join(root, 'Wardline (2017) [imdbid-tt9000006]', 'Season 01', 'Wardline S01E01.mkv'))).toBe(true);

    fs.mkdirSync(path.join(root, 'Wardline'));
    expect(normalizeLibraryName(show(), { idConfirmed: true })).toBe(false);
    expect(fs.existsSync(path.join(root, 'Wardline'))).toBe(true);
  });

  it('renames a year-less show folder under a template without ids, no confirmation needed', () => {
    mockSettings['rename.series_folder_template'] = '{title} ({year})';
    fs.mkdirSync(path.join(root, 'Wardline'));
    fs.mkdirSync(path.join(root, 'Wardline Station (2024)'));
    expect(normalizeLibraryName(show(), { idConfirmed: false })).toBe(true);
    expect(ls()).toEqual(['Wardline (2017)', 'Wardline Station (2024)']);
  });
});
