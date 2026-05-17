import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    addLinks: vi.fn(() => Promise.resolve(true)),
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

import { runHealthMonitor, _resetHealthMonitorState } from '../../src/services/scheduler';
import { sendTelegramSystemAlert } from '../../src/services/telegram';
import db from '../../src/database/index';

// Note: a previous "Scheduler — processMovie" block was kept skipped because
// its mocks no longer matched the current implementation. Removed rather than
// kept dormant — see git history (commit 027d070 area) if reviving is needed.

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
