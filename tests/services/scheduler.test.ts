import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSettings: Record<string, string> = {};

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
  setSetting: vi.fn(),
  initDatabase: vi.fn(),
  default: {
    prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
    transaction: vi.fn((fn: any) => fn),
  },
}));

vi.mock('../../src/database/services/movies', () => ({
  getAllMovies: vi.fn(() => []),
  getMoviesByStatus: vi.fn(() => []),
  // processMovie re-reads the movie inside to avoid stale snapshots; default
  // to echoing the passed-in id so existing tests that pass a makeMovie() get
  // a fresh copy back.
  getMovieById: vi.fn((_id: number) => null),
  updateMovieStatus: vi.fn(),
  updateLastChecked: vi.fn(),
  incrementRetryCount: vi.fn(() => 1),
  resetRetryCount: vi.fn(),
}));

vi.mock('../../src/database/services/downloads', () => ({
  addDownload: vi.fn(),
  getDownloadsByMovieId: vi.fn(() => []),
  getDownloadsByMovieIds: vi.fn(() => new Map()),
  updateDownloadStatusByMovieId: vi.fn(),
}));

vi.mock('../../src/database/services/activityLog', () => ({
  addLogEntry: vi.fn(),
}));

vi.mock('../../src/database/services/seasons', () => ({
  getSeasonsByShowId: vi.fn(() => []),
  getSeasonsByShowIds: vi.fn(() => new Map()),
  addSeason: vi.fn((movieId: number, num: number) => ({ id: 100 + num, movie_id: movieId, season_number: num, status: 'pending' })),
  updateSeasonStatus: vi.fn(),
  updateSeasonLastChecked: vi.fn(),
  updateSeasonEpisodeCount: vi.fn(),
}));

vi.mock('../../src/database/services/episodes', () => ({
  getEpisodesBySeasonId: vi.fn(() => []),
  getPendingEpisodes: vi.fn(() => []),
  addEpisodes: vi.fn(),
  updateEpisodeStatus: vi.fn(),
  markAllEpisodesDownloaded: vi.fn(),
  getSeasonCompletionStatus: vi.fn(() => ({ total: 0, downloaded: 0, allDone: false })),
}));

vi.mock('../../src/services/trakt', () => ({
  traktService: {
    isConfigured: vi.fn(() => false),
    isAuthenticated: vi.fn(() => false),
    syncWatchlist: vi.fn(() => Promise.resolve(0)),
    markAsCollected: vi.fn(() => Promise.resolve(false)),
  },
}));

vi.mock('../../src/services/plex', () => ({
  plexService: {
    isConfigured: vi.fn(() => false),
    syncWatchlist: vi.fn(() => Promise.resolve(0)),
  },
}));

vi.mock('../../src/scraper/constants', () => ({
  QUALITY_RANK: { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 },
}));

vi.mock('../../src/jdownloader/index', () => ({
  jdownloaderService: {
    isConfigured: vi.fn(() => false),
    getDownloadPackages: vi.fn(() => Promise.resolve([])),
    getLinkGrabberPackages: vi.fn(() => Promise.resolve([])),
    addLinks: vi.fn(() => Promise.resolve('sent')),
    connect: vi.fn(() => Promise.resolve(true)),
    getCurrentState: vi.fn(() => Promise.resolve('RUNNING')),
    isUpdateAvailable: vi.fn(() => Promise.resolve(false)),
    runUpdateCheck: vi.fn(() => Promise.resolve(true)),
    startDownloads: vi.fn(() => Promise.resolve(true)),
  },
}));

vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({
    isConfigured: vi.fn(() => false),
    hasMovie: vi.fn(() => Promise.resolve(false)),
    getMovies: vi.fn(() => Promise.resolve([])),
  })),
  getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));

vi.mock('../../src/services/metrics', () => ({
  incrementMetric: vi.fn(),
  setMetric: vi.fn(),
}));

// Default filter: pass everything through, no failures. Tests override per-case.
vi.mock('../../src/scraper/filter', () => ({
  filterReleases: vi.fn((releases: any[]) => releases),
  filterReleasesWithStats: vi.fn((releases: any[]) => ({
    releases,
    stats: { total: releases.length, noLinksFail: 0, qualityFail: 0, audioFail: 0, languageFail: 0, typeFail: 0, dvFail: 0 },
  })),
}));

vi.mock('../../src/plugins/registry', () => ({
  pluginRegistry: {
    forMediaType: vi.fn(() => []),
  },
}));

vi.mock('../../src/database/services/blocklist', () => ({
  isReleaseBlocklisted: vi.fn(() => false),
}));

