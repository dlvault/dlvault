import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSettings, tmdb, seerr } = vi.hoisted(() => ({
  mockSettings: {} as Record<string, string>,
  seerr: {
    isConfigured: vi.fn(() => false),
    findTmdbId: vi.fn(async () => 99 as number | null),
    getMovieRelease: vi.fn(),
    getShowAiring: vi.fn(),
  },
  tmdb: {
    isConfigured: vi.fn(() => true),
    region: vi.fn(() => 'DE'),
    findTmdbId: vi.fn(async () => 42 as number | null),
    getMovieRelease: vi.fn(),
    getShowAiring: vi.fn(),
  },
}));
vi.mock('../../src/database/index', () => ({
  getSetting: (k: string) => mockSettings[k] ?? '',
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/services/tmdb', () => ({ tmdbService: tmdb }));
vi.mock('../../src/services/seerr', () => ({ seerrService: seerr }));
const side = vi.hoisted(() => ({ setReleaseHold: vi.fn(), notifyReleaseHold: vi.fn(async () => undefined) }));
vi.mock('../../src/database/services/movies', () => ({ setReleaseHold: side.setReleaseHold }));
vi.mock('../../src/services/telegram', () => ({ notifyReleaseHold: side.notifyReleaseHold }));
const seasonRows = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock('../../src/database/services/seasons', () => ({ getSeasonsByShowId: () => seasonRows.rows }));

import { releaseHold, heldForRelease, warmReleaseInfo, cachedReleaseInfo, _resetReleaseHold, type ReleaseInfo } from '../../src/services/releaseHold';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-11T12:00:00Z');
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

function movie(over: Record<string, any> = {}): any {
  return {
    id: 1, title: 'Film', media_type: 'movie', status: 'not_found',
    imdb_id: 'tt0000001', tmdb_id: null, repair: 0,
    added_at: '2026-01-01 00:00:00', last_checked_at: '2026-10-10 12:00:00',
    ...over,
  };
}
const film = (over: Partial<Extract<ReleaseInfo, { kind: 'movie' }>>): ReleaseInfo =>
  ({ kind: 'movie', status: 'Released', theatrical: null, digital: null, ...over });
const show = (over: Partial<Extract<ReleaseInfo, { kind: 'show' }>>): ReleaseInfo =>
  ({ kind: 'show', status: 'Returning Series', firstAir: '2020-01-01', nextAir: null, ...over });

describe('releaseHold (rules)', () => {
  it('never holds a title under repair — the broken episode must come back now, not next week', () => {
    // Integrity check reset a truncated episode; the show still reads
    // 'downloaded', and the weekly cadence would push the re-download a week out.
    const repairing = movie({ media_type: 'show', status: 'downloaded', repair: 1 } as any);
    expect(releaseHold(repairing, show({ status: 'Returning Series' }), NOW, 30)).toBeNull();
    expect(releaseHold(movie({ media_type: 'show', status: 'downloaded' } as any), show({ status: 'Returning Series' }), NOW, 30)).not.toBeNull();
  });

  it('holds a film until its digital/disc date in the region', () => {
    const h = releaseHold(movie(), film({ theatrical: '2026-09-18', digital: '2026-11-20' }), NOW, 30);
    expect(h?.until).toBe(day('2026-11-20'));
  });

  it('releases a film once the digital date has passed, theatrical grace notwithstanding', () => {
    expect(releaseHold(movie(), film({ theatrical: '2026-10-01', digital: '2026-10-05' }), NOW, 30)).toBeNull();
  });

  it('without a digital date, holds until theatrical + grace days', () => {
    const h = releaseHold(movie(), film({ theatrical: '2026-09-18' }), NOW, 30);
    expect(h?.until).toBe(day('2026-10-18'));
    expect(releaseHold(movie(), film({ theatrical: '2026-08-01' }), NOW, 30)).toBeNull();
  });

  it('holds a far-future film', () => {
    const h = releaseHold(movie(), film({ status: 'Post Production', theatrical: '2027-12-02' }), NOW, 30);
    expect(h?.until).toBe(day('2027-12-02') + 30 * DAY);
  });

  it('checks an unannounced film without any date weekly', () => {
    const h = releaseHold(movie(), film({ status: 'In Production' }), NOW, 30);
    expect(h?.until).toBe(Date.parse('2026-10-17T12:00:00Z'));
  });

  it('never holds a title that was never searched', () => {
    expect(releaseHold(movie({ last_checked_at: null }), film({ theatrical: '2027-12-02' }), NOW, 30)).toBeNull();
  });

  it('never holds without TMDb data', () => {
    expect(releaseHold(movie(), null, NOW, 30)).toBeNull();
  });

  it('holds a show until the day after its premiere', () => {
    const h = releaseHold(movie({ media_type: 'show', status: 'pending' }), show({ firstAir: '2026-11-03', status: 'Planned' }), NOW, 30);
    expect(h?.until).toBe(day('2026-11-04'));
  });

  it('checks a finished, fully downloaded show monthly', () => {
    const h = releaseHold(movie({ media_type: 'show', status: 'downloaded' }), show({ status: 'Ended' }), NOW, 30);
    expect(h?.until).toBe(Date.parse('2026-11-09T12:00:00Z'));
  });

  it('waits for the next episode of a running show, but at most a week', () => {
    const m = movie({ media_type: 'show', status: 'downloaded' });
    expect(releaseHold(m, show({ nextAir: '2026-10-14' }), NOW, 30)?.until).toBe(day('2026-10-15'));
    expect(releaseHold(m, show({ nextAir: '2027-03-01' }), NOW, 30)?.until).toBe(Date.parse('2026-10-17T12:00:00Z'));
  });

  it('checks a running, complete show without an announced episode weekly', () => {
    const m = movie({ media_type: 'show', status: 'downloaded' });
    expect(releaseHold(m, show({ nextAir: null }), NOW, 30)?.until).toBe(Date.parse('2026-10-17T12:00:00Z'));
    const stale = movie({ media_type: 'show', status: 'downloaded', last_checked_at: '2026-10-01 00:00:00' });
    expect(releaseHold(stale, show({ nextAir: null }), NOW, 30)).toBeNull();
  });

  it('never holds a show that still misses seasons', () => {
    const m = movie({ media_type: 'show', status: 'downloading' });
    expect(releaseHold(m, show({ status: 'Ended' }), NOW, 30)).toBeNull();
    expect(releaseHold(m, show({ nextAir: '2026-10-14' }), NOW, 30)).toBeNull();
  });
});

describe('shows waiting for a season cutoff', () => {
  // heldForRelease reads the clock; pin it to the fixtures' NOW, or the test
  // turns red once last_checked_at is older than the grace period.
  afterEach(() => { vi.useRealTimers(); });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    _resetReleaseHold();
    seasonRows.rows = [];
    tmdb.isConfigured.mockReturnValue(true);
    tmdb.getShowAiring.mockResolvedValue({ status: 'Returning Series', firstAir: '2024-01-01', nextAir: null });
  });
  const waiting = () => movie({ media_type: 'show', status: 'pending', season_cutoff: 2, tmdb_id: 7 });

  it('the rule holds a pending show only when nothing it wants exists yet', () => {
    expect(releaseHold(waiting(), show({}), NOW, 30)).toBeNull();
    expect(releaseHold(waiting(), show({}), NOW, 30, { nothingMonitored: true })?.kind).toBe('cadence');
  });

  it('holds when TMDb knows only seasons below the cutoff', async () => {
    seasonRows.rows = [{ season_number: 1, episode_count: 6 }];
    expect(await heldForRelease(waiting())).toBe(true);
  });

  it('keeps searching while the season list is not seeded, or once the wanted season exists', async () => {
    seasonRows.rows = [{ season_number: 1, episode_count: null }];
    expect(await heldForRelease(waiting())).toBe(false);
    _resetReleaseHold();
    seasonRows.rows = [{ season_number: 1, episode_count: 6 }, { season_number: 2, episode_count: 6 }];
    expect(await heldForRelease(waiting())).toBe(false);
  });
});

describe('heldForRelease', () => {
  beforeEach(() => {
    _resetReleaseHold();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    vi.clearAllMocks();
    tmdb.isConfigured.mockReturnValue(true);
    tmdb.findTmdbId.mockResolvedValue(42);
    seerr.isConfigured.mockReturnValue(false);
    seerr.findTmdbId.mockResolvedValue(99);
  });

  it('holds a film whose region date lies ahead, and caches the lookup', async () => {
    tmdb.getMovieRelease.mockResolvedValue({ status: 'Post Production', theatrical: '2099-01-01', digital: null });
    expect(await heldForRelease(movie())).toBe(true);
    expect(await heldForRelease(movie())).toBe(true);
    expect(tmdb.getMovieRelease).toHaveBeenCalledTimes(1);
    expect(tmdb.getMovieRelease).toHaveBeenCalledWith(42, 'DE');
  });

  it('never holds when the TMDb lookup fails', async () => {
    tmdb.getMovieRelease.mockRejectedValue(new Error('timeout'));
    expect(await heldForRelease(movie())).toBe(false);
  });

  it('is off with scheduler.release_hold=false or with neither TMDb nor Seerr', async () => {
    tmdb.getMovieRelease.mockResolvedValue({ status: 'Planned', theatrical: '2099-01-01', digital: null });
    mockSettings['scheduler.release_hold'] = 'false';
    expect(await heldForRelease(movie())).toBe(false);
    delete mockSettings['scheduler.release_hold'];
    tmdb.isConfigured.mockReturnValue(false);
    expect(await heldForRelease(movie())).toBe(false);
  });

  it('leaves a title under repair alone', async () => {
    tmdb.getMovieRelease.mockResolvedValue({ status: 'Planned', theatrical: '2099-01-01', digital: null });
    expect(await heldForRelease(movie({ repair: 1 }))).toBe(false);
  });

  it('uses the stored tmdb id without a find call', async () => {
    tmdb.getShowAiring.mockResolvedValue({ status: 'Ended', firstAir: '2010-01-01', nextAir: null });
    const m = movie({ media_type: 'show', status: 'downloaded', tmdb_id: 7, last_checked_at: '2099-01-01 00:00:00' });
    expect(await heldForRelease(m)).toBe(true);
    expect(tmdb.findTmdbId).not.toHaveBeenCalled();
    expect(tmdb.getShowAiring).toHaveBeenCalledWith(7);
  });

  it('without a TMDb key, takes the dates from Seerr', async () => {
    tmdb.isConfigured.mockReturnValue(false);
    seerr.isConfigured.mockReturnValue(true);
    seerr.getMovieRelease.mockResolvedValue({ status: 'Post Production', theatrical: '2099-01-01', digital: null });
    expect(await heldForRelease(movie())).toBe(true);
    expect(seerr.findTmdbId).toHaveBeenCalledWith('movie', 'tt0000001');
    expect(seerr.getMovieRelease).toHaveBeenCalledWith(99, 'DE');
    expect(tmdb.getMovieRelease).not.toHaveBeenCalled();
  });

  it('with a TMDb key, uses TMDb and leaves Seerr alone', async () => {
    seerr.isConfigured.mockReturnValue(true);
    tmdb.getMovieRelease.mockResolvedValue({ status: 'Post Production', theatrical: '2099-01-01', digital: null });
    expect(await heldForRelease(movie())).toBe(true);
    expect(seerr.findTmdbId).not.toHaveBeenCalled();
    expect(seerr.getMovieRelease).not.toHaveBeenCalled();
  });

  it('never holds when the Seerr lookup fails', async () => {
    tmdb.isConfigured.mockReturnValue(false);
    seerr.isConfigured.mockReturnValue(true);
    seerr.getShowAiring.mockRejectedValue(new Error('ECONNREFUSED'));
    const m = movie({ media_type: 'show', status: 'downloaded', tmdb_id: 7 });
    expect(await heldForRelease(m)).toBe(false);
  });

  it('records the hold on the row and tells the requester about a real date', async () => {
    tmdb.getMovieRelease.mockResolvedValue({ status: 'Post Production', theatrical: '2099-01-01', digital: '2099-03-01' });
    await heldForRelease(movie());
    expect(side.setReleaseHold).toHaveBeenCalledWith(1, '2099-03-01', 'Erscheint digital/auf Disc am 01.03.2099');
    await new Promise(r => setTimeout(r, 0));
    expect(side.notifyReleaseHold).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), '2099-03-01', expect.stringContaining('01.03.2099'));
  });

  it('does not message anyone about a mere re-check cadence, and clears a stale hold', async () => {
    tmdb.getShowAiring.mockResolvedValue({ status: 'Ended', firstAir: '2010-01-01', nextAir: null });
    await heldForRelease(movie({ media_type: 'show', status: 'downloaded', tmdb_id: 7, last_checked_at: '2099-01-01 00:00:00' }));
    await new Promise(r => setTimeout(r, 0));
    expect(side.notifyReleaseHold).not.toHaveBeenCalled();

    _resetReleaseHold();
    tmdb.getMovieRelease.mockResolvedValue({ status: 'Released', theatrical: '2020-01-01', digital: '2020-03-01' });
    await heldForRelease(movie({ release_hold_until: '2099-03-01', release_hold_reason: 'x' }));
    expect(side.setReleaseHold).toHaveBeenLastCalledWith(1, null, null);
  });

  it('warms the release-date cache for waiting titles after a restart, once each', async () => {
    tmdb.getMovieRelease.mockResolvedValue({ status: 'Released', theatrical: '2026-07-16', digital: null });
    const list = [movie({ id: 1, status: 'not_found' }), movie({ id: 2, status: 'downloaded' }), movie({ id: 3, status: 'not_found' })];
    expect(await warmReleaseInfo(list)).toBe(2);
    expect(cachedReleaseInfo(1)).toMatchObject({ kind: 'movie', theatrical: '2026-07-16' });
    expect(cachedReleaseInfo(2)).toBeUndefined();
    expect(await warmReleaseInfo(list)).toBe(0);
    mockSettings['scheduler.release_hold'] = 'false';
    _resetReleaseHold();
    expect(await warmReleaseInfo(list)).toBe(0);
  });
});
