import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Mutable mock state ─────────────────────────────────────────────────────
const mockSettings: Record<string, string> = {};
let mockMovies: any[] = [];
let mockSeasonsByShow = new Map<number, any[]>();
let mockEpisodesBySeason = new Map<number, any[]>();
const updateEpisodeStatusMock = vi.fn();
const setRepairFlagMock = vi.fn();

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] ?? ''),
  setSetting: vi.fn(),
  initDatabase: vi.fn(),
}));

vi.mock('../../src/database/services/movies', () => ({
  getAllMovies: vi.fn(() => mockMovies),
  getMoviesByStatus: vi.fn(() => []),
  updateMovieStatus: vi.fn(),
  incrementRetryCount: vi.fn(),
  markJdSeen: vi.fn(),
  setRepairFlag: (...args: any[]) => setRepairFlagMock(...args),
}));

vi.mock('../../src/database/services/downloads', () => ({
  getDownloadsByMovieIds: vi.fn(() => new Map()),
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
  updateSeasonStatus: vi.fn(),
}));

vi.mock('../../src/database/services/episodes', () => ({
  getEpisodesBySeasonId: vi.fn((seasonId: number) => mockEpisodesBySeason.get(seasonId) || []),
  updateEpisodeStatus: (...args: any[]) => updateEpisodeStatusMock(...args),
  markEpisodesDownloaded: vi.fn(),
  getSeasonCompletionStatus: vi.fn(() => ({ total: 0, downloaded: 0, allDone: false })),
}));

vi.mock('../../src/jdownloader/index', () => ({
  jdownloaderService: {
    isConfigured: vi.fn(() => false),
    getDownloadPackages: vi.fn(() => Promise.resolve([])),
  },
}));

vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({ isConfigured: () => false, hasMovie: async () => false })),
  getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));

vi.mock('../../src/services/trakt', () => ({
  traktService: { isConfigured: vi.fn(() => false), isAuthenticated: vi.fn(() => false), markAsCollected: vi.fn() },
}));