vi.mock('../../src/services/wikidata', () => ({
  getGermanTitleFromWikidata: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../src/services/libraryReconcile', () => ({
  reconcileEpisodesWithLibrary: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/utils/datetime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/datetime')>();
  return {
    ...actual,
    toSqliteUtc: vi.fn((d: Date) => d.toISOString()),
  };
});


vi.mock('../../src/services/telegram', () => ({
  sendTelegramNotification: vi.fn(),
  sendTelegramSystemAlert: vi.fn(),
}));

vi.mock('../../src/services/eventbus', () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(() => ({ stop: vi.fn() })),
  },
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

import {
  runHealthMonitor,
  _resetHealthMonitorState,
  _resetSyncCaches,
  runJdMonitor,
  _resetJdMonitorState,
  getJdMonitorState,
  notifyJdUpdateTriggered,
  processMovie,
  processingMovies,
  runFullSync,
  startScheduler,
  stopScheduler,
  isSchedulerRunning,
  isSyncRunning,
  checkQualityUpgrades,
} from '../../src/services/scheduler';
import { sendTelegramSystemAlert } from '../../src/services/telegram';
import db from '../../src/database/index';
import { getSetting } from '../../src/database/index';
import * as movies from '../../src/database/services/movies';
import * as downloads from '../../src/database/services/downloads';
import * as seasons from '../../src/database/services/seasons';
import * as episodes from '../../src/database/services/episodes';
import { addLogEntry } from '../../src/database/services/activityLog';
import { pluginRegistry } from '../../src/plugins/registry';
import { filterReleases, filterReleasesWithStats } from '../../src/scraper/filter';
import { isReleaseBlocklisted } from '../../src/database/services/blocklist';
import { jdownloaderService } from '../../src/jdownloader/index';
import { getLibraryProvider } from '../../src/services/libraryProvider';
import { traktService } from '../../src/services/trakt';
import { plexService } from '../../src/services/plex';
import cron from 'node-cron';

// ---- Test data factories ----

function makeMovie(overrides: Partial<any> = {}): any {
  return {
    id: 1,
    title: 'Test Movie',
    year: 2020,
    imdb_id: 'tt123',
    tmdb_id: 555,
    trakt_id: null,
    media_type: 'movie',
    status: 'pending',
    retry_count: 0,
    last_checked_at: null,
    desired_quality: null,
    ...overrides,
  };
}

function makeRelease(overrides: Partial<any> = {}): any {
  return {
    title: 'Test.Movie.2020.1080p.GERMAN',
    quality: '1080p',
    audio: 'DTS',
    language: 'German',
    season: null,
    episode: null,
    isSeasonPack: false,
    links: [{ hoster: 'host-a', url: 'https://host-a.example/file' }],
    ...overrides,
  };
}

/** Make pluginRegistry.forMediaType return a single plugin with a given findReleases result. */
function setSinglePlugin(findResult: { sourceUrl: string | null; releases: any[] }, resolveLinks?: any[]): any {
  const plugin = {
    id: 'test-plugin',
    findReleases: vi.fn(() => Promise.resolve(findResult)),
    // Default: echo the links handed in — mirrors a plugin whose releases
    // already carry direct hoster links (resolveLinks is a no-op for those).
    // Pass an explicit array to simulate container→direct resolution.
    resolveLinks: vi.fn((links: any[]) => Promise.resolve(resolveLinks ?? links)),
  };
  vi.mocked(pluginRegistry.forMediaType).mockReturnValue([plugin] as any);
  return plugin;
}

/** forMediaType returns several plugins, tried in array order (priority). */
function setPlugins(...specs: Array<{ id: string; findResult: any; resolveLinks?: any[] }>): any[] {
  const plugins = specs.map(s => ({
    id: s.id,
    findReleases: vi.fn(() => Promise.resolve(s.findResult)),
    resolveLinks: vi.fn((links: any[]) => Promise.resolve(s.resolveLinks ?? links)),
  }));
  vi.mocked(pluginRegistry.forMediaType).mockReturnValue(plugins as any);
  return plugins;
}

describe('Scheduler — runHealthMonitor', () => {
  // Stub db.prepare(...).all(cutoff) to return whatever counts this test needs.
  const setFailureCounts = (counts: Record<string, number>) => {
    const rows = Object.entries(counts).map(([action, count]) => ({ action, count }));
    vi.mocked(db.prepare).mockReturnValueOnce({
      all: vi.fn(() => rows),
      get: vi.fn(),
      run: vi.fn(),
    } as any);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetHealthMonitorState();
  });

  it('does not alert when failure counts are below thresholds', async () => {
    setFailureCounts({ jdownloader_failed: 2, not_found: 5 });
    await runHealthMonitor();
    expect(sendTelegramSystemAlert).not.toHaveBeenCalled();
  });

  it('alerts on a single threshold breach (degraded)', async () => {
    setFailureCounts({ jdownloader_failed: 7 });
    await runHealthMonitor();
    expect(sendTelegramSystemAlert).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(sendTelegramSystemAlert).mock.calls[0][0];
    expect(msg).toContain('7× jdownloader_failed');
    expect(msg).toContain('⚠️'); // degraded icon
  });

  it('escalates to unhealthy icon when multiple thresholds break', async () => {
    setFailureCounts({ jdownloader_failed: 7, captcha_pending: 10, not_found: 20 });
    await runHealthMonitor();
    expect(sendTelegramSystemAlert).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(sendTelegramSystemAlert).mock.calls[0][0];
    expect(msg).toContain('🚨'); // unhealthy icon
  });

  it('suppresses duplicate alerts within the 1h cooldown', async () => {
    setFailureCounts({ jdownloader_failed: 7 });
    await runHealthMonitor();
    expect(sendTelegramSystemAlert).toHaveBeenCalledTimes(1);

    // Same severity within the cooldown window — should stay silent.
    setFailureCounts({ jdownloader_failed: 8 });
    await runHealthMonitor();
    expect(sendTelegramSystemAlert).toHaveBeenCalledTimes(1);
  });

  it('resets cooldown after the run comes back healthy, then realerts', async () => {
    setFailureCounts({ jdownloader_failed: 7 });
    await runHealthMonitor();
    expect(sendTelegramSystemAlert).toHaveBeenCalledTimes(1);

    // Recovery — below thresholds clears the cooldown state
    setFailureCounts({ jdownloader_failed: 1 });
    await runHealthMonitor();
    expect(sendTelegramSystemAlert).toHaveBeenCalledTimes(1);

    // Regression — should alert again immediately (cooldown cleared on recovery)
    setFailureCounts({ jdownloader_failed: 9 });
    await runHealthMonitor();
    expect(sendTelegramSystemAlert).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// runJdMonitor — update badge, offline alert, post-recovery auto-resume
// ---------------------------------------------------------------------------
describe('Scheduler — runJdMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetJdMonitorState();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);
    vi.mocked(jdownloaderService.connect).mockResolvedValue(true);
    vi.mocked(jdownloaderService.getCurrentState).mockResolvedValue('RUNNING');
    vi.mocked(jdownloaderService.isUpdateAvailable).mockResolvedValue(false);
    vi.mocked(jdownloaderService.runUpdateCheck).mockResolvedValue(true);
    vi.mocked(jdownloaderService.startDownloads).mockResolvedValue(true);
    vi.mocked(jdownloaderService.getDownloadPackages).mockResolvedValue([] as any);
  });

  it('does nothing when JD is not configured', async () => {
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(false);
    await runJdMonitor();
    expect(jdownloaderService.connect).not.toHaveBeenCalled();
  });

  it('detects an available update and exposes it via getJdMonitorState', async () => {
    vi.mocked(jdownloaderService.isUpdateAvailable).mockResolvedValue(true);
    await runJdMonitor();
    expect(jdownloaderService.runUpdateCheck).toHaveBeenCalled(); // first run nudges a fresh check
    expect(getJdMonitorState().updateAvailable).toBe(true);
  });

  it('clears the update badge while JD is unreachable', async () => {
    vi.mocked(jdownloaderService.isUpdateAvailable).mockResolvedValue(true);
    await runJdMonitor();
    expect(getJdMonitorState().updateAvailable).toBe(true);
    vi.mocked(jdownloaderService.connect).mockResolvedValue(false);
    await runJdMonitor();
    expect(getJdMonitorState().updateAvailable).toBe(false);
  });

  it('alerts Telegram once when JD goes offline (cooldown suppresses repeats)', async () => {
    vi.mocked(jdownloaderService.connect).mockResolvedValue(false);
    await runJdMonitor();
    expect(sendTelegramSystemAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTelegramSystemAlert).mock.calls[0][0]).toContain('JDownloader nicht erreichbar');
    // Still offline on the next tick — no repeat alert.
    await runJdMonitor();
    expect(sendTelegramSystemAlert).toHaveBeenCalledTimes(1);
  });

  it('auto-resumes downloads after recovery in a stopped state with a pending queue', async () => {
    // Tick 1: offline.
    vi.mocked(jdownloaderService.connect).mockResolvedValue(false);
    await runJdMonitor();
    // Tick 2: back online, but stopped with an unfinished package.
    vi.mocked(jdownloaderService.connect).mockResolvedValue(true);
    vi.mocked(jdownloaderService.getCurrentState).mockResolvedValue('STOPPED_STATE');
    vi.mocked(jdownloaderService.getDownloadPackages).mockResolvedValue([{ finished: false } as any]);
    await runJdMonitor();
    expect(jdownloaderService.startDownloads).toHaveBeenCalledTimes(1);
    expect(addLogEntry).toHaveBeenCalledWith(null, 'jdownloader_resumed', expect.any(String));
  });

  it('does not auto-resume when JD recovers already running', async () => {
    vi.mocked(jdownloaderService.connect).mockResolvedValue(false);
    await runJdMonitor();
    vi.mocked(jdownloaderService.connect).mockResolvedValue(true);
    vi.mocked(jdownloaderService.getCurrentState).mockResolvedValue('RUNNING');
    vi.mocked(jdownloaderService.getDownloadPackages).mockResolvedValue([{ finished: false } as any]);
    await runJdMonitor();
    expect(jdownloaderService.startDownloads).not.toHaveBeenCalled();
  });

  it('does not fight a deliberate stop during steady-state (no recovery transition)', async () => {
    // JD reachable from the first probe → no offline→online transition.
    vi.mocked(jdownloaderService.getCurrentState).mockResolvedValue('STOPPED_STATE');
    vi.mocked(jdownloaderService.getDownloadPackages).mockResolvedValue([{ finished: false } as any]);
    await runJdMonitor();
    expect(jdownloaderService.startDownloads).not.toHaveBeenCalled();
  });

  it('respects jdownloader.auto_resume=false', async () => {
    mockSettings['jdownloader.auto_resume'] = 'false';
    vi.mocked(jdownloaderService.connect).mockResolvedValue(false);
    await runJdMonitor();
    vi.mocked(jdownloaderService.connect).mockResolvedValue(true);
    vi.mocked(jdownloaderService.getCurrentState).mockResolvedValue('STOPPED_STATE');
    vi.mocked(jdownloaderService.getDownloadPackages).mockResolvedValue([{ finished: false } as any]);
    await runJdMonitor();
    expect(jdownloaderService.startDownloads).not.toHaveBeenCalled();
  });

  it('suppresses the update badge after a user-triggered update despite JD reporting one (stale flag)', async () => {
    // JD's flag lingers true right after restartAndUpdate.
    vi.mocked(jdownloaderService.isUpdateAvailable).mockResolvedValue(true);
    notifyJdUpdateTriggered();
    expect(getJdMonitorState().updateAvailable).toBe(false); // cleared immediately
    await runJdMonitor();
    // Forced a fresh check (jdLastUpdateCheckAt reset to 0) but still suppressed.
    expect(jdownloaderService.runUpdateCheck).toHaveBeenCalled();
    expect(getJdMonitorState().updateAvailable).toBe(false);
  });

  it('forces a fresh update check when JD recovers from being offline', async () => {
    // Steady-state tick within the 6h throttle would normally skip runUpdateCheck.
    await runJdMonitor();
    vi.mocked(jdownloaderService.runUpdateCheck).mockClear();
    // Drop offline, then recover — recovery must force a fresh check.
    vi.mocked(jdownloaderService.connect).mockResolvedValue(false);
    await runJdMonitor();
    vi.mocked(jdownloaderService.connect).mockResolvedValue(true);
    await runJdMonitor();
    expect(jdownloaderService.runUpdateCheck).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processMovie — movie (non-show) paths
// ---------------------------------------------------------------------------
describe('Scheduler — processMovie (movies)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processingMovies.clear();
    _resetSyncCaches();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    // Re-establish defaults that clearAllMocks() wiped to undefined returns.
    vi.mocked(pluginRegistry.forMediaType).mockReturnValue([]);
    vi.mocked(isReleaseBlocklisted).mockReturnValue(false);
    vi.mocked(filterReleasesWithStats).mockImplementation((r: any[]) => ({
      releases: r,
      stats: { total: r.length, noLinksFail: 0, qualityFail: 0, audioFail: 0, languageFail: 0, typeFail: 0, dvFail: 0 },
    }));
    // Loop survivor check defaults to identity; per-test overrides must not leak.
    vi.mocked(filterReleases).mockImplementation((r: any[]) => r);
    vi.mocked(movies.incrementRetryCount).mockReturnValue(1 as any);
    vi.mocked(getLibraryProvider).mockReturnValue({
      isConfigured: () => false,
      hasMovie: () => Promise.resolve(false),
      getMovies: () => Promise.resolve([]),
    } as any);
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(false);
    vi.mocked(jdownloaderService.addLinks).mockResolvedValue('sent' as any);
    // getMovieById echoes a fresh copy by default for these tests
    vi.mocked(movies.getMovieById).mockImplementation(((_id: number) => null) as any);
  });

  it('skips a movie already being processed (in-flight guard)', async () => {
    const m = makeMovie();
    processingMovies.add(m.id);
    await processMovie(m);
    expect(movies.getMovieById).not.toHaveBeenCalled();
  });

  it('aborts if the movie no longer exists in DB', async () => {
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(null as any);
    await processMovie(m);
    expect(pluginRegistry.forMediaType).not.toHaveBeenCalled();
    expect(processingMovies.has(m.id)).toBe(false);
  });

  it('skips a movie already in a terminal status (downloaded)', async () => {
    const m = makeMovie({ status: 'downloaded' });
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    await processMovie(m);
    expect(pluginRegistry.forMediaType).not.toHaveBeenCalled();
    expect(processingMovies.has(m.id)).toBe(false);
  });

  it('skips a movie at max retries', async () => {
    const m = makeMovie({ retry_count: 10 });
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    await processMovie(m);
    expect(pluginRegistry.forMediaType).not.toHaveBeenCalled();
  });

  it('honours exponential backoff and skips before next retry window', async () => {
    // retry_count 1 → 1h backoff. last_checked just now → still inside window.
    const m = makeMovie({ retry_count: 1, last_checked_at: new Date().toISOString() });
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    await processMovie(m);
    expect(pluginRegistry.forMediaType).not.toHaveBeenCalled();
  });

  it('marks downloaded + logs when movie already in media library', async () => {
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    vi.mocked(getLibraryProvider).mockReturnValue({
      isConfigured: () => true,
      hasMovie: () => Promise.resolve(true),
      getMovies: () => Promise.resolve([]),
    } as any);
    await processMovie(m);
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'downloaded');
    expect(addLogEntry).toHaveBeenCalledWith(m.id, 'already_in_library', expect.any(String));
    expect(pluginRegistry.forMediaType).not.toHaveBeenCalled();
  });

  it('skips when a non-dead JDownloader package already exists', async () => {
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);
    vi.mocked(jdownloaderService.getDownloadPackages).mockResolvedValue(
      [{ name: 'Test Movie (2020)', bytesTotal: 1000, childCount: 3 }] as any,
    );
    vi.mocked(jdownloaderService.getLinkGrabberPackages).mockResolvedValue([] as any);
    await processMovie(m);
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'downloading');
    expect(pluginRegistry.forMediaType).not.toHaveBeenCalled();
  });

  it('marks not_found when no source page is found', async () => {
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    setSinglePlugin({ sourceUrl: null, releases: [] });
    await processMovie(m);
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'not_found', undefined, 'not_available');
    expect(movies.incrementRetryCount).toHaveBeenCalledWith(m.id);
    expect(addLogEntry).toHaveBeenCalledWith(m.id, 'not_found', expect.any(String));
  });

  it('marks not_found (quality_mismatch) when releases exist but all filtered out', async () => {
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    setSinglePlugin({ sourceUrl: 'https://src/page', releases: [makeRelease()] });
    vi.mocked(filterReleasesWithStats).mockReturnValue({
      releases: [],
      stats: { total: 1, noLinksFail: 0, qualityFail: 1, audioFail: 0, languageFail: 0, typeFail: 0, dvFail: 0 },
    } as any);
    await processMovie(m);
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'not_found', 'https://src/page', 'quality_mismatch');
    expect(addLogEntry).toHaveBeenCalledWith(m.id, 'quality_mismatch', expect.any(String));
  });

  it('marks not_found (no_hoster) when all releases fail on links', async () => {
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    setSinglePlugin({ sourceUrl: 'https://src/page', releases: [makeRelease({ links: [] })] });
    vi.mocked(filterReleasesWithStats).mockReturnValue({
      releases: [],
      stats: { total: 1, noLinksFail: 1, qualityFail: 0, audioFail: 0, languageFail: 0, typeFail: 0, dvFail: 0 },
    } as any);
    await processMovie(m);
    expect(addLogEntry).toHaveBeenCalledWith(m.id, 'no_hoster', expect.any(String));
  });

  it('drops blocklisted releases (treated as no match)', async () => {
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    setSinglePlugin({ sourceUrl: 'https://src/page', releases: [makeRelease()] });
    vi.mocked(isReleaseBlocklisted).mockReturnValue(true);
    await processMovie(m);
    // Everything blocklisted → filtered list empty → not_found with url
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'not_found', 'https://src/page', 'quality_mismatch');
  });

  it('sets pending/captcha when release found but links unresolved', async () => {
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    setSinglePlugin({ sourceUrl: 'https://src/page', releases: [makeRelease({ links: [] })] });
    // filter passes the link-less release through
    await processMovie(m);
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'pending', 'https://src/page');
    expect(addLogEntry).toHaveBeenCalledWith(m.id, 'captcha_pending', expect.any(String));
  });

  it('happy path: found release → status found → sent to JDownloader', async () => {
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    setSinglePlugin({ sourceUrl: 'https://src/page', releases: [makeRelease()] });
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);
    vi.mocked(jdownloaderService.getDownloadPackages).mockResolvedValue([] as any);
    vi.mocked(jdownloaderService.getLinkGrabberPackages).mockResolvedValue([] as any);
    vi.mocked(jdownloaderService.addLinks).mockResolvedValue('sent' as any);

    await processMovie(m);

    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'found', 'https://src/page');
    expect(movies.resetRetryCount).toHaveBeenCalledWith(m.id);
    expect(downloads.addDownload).toHaveBeenCalled();
    expect(jdownloaderService.addLinks).toHaveBeenCalled();
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'downloading');
    expect(downloads.updateDownloadStatusByMovieId).toHaveBeenCalledWith(m.id, 'sent_to_jd');
    expect(processingMovies.has(m.id)).toBe(false);
  });

  it('falls through to the next plugin when the first returns only filtered-out releases', async () => {
    // Reproduces the "Example Movie" bug: source A returns a single junk
    // release (complete disc / below quality floor) that fails the filter,
    // while source-b has the wanted release. The junk plugin must NOT pre-empt.
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    const junk = makeRelease({ title: 'X.COMPLETE', quality: 'unknown', releaseType: 'complete' });
    const good = makeRelease({ title: 'X.1080p.German', quality: '1080p' });
    const [p1, p2] = setPlugins(
      { id: 'source-a', findResult: { sourceUrl: 'https://a/page', releases: [junk] } },
      { id: 'source-b', findResult: { sourceUrl: 'https://b/page', releases: [good] } },
    );
    // Loop survivor check filters out the junk release but keeps the good one.
    vi.mocked(filterReleases).mockImplementation((releases: any[]) =>
      releases.filter(r => r.quality !== 'unknown' && r.releaseType !== 'complete'));

    await processMovie(m);

    expect(p1.findReleases).toHaveBeenCalled();
    expect(p2.findReleases).toHaveBeenCalled();
    // Won via source-b → source page is source-b', not the pre-empting source A page.
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'found', 'https://b/page');
    // Only the winning plugin's release is resolved (no captcha spent on junk).
    expect(p1.resolveLinks).not.toHaveBeenCalled();
    expect(p2.resolveLinks).toHaveBeenCalled();
  });

  it('marks not_found when every plugin returns only filtered-out releases', async () => {
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    const junk = makeRelease({ title: 'X.COMPLETE', quality: 'unknown', releaseType: 'complete' });
    setPlugins(
      { id: 'source-a', findResult: { sourceUrl: 'https://a/page', releases: [junk] } },
      { id: 'source-b', findResult: { sourceUrl: 'https://b/page', releases: [junk] } },
    );
    vi.mocked(filterReleases).mockImplementation(() => []); // nothing survives anywhere
    // The post-loop stats filter also rejects the fallback release set.
    vi.mocked(filterReleasesWithStats).mockReturnValue({
      releases: [],
      stats: { total: 1, noLinksFail: 0, qualityFail: 1, audioFail: 0, languageFail: 0, typeFail: 1, dvFail: 0 },
    } as any);

    await processMovie(m);
    // Fallback source link is retained for the UI; status is not_found.
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'not_found', 'https://a/page', 'quality_mismatch');
    expect(addLogEntry).toHaveBeenCalledWith(m.id, 'quality_mismatch', expect.any(String));
  });

  it('resolves container links on demand after filtering (movie path)', async () => {
    // Plugin returns an unresolved container link; resolveLinks turns it into a
    // direct hoster URL. The scheduler must use the *resolved* URL, never the
    // raw container.
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    const release = makeRelease({ links: [{ hoster: 'host-a', url: 'https://container.example/c/abc.html' }] });
    const plugin = setSinglePlugin(
      { sourceUrl: 'https://src/page', releases: [release] },
      [{ hoster: 'host-a', url: 'https://host-a.example/direct/file' }], // resolveLinks output
    );
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);
    vi.mocked(jdownloaderService.getDownloadPackages).mockResolvedValue([] as any);
    vi.mocked(jdownloaderService.getLinkGrabberPackages).mockResolvedValue([] as any);
    vi.mocked(jdownloaderService.addLinks).mockResolvedValue('sent' as any);

    await processMovie(m);

    expect(plugin.resolveLinks).toHaveBeenCalledWith([{ hoster: 'host-a', url: 'https://container.example/c/abc.html' }]);
    expect(jdownloaderService.addLinks).toHaveBeenCalledWith(['https://host-a.example/direct/file'], expect.any(String));
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'found', 'https://src/page');
  });

  it('sets pending when on-demand resolution yields no links', async () => {
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    const release = makeRelease({ links: [{ hoster: 'host-a', url: 'https://container.example/c/abc.html' }] });
    setSinglePlugin({ sourceUrl: 'https://src/page', releases: [release] }, []); // resolveLinks fails → []

    await processMovie(m);
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'pending', 'https://src/page');
    expect(addLogEntry).toHaveBeenCalledWith(m.id, 'captcha_pending', expect.any(String));
  });

  it('logs jdownloader_error when addLinks fails', async () => {
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    setSinglePlugin({ sourceUrl: 'https://src/page', releases: [makeRelease()] });
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);
    vi.mocked(jdownloaderService.getDownloadPackages).mockResolvedValue([] as any);
    vi.mocked(jdownloaderService.getLinkGrabberPackages).mockResolvedValue([] as any);
    vi.mocked(jdownloaderService.addLinks).mockResolvedValue('error' as any);

    await processMovie(m);
    expect(addLogEntry).toHaveBeenCalledWith(m.id, 'jdownloader_error', expect.any(String));
  });

  it('respects enabled-hosters filter (no enabled hoster → no links → pending)', async () => {
    const m = makeMovie();
    mockSettings['hosters.enabled'] = 'host-b'; // release only has host-a
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    setSinglePlugin({ sourceUrl: 'https://src/page', releases: [makeRelease()] });
    await processMovie(m);
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'pending', 'https://src/page');
  });

  it('on a thrown error resets to pending and logs', async () => {
    const m = makeMovie();
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    const plugin = setSinglePlugin({ sourceUrl: 'https://src/page', releases: [makeRelease()] });
    // Make filter throw to hit the catch block (after status flip to searching)
    vi.mocked(filterReleasesWithStats).mockImplementation(() => { throw new Error('boom'); });
    await processMovie(m);
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(m.id, 'pending');
    expect(addLogEntry).toHaveBeenCalledWith(m.id, 'error', 'boom');
    expect(processingMovies.has(m.id)).toBe(false);
    void plugin;
  });
});

