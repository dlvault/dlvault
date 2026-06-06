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

const checkedFiles = new Map<string, number>();
vi.mock('../../src/database/services/fileChecks', () => ({
  loadCheckedFiles: () => new Map(checkedFiles),
  markFileChecked: (p: string, size: number) => { checkedFiles.set(p, size); },
  pruneCheckedFiles: () => 0,
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

import { runIntegrityCheck, runAudioLanguageCheck, _resetAudioProbeMemo, runTruncationCheck, _resetTruncationMemo } from '../../src/services/integrityCheck';
import { updateMovieStatus } from '../../src/database/services/movies';

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
  showDir = path.join(seriesRoot, 'Lanternfall');
  fs.mkdirSync(showDir, { recursive: true });

  mockSettings['paths.series'] = seriesRoot;
  // Tiny median floor so KB-sized test files qualify for judging.
  mockSettings['integrity.min_median_mb'] = '0.01';

  mockMovies = [{ id: 1, title: 'Lanternfall', year: 2024, media_type: 'show', status: 'downloaded', imdb_id: 'tt1' }];
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
  it('leaves a mixed-quality season alone instead of quarantining the smaller rips', () => {
    // S02E01-E03 are old 720p rips, E04-E07 are 1080p. The median lands among the
    // big files, so a pure "below the median" rule flagged all three small ones,
    // renamed them to .incomplete (invisible to Plex/Jellyfin) and queued
    // re-downloads. Three of seven is a quality split, not truncation damage.
    mockEpisodesBySeason.set(10, [1, 2, 3, 4, 5, 6, 7].map(n => ({ id: 100 + n, episode_number: n, status: 'downloaded' })));
    writeEp('Lanternfall S02E01.mkv', 70);
    writeEp('Lanternfall S02E02.mkv', 70);
    writeEp('Lanternfall S02E03.mkv', 70);
    writeEp('Lanternfall S02E04.mkv', 220);
    writeEp('Lanternfall S02E05.mkv', 220);
    writeEp('Lanternfall S02E06.mkv', 220);
    writeEp('Lanternfall S02E07.mkv', 220);

    const res = runIntegrityCheck();

    expect(res.flagged).toHaveLength(0);
    expect(fs.existsSync(path.join(showDir, 'Lanternfall S02E01.mkv'))).toBe(true);
    expect(fs.existsSync(path.join(showDir, 'Lanternfall S02E01.mkv.incomplete'))).toBe(false);
  });

  it('still flags a lone truncated file among uniform siblings', () => {
    // The minority case the check exists for: one file far below six healthy ones.
    mockEpisodesBySeason.set(10, [1, 2, 3, 4, 5, 6, 7].map(n => ({ id: 100 + n, episode_number: n, status: 'downloaded' })));
    for (const n of [1, 2, 3, 4, 5, 6]) writeEp(`Lanternfall S02E0${n}.mkv`, 300);
    const truncated = writeEp('Lanternfall S02E07.mkv', 40);

    const res = runIntegrityCheck();

    expect(res.flagged).toHaveLength(1);
    expect(res.flagged[0]).toMatchObject({ season: 2, episode: 7 });
    expect(fs.existsSync(truncated + '.incomplete')).toBe(true);
  });

  it('flags a size-outlier episode, quarantines it, resets it to pending, and notifies', () => {
    writeEp('Lanternfall S02E01.mkv', 300);
    const truncated = writeEp('Lanternfall S02E02.mkv', 50); // < 50% of the 300KB median
    writeEp('Lanternfall S02E03.mkv', 300);

    const res = runIntegrityCheck();

    expect(res.flagged).toHaveLength(1);
    expect(res.flagged[0]).toMatchObject({ title: 'Lanternfall', season: 2, episode: 2 });
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
    writeEp('Lanternfall S02E01.mkv', 300);
    writeEp('Lanternfall S02E02.mkv', 290);
    writeEp('Lanternfall S02E03.mkv', 310);

    const res = runIntegrityCheck();

    expect(res.flagged).toHaveLength(0);
    expect(updateEpisodeStatusMock).not.toHaveBeenCalled();
  });

  it('does not flag a small episode when there are too few siblings (no stable median)', () => {
    writeEp('Lanternfall S02E01.mkv', 300);
    writeEp('Lanternfall S02E02.mkv', 50); // only 2 episodes → below the 3-sibling floor

    const res = runIntegrityCheck();

    expect(res.flagged).toHaveLength(0);
  });

  it('autoFix:false flags without quarantining or resetting', () => {
    writeEp('Lanternfall S02E01.mkv', 300);
    const truncated = writeEp('Lanternfall S02E02.mkv', 50);
    writeEp('Lanternfall S02E03.mkv', 300);

    const res = runIntegrityCheck({ autoFix: false });

    expect(res.flagged).toHaveLength(1);
    expect(fs.existsSync(truncated)).toBe(true);              // untouched
    expect(fs.existsSync(truncated + '.incomplete')).toBe(false);
    expect(updateEpisodeStatusMock).not.toHaveBeenCalled();
  });

  it('cleans up a stale quarantine once a healthy replacement is present', () => {
    writeEp('Lanternfall S02E01.mkv', 300);
    writeEp('Lanternfall S02E02.mkv', 300);          // healthy replacement landed
    writeEp('Lanternfall S02E03.mkv', 300);
    fs.writeFileSync(path.join(showDir, 'Lanternfall S02E02.mkv.incomplete'), Buffer.alloc(50 * 1024));

    const res = runIntegrityCheck();

    expect(res.flagged).toHaveLength(0);
    expect(res.cleaned).toBe(1);
    expect(fs.existsSync(path.join(showDir, 'Lanternfall S02E02.mkv.incomplete'))).toBe(false);
  });

  it('respects integrity.enabled=false (no scan)', () => {
    mockSettings['integrity.enabled'] = 'false';
    writeEp('Lanternfall S02E01.mkv', 300);
    writeEp('Lanternfall S02E02.mkv', 50);
    writeEp('Lanternfall S02E03.mkv', 300);

    const res = runIntegrityCheck();

    expect(res.scannedShows).toBe(0);
    expect(res.flagged).toHaveLength(0);
  });
});

describe('runIntegrityCheck — missing episodes', () => {
  it('reopens a downloaded season with fewer library episodes than have aired', async () => {
    const { updateSeasonStatus } = await import('../../src/database/services/seasons');
    mockSeasonsByShow.set(1, [{ id: 10, season_number: 2, status: 'downloaded', aired_episodes: 10 }]);
    writeEp('Lanternfall S02E01.mkv', 100);
    writeEp('Lanternfall S02E02.mkv', 100);

    const r = runIntegrityCheck();

    expect(r.missing).toEqual([{ movieId: 1, title: 'Lanternfall', season: 2, present: 2, aired: 10 }]);
    expect(updateSeasonStatus).toHaveBeenCalledWith(10, 'pending');
    expect(sendTelegramNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('puts the missing episodes back to pending, not only the season', async () => {
    // Left 'downloaded', the next search closed the season again at once.
    mockSeasonsByShow.set(1, [{ id: 10, season_number: 2, status: 'downloaded', aired_episodes: 3 }]);
    mockEpisodesBySeason.set(10, [
      { id: 201, episode_number: 1, status: 'downloaded' },
      { id: 202, episode_number: 2, status: 'downloaded' },
      { id: 203, episode_number: 3, status: 'downloaded' },
    ]);
    writeEp('Lanternfall S02E01.mkv', 100);
    writeEp('Lanternfall S02E02.mkv', 100);
    runIntegrityCheck();
    expect(updateEpisodeStatusMock).toHaveBeenCalledWith(203, 'pending');
    expect(updateEpisodeStatusMock).not.toHaveBeenCalledWith(201, 'pending');
    expect(updateEpisodeStatusMock).not.toHaveBeenCalledWith(202, 'pending');
  });

  it('never reopens a season below the "from season N" cutoff', async () => {
    // Reopening it would download a season the user excluded.
    const { updateSeasonStatus } = await import('../../src/database/services/seasons');
    mockMovies = [{ ...mockMovies[0], season_cutoff: 3 }];
    mockSeasonsByShow.set(1, [{ id: 10, season_number: 2, status: 'downloaded', aired_episodes: 10 }]);
    writeEp('Lanternfall S02E01.mkv', 100);
    const r = runIntegrityCheck();
    expect(r.missing).toEqual([]);
    expect(updateSeasonStatus).not.toHaveBeenCalledWith(10, 'pending');
  });

  it('leaves a complete season, an unknown aired count and a still-downloading season alone', async () => {
    const { updateSeasonStatus } = await import('../../src/database/services/seasons');
    mockSeasonsByShow.set(1, [
      { id: 10, season_number: 1, status: 'downloaded', aired_episodes: 2 },
      { id: 11, season_number: 2, status: 'downloaded', aired_episodes: null },
      { id: 12, season_number: 3, status: 'downloading', aired_episodes: 8 },
    ]);
    writeEp('Lanternfall S01E01.mkv', 100);
    writeEp('Lanternfall S01E02.mkv', 100);
    writeEp('Lanternfall S02E01.mkv', 100);
    writeEp('Lanternfall S03E01.mkv', 100);

    expect(runIntegrityCheck().missing).toEqual([]);
    expect(updateSeasonStatus).not.toHaveBeenCalled();
  });

  it('reopens a show at most once a week', async () => {
    const { updateSeasonStatus } = await import('../../src/database/services/seasons');
    const { hasRecentActivityEntry } = await import('../../src/database/services/activityLog');
    vi.mocked(hasRecentActivityEntry).mockReturnValueOnce(true);
    mockSeasonsByShow.set(1, [{ id: 10, season_number: 2, status: 'downloaded', aired_episodes: 10 }]);
    writeEp('Lanternfall S02E01.mkv', 100);

    expect(runIntegrityCheck().missing).toHaveLength(1);
    expect(updateSeasonStatus).not.toHaveBeenCalled();
  });

  it('autoFix:false reports without reopening', async () => {
    const { updateSeasonStatus } = await import('../../src/database/services/seasons');
    mockSeasonsByShow.set(1, [{ id: 10, season_number: 2, status: 'downloaded', aired_episodes: 5 }]);
    writeEp('Lanternfall S02E01.mkv', 100);

    expect(runIntegrityCheck({ autoFix: false }).missing).toHaveLength(1);
    expect(updateSeasonStatus).not.toHaveBeenCalled();
  });
});

describe('runAudioLanguageCheck', () => {
  beforeEach(() => {
    mockSettings['integrity.verify_language'] = 'true';
    mockSettings['quality.language'] = 'german';
  });

  it('is off by default (opt-in)', async () => {
    delete mockSettings['integrity.verify_language'];
    writeEp('Lanternfall S02E01.mkv', 300);
    mockAudioTags.set('Lanternfall S02E01.mkv', ['eng']); // would be a mismatch if scanned

    const res = await runAudioLanguageCheck();

    expect(res.scanned).toBe(0);
    expect(sendTelegramNotificationMock).not.toHaveBeenCalled();
  });

  it('flags a title whose audio tracks carry no german tag (english-only mislabel)', async () => {
    writeEp('Lanternfall S02E01.mkv', 300);
    writeEp('Lanternfall S02E02.mkv', 300);
    mockAudioTags.set('Lanternfall S02E01.mkv', ['eng']);
    mockAudioTags.set('Lanternfall S02E02.mkv', ['eng', 'fre']);

    const res = await runAudioLanguageCheck();

    expect(res.mismatched).toHaveLength(1);
    expect(res.mismatched[0]).toMatchObject({ movieId: 1, title: 'Lanternfall' });
    expect(res.mismatched[0].files).toHaveLength(2);
    // Warn-only: one Telegram per title, no quarantine, no episode reset.
    expect(sendTelegramNotificationMock).toHaveBeenCalledTimes(1);
    expect(updateEpisodeStatusMock).not.toHaveBeenCalled();
  });

  it('does NOT flag when a german-tagged track is present (incl. a German DL release)', async () => {
    writeEp('Lanternfall S02E01.mkv', 300);
    writeEp('Lanternfall S02E02.mkv', 300);
    // German DL: german + english tracks — the wanted language IS present.
    mockAudioTags.set('Lanternfall S02E01.mkv', ['ger', 'eng']);
    mockAudioTags.set('Lanternfall S02E02.mkv', ['deu', 'eng']);

    const res = await runAudioLanguageCheck();

    expect(res.mismatched).toHaveLength(0);
    expect(sendTelegramNotificationMock).not.toHaveBeenCalled();
  });

  it('does NOT flag untagged audio (cannot judge)', async () => {
    writeEp('Lanternfall S02E01.mkv', 300);
    mockAudioTags.set('Lanternfall S02E01.mkv', []); // audio present, no language tag

    const res = await runAudioLanguageCheck();

    expect(res.mismatched).toHaveLength(0);
  });

  it('does NOT flag when ffprobe is unavailable (null verdict)', async () => {
    writeEp('Lanternfall S02E01.mkv', 300);
    mockAudioTags.set('Lanternfall S02E01.mkv', null); // ffprobe missing / errored

    const res = await runAudioLanguageCheck();

    expect(res.mismatched).toHaveLength(0);
    expect(sendTelegramNotificationMock).not.toHaveBeenCalled();
  });

  it('skips verification entirely when language preference is "any"', async () => {
    mockSettings['quality.language'] = 'any';
    writeEp('Lanternfall S02E01.mkv', 300);
    mockAudioTags.set('Lanternfall S02E01.mkv', ['eng']);

    const res = await runAudioLanguageCheck();

    expect(res.scanned).toBe(0);
  });
});

describe('runTruncationCheck', () => {
  // Durations/packets by file name: [headerSeconds, tailLast, fullLast]
  const probe = new Map<string, [number, number | null, number | null]>();
  const deps = {
    duration: async (f: string) => probe.get(path.basename(f))?.[0] ?? null,
    tail: async (f: string) => probe.get(path.basename(f))?.[1] ?? null,
    full: async (f: string) => probe.get(path.basename(f))?.[2] ?? null,
  };
  beforeEach(() => { probe.clear(); checkedFiles.clear(); _resetTruncationMemo(); });

  it('quarantines an episode that stops long before its header length — even when the whole season is cut', async () => {
    // Equal sizes everywhere: the median test sees nothing wrong.
    const e1 = writeEp('Lanternfall S02E01.mkv', 300);
    writeEp('Lanternfall S02E02.mkv', 300);
    probe.set('Lanternfall S02E01.mkv', [2800, 700, 700]);
    probe.set('Lanternfall S02E02.mkv', [2800, 2790, 2790]);
    const r = await runTruncationCheck({ deps });
    expect(r.truncated.map(t => path.basename(t.file))).toEqual(['Lanternfall S02E01.mkv']);
    expect(fs.existsSync(e1 + '.incomplete')).toBe(true);
    expect(updateEpisodeStatusMock).toHaveBeenCalledWith(101, 'pending');
    expect(setRepairFlagMock).toHaveBeenCalledWith(1, true);
  });

  it('never acts on the tail check alone — a full read must confirm it', async () => {
    const e1 = writeEp('Lanternfall S02E01.mkv', 300);
    probe.set('Lanternfall S02E01.mkv', [2800, 700, 2795]);   // seek misbehaved, file is fine
    const r = await runTruncationCheck({ deps });
    expect(r.truncated).toEqual([]);
    expect(fs.existsSync(e1)).toBe(true);
  });

  it('puts a cut film back into the queue under repair and leaves its file', async () => {
    const moviesRoot = path.join(tmpRoot, 'movies');
    fs.mkdirSync(path.join(moviesRoot, 'Wardline (2018)'), { recursive: true });
    const film = path.join(moviesRoot, 'Wardline (2018)', 'Wardline (2018).mkv');
    fs.writeFileSync(film, Buffer.alloc(1024));
    mockSettings['paths.movies'] = moviesRoot;
    mockMovies = [{ id: 2, title: 'Wardline', year: 2018, media_type: 'movie', status: 'downloaded', imdb_id: 'tt2' }];
    probe.set('Wardline (2018).mkv', [4589, 673, 673]);
    const r = await runTruncationCheck({ deps });
    expect(r.truncated).toHaveLength(1);
    expect(updateMovieStatus).toHaveBeenCalledWith(2, 'pending');
    expect(setRepairFlagMock).toHaveBeenCalledWith(2, true);
    expect(fs.existsSync(film)).toBe(true);
  });

  it('judges each file once and stays within the per-pass budget', async () => {
    writeEp('Lanternfall S02E01.mkv', 300);
    writeEp('Lanternfall S02E02.mkv', 300);
    writeEp('Lanternfall S02E03.mkv', 300);
    for (const n of ['01', '02', '03']) probe.set(`Lanternfall S02E${n}.mkv`, [2800, 2790, 2790]);
    expect((await runTruncationCheck({ deps, budget: 2 })).probed).toBe(2);
    expect((await runTruncationCheck({ deps, budget: 2 })).probed).toBe(1);
    expect((await runTruncationCheck({ deps, budget: 2 })).probed).toBe(0);
  });

  it('carries on after a restart where the last pass stopped', async () => {
    for (const n of ['01', '02', '03']) {
      writeEp(`Lanternfall S02E${n}.mkv`, 300);
      probe.set(`Lanternfall S02E${n}.mkv`, [2800, 2790, 2790]);
    }
    expect((await runTruncationCheck({ deps, budget: 2 })).probed).toBe(2);
    _resetTruncationMemo();                                   // restart / update
    expect((await runTruncationCheck({ deps, budget: 2 })).probed).toBe(1);
  });
});