vi.mock('../../src/services/eventbus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('../../src/services/scheduler', () => ({ processingMovies: new Set<number>() }));

const sendTelegramNotificationMock = vi.fn(() => Promise.resolve());
vi.mock('../../src/services/telegram', () => ({
  sendTelegramNotification: (...args: any[]) => sendTelegramNotificationMock(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Mock the ffprobe util — tests drive the returned audio tags per file via
// `mockAudioTags` (keyed by basename). The real matcher/codes are re-exported
// from the actual module so we test our own logic, not a fake.
const mockAudioTags = new Map<string, string[] | null>();
vi.mock('../../src/utils/ffprobe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/ffprobe')>();
  return {
    ...actual,
    audioLanguageTags: vi.fn((file: string) => {
      const base = file.split('/').pop() || file;
      return Promise.resolve(mockAudioTags.has(base) ? mockAudioTags.get(base)! : []);
    }),
  };
});

import { runIntegrityCheck, runAudioLanguageCheck, _resetAudioProbeMemo } from '../../src/services/integrityCheck';

let tmpRoot: string;
let seriesRoot: string;
let showDir: string;

function writeEp(name: string, kb: number): string {
  const p = path.join(showDir, name);
  fs.writeFileSync(p, Buffer.alloc(kb * 1024));
  return p;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
  mockMovies = [];
  mockSeasonsByShow = new Map();
  mockEpisodesBySeason = new Map();
  mockAudioTags.clear();
  _resetAudioProbeMemo();

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-'));
  seriesRoot = path.join(tmpRoot, 'series');
  showDir = path.join(seriesRoot, 'Threesome');
  fs.mkdirSync(showDir, { recursive: true });

  mockSettings['paths.series'] = seriesRoot;
  // Tiny median floor so KB-sized test files qualify for judging.
  mockSettings['integrity.min_median_mb'] = '0.01';

  mockMovies = [{ id: 1, title: 'Threesome', year: 2024, media_type: 'show', status: 'downloaded', imdb_id: 'tt1' }];
  mockSeasonsByShow.set(1, [{ id: 10, season_number: 2, status: 'downloaded' }]);
  mockEpisodesBySeason.set(10, [
    { id: 101, episode_number: 1, status: 'downloaded' },
    { id: 102, episode_number: 2, status: 'downloaded' },
    { id: 103, episode_number: 3, status: 'downloaded' },
  ]);
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('runIntegrityCheck', () => {
  it('flags a size-outlier episode, quarantines it, resets it to pending, and notifies', () => {
    writeEp('Threesome S02E01.mkv', 300);
    const truncated = writeEp('Threesome S02E02.mkv', 50); // < 50% of the 300KB median
    writeEp('Threesome S02E03.mkv', 300);

    const res = runIntegrityCheck();

    expect(res.flagged).toHaveLength(1);
    expect(res.flagged[0]).toMatchObject({ title: 'Threesome', season: 2, episode: 2 });
    // Original quarantined, replacement slot free for the re-download.
    expect(fs.existsSync(truncated)).toBe(false);
    expect(fs.existsSync(truncated + '.incomplete')).toBe(true);
    // DB episode reset so the scheduler re-downloads it.
    expect(updateEpisodeStatusMock).toHaveBeenCalledWith(102, 'pending');
    // Show flagged "under repair" → queue shows the Reparatur badge.
    expect(setRepairFlagMock).toHaveBeenCalledWith(1, true);
    // User informed.
    expect(sendTelegramNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramNotificationMock.mock.calls[0][0]).toBe('error');
  });

  it('does not flag when every episode is a similar size', () => {
    writeEp('Threesome S02E01.mkv', 300);
    writeEp('Threesome S02E02.mkv', 290);
    writeEp('Threesome S02E03.mkv', 310);

    const res = runIntegrityCheck();

    expect(res.flagged).toHaveLength(0);
    expect(updateEpisodeStatusMock).not.toHaveBeenCalled();
  });

  it('does not flag a small episode when there are too few siblings (no stable median)', () => {
    writeEp('Threesome S02E01.mkv', 300);
    writeEp('Threesome S02E02.mkv', 50); // only 2 episodes → below the 3-sibling floor

    const res = runIntegrityCheck();

    expect(res.flagged).toHaveLength(0);
  });

  it('autoFix:false flags without quarantining or resetting', () => {
    writeEp('Threesome S02E01.mkv', 300);
    const truncated = writeEp('Threesome S02E02.mkv', 50);
    writeEp('Threesome S02E03.mkv', 300);

    const res = runIntegrityCheck({ autoFix: false });

    expect(res.flagged).toHaveLength(1);
    expect(fs.existsSync(truncated)).toBe(true);              // untouched
    expect(fs.existsSync(truncated + '.incomplete')).toBe(false);
    expect(updateEpisodeStatusMock).not.toHaveBeenCalled();
  });

  it('cleans up a stale quarantine once a healthy replacement is present', () => {
    writeEp('Threesome S02E01.mkv', 300);
    writeEp('Threesome S02E02.mkv', 300);          // healthy replacement landed
    writeEp('Threesome S02E03.mkv', 300);
    fs.writeFileSync(path.join(showDir, 'Threesome S02E02.mkv.incomplete'), Buffer.alloc(50 * 1024));

    const res = runIntegrityCheck();

    expect(res.flagged).toHaveLength(0);
    expect(res.cleaned).toBe(1);
    expect(fs.existsSync(path.join(showDir, 'Threesome S02E02.mkv.incomplete'))).toBe(false);
  });

  it('respects integrity.enabled=false (no scan)', () => {
    mockSettings['integrity.enabled'] = 'false';
    writeEp('Threesome S02E01.mkv', 300);
    writeEp('Threesome S02E02.mkv', 50);
    writeEp('Threesome S02E03.mkv', 300);

    const res = runIntegrityCheck();

    expect(res.scannedShows).toBe(0);
    expect(res.flagged).toHaveLength(0);
  });
});

describe('runAudioLanguageCheck', () => {
  beforeEach(() => {
    mockSettings['integrity.verify_language'] = 'true';
    mockSettings['quality.language'] = 'german';
  });

  it('is off by default (opt-in)', async () => {
    delete mockSettings['integrity.verify_language'];
    writeEp('Threesome S02E01.mkv', 300);
    mockAudioTags.set('Threesome S02E01.mkv', ['eng']); // would be a mismatch if scanned

    const res = await runAudioLanguageCheck();

    expect(res.scanned).toBe(0);
    expect(sendTelegramNotificationMock).not.toHaveBeenCalled();
  });

  it('flags a title whose audio tracks carry no german tag (english-only mislabel)', async () => {
    writeEp('Threesome S02E01.mkv', 300);
    writeEp('Threesome S02E02.mkv', 300);
    mockAudioTags.set('Threesome S02E01.mkv', ['eng']);
    mockAudioTags.set('Threesome S02E02.mkv', ['eng', 'fre']);

    const res = await runAudioLanguageCheck();

    expect(res.mismatched).toHaveLength(1);
    expect(res.mismatched[0]).toMatchObject({ movieId: 1, title: 'Threesome' });
    expect(res.mismatched[0].files).toHaveLength(2);
    // Warn-only: one Telegram per title, no quarantine, no episode reset.
    expect(sendTelegramNotificationMock).toHaveBeenCalledTimes(1);
    expect(updateEpisodeStatusMock).not.toHaveBeenCalled();
  });

  it('does NOT flag when a german-tagged track is present (incl. a German DL release)', async () => {
    writeEp('Threesome S02E01.mkv', 300);
    writeEp('Threesome S02E02.mkv', 300);
    // German DL: german + english tracks — the wanted language IS present.
    mockAudioTags.set('Threesome S02E01.mkv', ['ger', 'eng']);
    mockAudioTags.set('Threesome S02E02.mkv', ['deu', 'eng']);

    const res = await runAudioLanguageCheck();

    expect(res.mismatched).toHaveLength(0);
    expect(sendTelegramNotificationMock).not.toHaveBeenCalled();
  });

  it('does NOT flag untagged audio (cannot judge)', async () => {
    writeEp('Threesome S02E01.mkv', 300);
    mockAudioTags.set('Threesome S02E01.mkv', []); // audio present, no language tag

    const res = await runAudioLanguageCheck();

    expect(res.mismatched).toHaveLength(0);
  });

  it('does NOT flag when ffprobe is unavailable (null verdict)', async () => {
    writeEp('Threesome S02E01.mkv', 300);
    mockAudioTags.set('Threesome S02E01.mkv', null); // ffprobe missing / errored

    const res = await runAudioLanguageCheck();

    expect(res.mismatched).toHaveLength(0);
    expect(sendTelegramNotificationMock).not.toHaveBeenCalled();
  });

  it('skips verification entirely when language preference is "any"', async () => {
    mockSettings['quality.language'] = 'any';
    writeEp('Threesome S02E01.mkv', 300);
    mockAudioTags.set('Threesome S02E01.mkv', ['eng']);

    const res = await runAudioLanguageCheck();

    expect(res.scanned).toBe(0);
  });
});