// ---------------------------------------------------------------------------
// processMovie — show / season paths
// ---------------------------------------------------------------------------
describe('Scheduler — processMovie (shows)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processingMovies.clear();
    _resetSyncCaches();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    vi.mocked(pluginRegistry.forMediaType).mockReturnValue([]);
    vi.mocked(isReleaseBlocklisted).mockReturnValue(false);
    vi.mocked(filterReleasesWithStats).mockImplementation((r: any[]) => ({
      releases: r,
      stats: { total: r.length, noLinksFail: 0, qualityFail: 0, audioFail: 0, languageFail: 0, typeFail: 0, dvFail: 0 },
    }));
    // Loop survivor check defaults to identity; per-test overrides must not leak.
    vi.mocked(filterReleases).mockImplementation((r: any[]) => r);
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(false);
    vi.mocked(jdownloaderService.addLinks).mockResolvedValue('sent' as any);
    vi.mocked(getLibraryProvider).mockReturnValue({
      isConfigured: () => false,
      hasMovie: () => Promise.resolve(false),
      getMovies: () => Promise.resolve([]),
    } as any);
    vi.mocked(seasons.getSeasonsByShowId).mockReturnValue([]);
    vi.mocked(episodes.getPendingEpisodes).mockReturnValue([]);
    vi.mocked(episodes.getSeasonCompletionStatus).mockReturnValue({ total: 0, downloaded: 0, allDone: false } as any);
  });

  it('auto-discovers a new season pack and sends it to JDownloader', async () => {
    const show = makeMovie({ media_type: 'show', status: 'pending', trakt_id: null });
    vi.mocked(movies.getMovieById).mockReturnValue(show as any);
    const pack = makeRelease({ season: 1, episode: null, isSeasonPack: true, title: 'Show.S01.1080p' });
    setSinglePlugin({ sourceUrl: 'https://show/page', releases: [pack] });

    // No seasons known initially; after addSeason, getSeasonsByShowId returns S1 pending
    const s1 = { id: 101, movie_id: show.id, season_number: 1, status: 'pending', last_checked_at: null };
    vi.mocked(seasons.getSeasonsByShowId)
      .mockReturnValueOnce([])               // initial existing-number check
      .mockReturnValue([s1] as any);          // after auto-add + aggregate
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);
    vi.mocked(jdownloaderService.addLinks).mockResolvedValue('sent' as any);

    await processMovie(show);

    expect(seasons.addSeason).toHaveBeenCalledWith(show.id, 1, expect.any(String));
    // tryDownloadRelease → found then downloading
    expect(seasons.updateSeasonStatus).toHaveBeenCalledWith(s1.id, 'found', 'https://show/page');
    expect(jdownloaderService.addLinks).toHaveBeenCalled();
  });

  it('season pack: resolves unresolved container/redirect links via the plugin before sending to JD', async () => {
    // Regression: the season-pack path used to send the plugin's UNRESOLVED
    // redirect URLs straight to JDownloader, which then resolved them
    // itself and landed on a dead mirror. It must resolve via the
    // plugin first (like the episode path) and send the resolved direct links.
    const show = makeMovie({ media_type: 'show', status: 'pending', trakt_id: null });
    vi.mocked(movies.getMovieById).mockReturnValue(show as any);
    const pack = makeRelease({
      season: 1, episode: null, isSeasonPack: true, title: 'Show.S01.1080p',
      links: [{ hoster: 'host-a', url: 'https://source-c.org/redirect/2/abc' }],
    });
    const plugin = setSinglePlugin(
      { sourceUrl: 'https://show/page', releases: [pack] },
      [{ hoster: 'host-a', url: 'https://host-a.example/direct/file' }], // resolveLinks output (live mirror)
    );
    const s1 = { id: 101, movie_id: show.id, season_number: 1, status: 'pending', last_checked_at: null };
    vi.mocked(seasons.getSeasonsByShowId).mockReturnValueOnce([]).mockReturnValue([s1] as any);
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);
    vi.mocked(jdownloaderService.addLinks).mockResolvedValue('sent' as any);

    await processMovie(show);

    // The raw redirect URL goes to the plugin, the resolved direct URL goes to JD.
    expect(plugin.resolveLinks).toHaveBeenCalledWith([{ hoster: 'host-a', url: 'https://source-c.org/redirect/2/abc' }]);
    expect(jdownloaderService.addLinks).toHaveBeenCalledWith(['https://host-a.example/direct/file'], expect.any(String));
  });

  it('marks show downloaded when all seasons already downloaded and none pending', async () => {
    const show = makeMovie({ media_type: 'show', status: 'downloaded', trakt_id: null });
    vi.mocked(movies.getMovieById).mockReturnValue(show as any);
    // A pack release exists for the already-downloaded S1 — needed so processMovie
    // reaches processShowSeasons (an empty filtered list short-circuits to not_found).
    const pack = makeRelease({ season: 1, episode: null, isSeasonPack: true, title: 'Show.S01.1080p' });
    setSinglePlugin({ sourceUrl: 'https://show/page', releases: [pack] });
    const s1 = { id: 101, movie_id: show.id, season_number: 1, status: 'downloaded', last_checked_at: null };
    vi.mocked(seasons.getSeasonsByShowId).mockReturnValue([s1] as any);
    vi.mocked(episodes.getPendingEpisodes).mockReturnValue([]); // no new episodes → no reopen

    await processMovie(show);

    expect(movies.updateMovieStatus).toHaveBeenCalledWith(show.id, 'downloaded', 'https://show/page');
  });

  it('falls back to per-episode downloads when no season pack', async () => {
    const show = makeMovie({ media_type: 'show', status: 'pending', trakt_id: null });
    vi.mocked(movies.getMovieById).mockReturnValue(show as any);
    const ep = makeRelease({ season: 1, episode: 1, isSeasonPack: false, title: 'Show.S01E01.1080p' });
    setSinglePlugin({ sourceUrl: 'https://show/page', releases: [ep] });

    const s1 = { id: 101, movie_id: show.id, season_number: 1, status: 'pending', last_checked_at: null };
    vi.mocked(seasons.getSeasonsByShowId)
      .mockReturnValueOnce([s1] as any)  // initial — already exists
      .mockReturnValue([s1] as any);
    vi.mocked(episodes.getPendingEpisodes).mockReturnValue([{ id: 5001, season_id: 101, episode_number: 1 }] as any);
    vi.mocked(episodes.getSeasonCompletionStatus).mockReturnValue({ total: 1, downloaded: 1, allDone: true } as any);

    await processMovie(show);

    expect(episodes.updateEpisodeStatus).toHaveBeenCalledWith(5001, 'downloading', ep.title);
    expect(downloads.addDownload).toHaveBeenCalled();
  });

  it('reverts an episode to pending when JDownloader send fails (no soft orphan)', async () => {
    // saveEpisode tx flips the episode to 'downloading' BEFORE addLinks. If addLinks
    // returns false the episode would otherwise sit in 'downloading' forever:
    // getPendingEpisodes only sees 'pending', so nothing else picks it up.
    const show = makeMovie({ media_type: 'show', status: 'pending', trakt_id: null });
    vi.mocked(movies.getMovieById).mockReturnValue(show as any);
    const ep = makeRelease({ season: 1, episode: 1, isSeasonPack: false, title: 'Show.S01E01.1080p' });
    setSinglePlugin({ sourceUrl: 'https://show/page', releases: [ep] });

    const s1 = { id: 101, movie_id: show.id, season_number: 1, status: 'pending', last_checked_at: null };
    vi.mocked(seasons.getSeasonsByShowId)
      .mockReturnValueOnce([s1] as any)
      .mockReturnValue([s1] as any);
    vi.mocked(episodes.getPendingEpisodes).mockReturnValue([{ id: 5001, season_id: 101, episode_number: 1 }] as any);
    vi.mocked(episodes.getSeasonCompletionStatus).mockReturnValue({ total: 1, downloaded: 0, allDone: false } as any);
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);
    vi.mocked(jdownloaderService.addLinks).mockResolvedValue('error' as any);

    await processMovie(show);

    // First the tx sets 'downloading'; then on JD failure we revert to 'pending'.
    expect(episodes.updateEpisodeStatus).toHaveBeenCalledWith(5001, 'downloading', ep.title);
    expect(episodes.updateEpisodeStatus).toHaveBeenCalledWith(5001, 'pending');
  });

  it('re-fills a partially-downloading season without re-sending in-flight episodes', async () => {
    // S1 is 'downloading' (E01 already sent), E02 still pending because its links
    // didn't resolve earlier. The season must be re-processed, E02 sent, and the
    // season-pack step skipped — and E01 must NOT be re-sent.
    const show = makeMovie({ media_type: 'show', status: 'downloading', trakt_id: null });
    vi.mocked(movies.getMovieById).mockReturnValue(show as any);
    const e1 = makeRelease({ season: 1, episode: 1, isSeasonPack: false, title: 'Show.S01E01.1080p',
      links: [{ hoster: 'host-a', url: 'https://host-a.example/e1' }] });
    const e2 = makeRelease({ season: 1, episode: 2, isSeasonPack: false, title: 'Show.S01E02.1080p',
      links: [{ hoster: 'host-a', url: 'https://host-a.example/e2' }] });
    setSinglePlugin({ sourceUrl: 'https://show/page', releases: [e1, e2] });

    const s1 = { id: 101, movie_id: show.id, season_number: 1, status: 'downloading', last_checked_at: null };
    vi.mocked(seasons.getSeasonsByShowId).mockReturnValue([s1] as any);
    // getPendingEpisodes now returns only genuinely-'pending' rows → just E02.
    vi.mocked(episodes.getPendingEpisodes).mockReturnValue([{ id: 5002, season_id: 101, episode_number: 2 }] as any);
    vi.mocked(episodes.getSeasonCompletionStatus).mockReturnValue({ total: 2, downloaded: 1, allDone: false } as any);
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);

    await processMovie(show);

    // Only E02 was sent
    expect(episodes.updateEpisodeStatus).toHaveBeenCalledWith(5002, 'downloading', e2.title);
    expect(episodes.updateEpisodeStatus).not.toHaveBeenCalledWith(5001, expect.anything(), expect.anything());
    const sentPackages = vi.mocked(jdownloaderService.addLinks).mock.calls.map(c => c[1]);
    expect(sentPackages.some(p => /S01E02/.test(p))).toBe(true);
    expect(sentPackages.some(p => /S01E01/.test(p))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkQualityUpgrades
// ---------------------------------------------------------------------------
describe('Scheduler — checkQualityUpgrades', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    mockSettings['quality.auto_upgrade'] = 'true';
    mockSettings['quality.cutoff'] = '2160p';
    vi.mocked(pluginRegistry.forMediaType).mockReturnValue([]);
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);
    vi.mocked(jdownloaderService.addLinks).mockResolvedValue('sent' as any);
    vi.mocked(filterReleases).mockImplementation((r: any[]) => r);
  });

  it('skips shows entirely — never searches or sends an upgrade for a series', async () => {
    const show = makeMovie({ media_type: 'show', status: 'downloaded' });
    vi.mocked(movies.getMoviesByStatus).mockReturnValue([show] as any);
    vi.mocked(downloads.getDownloadsByMovieIds).mockReturnValue(
      new Map([[show.id, [{ quality: '1080p', release_name: 'Show.S01.1080p' }]]]) as any,
    );

    await checkQualityUpgrades();

    // A show is tracked per season/episode — no movie-style upgrade flow runs.
    expect(pluginRegistry.forMediaType).not.toHaveBeenCalled();
    expect(jdownloaderService.addLinks).not.toHaveBeenCalled();
  });

  it('still upgrades a movie that is below the cutoff', async () => {
    const movie = makeMovie({ media_type: 'movie', status: 'downloaded' });
    vi.mocked(movies.getMoviesByStatus).mockReturnValue([movie] as any);
    vi.mocked(downloads.getDownloadsByMovieIds).mockReturnValue(
      new Map([[movie.id, [{ quality: '1080p', release_name: 'Test.Movie.2020.1080p' }]]]) as any,
    );
    const better = makeRelease({ quality: '2160p', title: 'Test.Movie.2020.2160p',
      links: [{ hoster: 'host-a', url: 'https://host-a.example/4k' }] });
    setSinglePlugin({ sourceUrl: 'https://m/page', releases: [better] });

    await checkQualityUpgrades();

    expect(pluginRegistry.forMediaType).toHaveBeenCalledWith('movie');
    expect(jdownloaderService.addLinks).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runFullSync
// ---------------------------------------------------------------------------
describe('Scheduler — runFullSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processingMovies.clear();
    _resetSyncCaches();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    vi.mocked(pluginRegistry.forMediaType).mockReturnValue([]);
    vi.mocked(filterReleases).mockImplementation((r: any[]) => r);
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(false);
    vi.mocked(traktService.isConfigured).mockReturnValue(false);
    vi.mocked(plexService.isConfigured).mockReturnValue(false);
    vi.mocked(movies.getAllMovies).mockReturnValue([]);
    vi.mocked(movies.getMoviesByStatus).mockReturnValue([]);
  });

  it('runs an empty sync and returns zero counts', async () => {
    const result = await runFullSync();
    expect(result).toEqual({ synced: 0, processed: 0 });
    expect(addLogEntry).toHaveBeenCalledWith(null, 'sync_started', expect.any(String));
    expect(addLogEntry).toHaveBeenCalledWith(null, 'sync_completed', expect.any(String));
    expect(isSyncRunning()).toBe(false);
  });

  it('syncs from Trakt when configured and processes pending movies', async () => {
    vi.mocked(traktService.isConfigured).mockReturnValue(true);
    vi.mocked(traktService.syncWatchlist).mockResolvedValue(2 as any);
    const m = makeMovie({ id: 7, status: 'pending' });
    vi.mocked(movies.getAllMovies).mockReturnValue([m] as any);
    vi.mocked(movies.getMovieById).mockReturnValue(m as any);
    // No source page → not_found, but counts as processed
    setSinglePlugin({ sourceUrl: null, releases: [] });

    const result = await runFullSync();
    expect(result.synced).toBe(2);
    expect(result.processed).toBe(1);
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(7, 'not_found', undefined, 'not_available');
  });

  it('skips when a sync is already running (re-entrancy guard)', async () => {
    vi.mocked(traktService.isConfigured).mockReturnValue(true);
    // Make the watchlist sync hang until we release it so the first call holds isRunning.
    let release!: () => void;
    const gate = new Promise<number>((res) => { release = () => res(0); });
    vi.mocked(traktService.syncWatchlist).mockReturnValue(gate as any);

    const first = runFullSync();
    const second = await runFullSync(); // should bail immediately
    expect(second).toEqual({ synced: 0, processed: 0 });

    release();
    await first;
    expect(isSyncRunning()).toBe(false);
  });

  it('retries JDownloader sends for movies stuck in "found" status', async () => {
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);
    const foundMovie = makeMovie({ id: 3, status: 'found' });
    // getAllMovies has none to process; getMoviesByStatus('found') returns our movie
    vi.mocked(movies.getAllMovies).mockReturnValue([]);
    vi.mocked(movies.getMoviesByStatus).mockImplementation(((status: string) =>
      status === 'found' ? [foundMovie] : []) as any);
    vi.mocked(downloads.getDownloadsByMovieIds).mockReturnValue(
      new Map([[3, [{ download_url: 'https://rg/file', quality: '1080p' }]]]) as any,
    );
    vi.mocked(jdownloaderService.addLinks).mockResolvedValue('sent' as any);

    await runFullSync();

    expect(jdownloaderService.addLinks).toHaveBeenCalledWith(['https://rg/file'], expect.stringContaining('Test Movie'));
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(3, 'downloading');
    expect(downloads.updateDownloadStatusByMovieId).toHaveBeenCalledWith(3, 'sent_to_jd');
  });

  it('does NOT send a SHOW via the movie-format retry path (FROM/Threesome duplicate bug)', async () => {
    // A show carries movie-level status 'found' whenever a season is 'found'.
    // The movie retry loop must NOT pick it up — doing so lumped every season's
    // links into one movie-format package ("Title (Year) - quality") on top of
    // the per-season packages, landing the show in JD 2–3×. Shows are handled
    // solely by the per-season loop. getAllMovies() is empty here, so the season
    // loop has nothing to send — proving the movie loop no longer touches shows.
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);
    const foundShow = makeMovie({ id: 8, media_type: 'show', status: 'found', title: 'FROM' });
    vi.mocked(movies.getAllMovies).mockReturnValue([]);
    vi.mocked(movies.getMoviesByStatus).mockImplementation(((status: string) =>
      status === 'found' ? [foundShow] : []) as any);
    vi.mocked(downloads.getDownloadsByMovieIds).mockReturnValue(
      new Map([[8, [{ download_url: 'https://rg/s1', quality: '2160p', season_number: 1 }]]]) as any,
    );
    vi.mocked(jdownloaderService.addLinks).mockResolvedValue('sent' as any);

    await runFullSync();

    expect(jdownloaderService.addLinks).not.toHaveBeenCalled();
    // The whole show must not be flipped to 'downloading' by the movie path.
    expect(movies.updateMovieStatus).not.toHaveBeenCalledWith(8, 'downloading');
  });

  it('checks quality upgrades and sends a higher-quality release to JDownloader', async () => {
    mockSettings['quality.auto_upgrade'] = 'true';
    mockSettings['quality.cutoff'] = '2160p';
    vi.mocked(jdownloaderService.isConfigured).mockReturnValue(true);
    vi.mocked(jdownloaderService.addLinks).mockResolvedValue('sent' as any);

    const dledMovie = makeMovie({ id: 4, status: 'downloaded' });
    vi.mocked(movies.getAllMovies).mockReturnValue([]);
    vi.mocked(movies.getMoviesByStatus).mockImplementation(((status: string) =>
      status === 'downloaded' ? [dledMovie] : []) as any);
    // current download is 1080p
    vi.mocked(downloads.getDownloadsByMovieIds).mockReturnValue(
      new Map([[4, [{ download_url: 'old', quality: '1080p' }]]]) as any,
    );
    // plugin offers a 2160p release
    setSinglePlugin({ sourceUrl: 'https://src', releases: [makeRelease({ quality: '2160p', title: 'Test.2160p' })] });

    await runFullSync();

    expect(addLogEntry).toHaveBeenCalledWith(4, 'quality_upgrade', expect.stringContaining('2160p'));
    expect(jdownloaderService.addLinks).toHaveBeenCalledWith(expect.any(Array), expect.stringContaining('[UPGRADE]'));
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(4, 'downloading');
  });

  it('skips quality upgrades when auto_upgrade is off', async () => {
    mockSettings['quality.auto_upgrade'] = 'false';
    const dledMovie = makeMovie({ id: 5, status: 'downloaded' });
    vi.mocked(movies.getAllMovies).mockReturnValue([]);
    vi.mocked(movies.getMoviesByStatus).mockImplementation(((status: string) =>
      status === 'downloaded' ? [dledMovie] : []) as any);

    await runFullSync();
    // forMediaType is the upgrade search entry point — never reached when disabled
    expect(pluginRegistry.forMediaType).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scheduler lifecycle: start / stop / status
// ---------------------------------------------------------------------------
describe('Scheduler — start/stop/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    vi.mocked(cron.schedule).mockReturnValue({ stop: vi.fn() } as any);
    vi.mocked(movies.getMoviesByStatus).mockReturnValue([]);
  });

  afterEach(() => {
    stopScheduler();
  });

  it('reports not running before start', () => {
    stopScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });

  it('starts cron jobs and reports running', () => {
    startScheduler();
    expect(cron.schedule).toHaveBeenCalled();
    expect(isSchedulerRunning()).toBe(true);
  });

  it('resets movies stuck in "searching" to pending on start', () => {
    vi.mocked(movies.getMoviesByStatus).mockReturnValue([makeMovie({ id: 9, status: 'searching' })] as any);
    startScheduler();
    expect(movies.getMoviesByStatus).toHaveBeenCalledWith('searching');
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(9, 'pending');
  });

  it('does not schedule the sync cron when disabled', () => {
    mockSettings['scheduler.enabled'] = 'false';
    startScheduler();
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(isSchedulerRunning()).toBe(false);
  });

  it('skips the health monitor cron when opted out', () => {
    mockSettings['scheduler.health_monitor_enabled'] = 'false';
    startScheduler();
    // Full-sync + JD monitor crons schedule; the health-monitor (*/15) is skipped.
    const exprs = vi.mocked(cron.schedule).mock.calls.map(c => c[0]);
    expect(exprs).not.toContain('*/15 * * * *');
    expect(exprs).toContain('*/5 * * * *'); // JD monitor still runs
  });

  it('uses an hourly cron expression for sub-daily intervals', () => {
    mockSettings['scheduler.interval_hours'] = '6';
    startScheduler();
    expect(cron.schedule).toHaveBeenCalledWith('0 */6 * * *', expect.any(Function));
  });

  it('stop clears the scheduler so status reports not running', () => {
    startScheduler();
    expect(isSchedulerRunning()).toBe(true);
    stopScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Watchlist monitor (startup timer → safeCheckForNewMovies → checkForNewMovies)
// ---------------------------------------------------------------------------
describe('Scheduler — watchlist monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processingMovies.clear();
    _resetSyncCaches();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    vi.useFakeTimers();
    vi.mocked(cron.schedule).mockReturnValue({ stop: vi.fn() } as any);
    vi.mocked(movies.getMoviesByStatus).mockReturnValue([]);
    vi.mocked(pluginRegistry.forMediaType).mockReturnValue([]);
  });

  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
  });

  it('processes pending movies when the startup poll finds new entries', async () => {
    // Trakt configured + authenticated so the monitor has a provider.
    vi.mocked(traktService.isConfigured).mockReturnValue(true);
    vi.mocked(traktService.isAuthenticated).mockReturnValue(true);
    vi.mocked(traktService.syncWatchlist).mockResolvedValue(1 as any);
    const pending = makeMovie({ id: 11, status: 'pending' });
    vi.mocked(movies.getMoviesByStatus).mockImplementation(((status: string) =>
      status === 'pending' ? [pending] : []) as any);
    vi.mocked(movies.getMovieById).mockReturnValue(pending as any);
    setSinglePlugin({ sourceUrl: null, releases: [] }); // → not_found, processed

    startScheduler();
    // Fire the 10s startup timer, then let the async chain settle.
    await vi.advanceTimersByTimeAsync(11_000);

    expect(traktService.syncWatchlist).toHaveBeenCalled();
    expect(movies.updateMovieStatus).toHaveBeenCalledWith(11, 'not_found', undefined, 'not_available');
  });

  it('does nothing when no watchlist provider is configured', async () => {
    vi.mocked(traktService.isConfigured).mockReturnValue(false);
    vi.mocked(plexService.isConfigured).mockReturnValue(false);

    startScheduler();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(traktService.syncWatchlist).not.toHaveBeenCalled();
  });
});
