import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockSettings: Record<string, string> = {};

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
  setSetting: vi.fn((key: string, value: string) => { mockSettings[key] = value; }),
  initDatabase: vi.fn(),
}));
vi.mock('../../src/database/services/movies', () => ({
  addMovie: vi.fn(), getMovieByTraktId: vi.fn(() => null), getMovieByImdbId: vi.fn(() => null),
  getMovieByTmdbId: vi.fn(() => null), updateMovieTraktId: vi.fn(), getAllMovies: vi.fn(() => []),
  deleteMovie: vi.fn(), getMovieById: vi.fn(() => null),
}));
const addLogEntry = vi.hoisted(() => vi.fn());
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry }));
vi.mock('../../src/database/services/seasons', () => ({
  getSeasonsByShowId: vi.fn(() => []), addSeason: vi.fn(), updateSeasonEpisodeCount: vi.fn(),
}));
vi.mock('../../src/database/services/episodes', () => ({ addEpisodes: vi.fn() }));
vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({ isConfigured: () => false, hasMovie: async () => false })),
  getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));
vi.mock('../../src/services/requests', () => ({ requestTitle: vi.fn() }));
vi.mock('../../src/services/processingState', () => ({ processingMovies: new Set() }));
const sendTelegramNotification = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../src/services/telegram', () => ({ sendTelegramNotification }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

mockedAxios.create.mockReturnValue(mockedAxios as any);

import { TraktService } from '../../src/services/trakt';

/**
 * Regression cover for a 2.5-day silent outage.
 *
 * Trakt started answering 403 (the OAuth application had been removed from the
 * account). 403 has no recovery path — unlike 401 it does not mean "token
 * expired" — but the code treated it as an ordinary error, so the 2-minute
 * watchlist monitor re-issued the same doomed request 3000+ times and the only
 * symptom was a repeating log line nobody was watching.
 */
describe('Trakt persistent auth failure', () => {
  let service: TraktService;

  const forbidden = { response: { status: 403, data: 'Forbidden' } };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    mockedAxios.create.mockReturnValue(mockedAxios as any);
    mockSettings['trakt.client_id'] = 'cid';
    mockSettings['trakt.access_token'] = 'tok-broken';
    mockSettings['trakt.username'] = 'tester';
    service = new TraktService();
  });

  it('stops issuing requests after a 403 instead of retrying every cycle', async () => {
    mockedAxios.get.mockRejectedValue(forbidden);

    expect(await service.getMovieWatchlist()).toBeNull();
    const afterFirst = mockedAxios.get.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Five more monitor ticks — none of them should reach the network.
    for (let i = 0; i < 5; i++) await service.getMovieWatchlist();
    expect(mockedAxios.get.mock.calls.length).toBe(afterFirst);
  });

  it('reports the failure once, not once per attempt', async () => {
    mockedAxios.get.mockRejectedValue(forbidden);

    for (let i = 0; i < 4; i++) await service.getMovieWatchlist();

    expect(sendTelegramNotification).toHaveBeenCalledTimes(1);
    expect(addLogEntry.mock.calls.filter(c => c[1] === 'trakt_auth_failed')).toHaveLength(1);
  });

  it('exposes the failure so the health check can surface it', async () => {
    expect(service.getAuthFailure()).toBeNull();

    mockedAxios.get.mockRejectedValue(forbidden);
    await service.getMovieWatchlist();

    const failure = service.getAuthFailure();
    expect(failure).not.toBeNull();
    expect(failure!.status).toBe(403);
  });

  it('also blocks the show watchlist — one failure covers the whole integration', async () => {
    mockedAxios.get.mockRejectedValue(forbidden);
    await service.getMovieWatchlist();
    const calls = mockedAxios.get.mock.calls.length;

    expect(await service.getShowWatchlist()).toBeNull();
    expect(mockedAxios.get.mock.calls.length).toBe(calls);
  });

  it('recovers by itself once the user reconnects with a new token', async () => {
    mockedAxios.get.mockRejectedValue(forbidden);
    await service.getMovieWatchlist();
    expect(service.getAuthFailure()).not.toBeNull();

    // Reconnecting writes fresh credentials; that must lift the block without
    // waiting out the hourly probe.
    mockSettings['trakt.access_token'] = 'tok-fresh';
    mockedAxios.get.mockResolvedValue({ data: [], headers: {} });

    expect(await service.getMovieWatchlist()).toEqual([]);
    expect(service.getAuthFailure()).toBeNull();
  });

  it('treats 426 (VIP required) the same way', async () => {
    mockedAxios.get.mockRejectedValue({ response: { status: 426, data: 'Upgrade Required' } });

    await service.getMovieWatchlist();

    expect(service.getAuthFailure()?.status).toBe(426);
  });

  it('leaves an ordinary transient error alone', async () => {
    // A 500 is not a credential problem — it must NOT latch the integration off.
    mockedAxios.get.mockRejectedValue({ response: { status: 500, data: 'boom' } });

    await service.getMovieWatchlist();
    const calls = mockedAxios.get.mock.calls.length;
    await service.getMovieWatchlist();

    expect(service.getAuthFailure()).toBeNull();
    expect(mockedAxios.get.mock.calls.length).toBeGreaterThan(calls);
  });
});

/**
 * A provider nobody connected must be completely inert.
 *
 * Reported from a Plex-only instance that had never touched Trakt and still saw
 * Trakt failures in its log: several network methods fired without checking
 * whether Trakt was set up at all.
 */
describe('unconfigured Trakt is inert', () => {
  let service: TraktService;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    mockedAxios.create.mockReturnValue(mockedAxios as any);
    service = new TraktService();   // no client_id, no token, no username
  });

  it('makes no request and logs no failure across every network method', async () => {
    await service.getMovieWatchlist();
    await service.getShowWatchlist();
    await service.getShowSeasons(123);
    await service.getSeasonEpisodes(123, 1);
    await service.getMovieDetails(123);
    await service.getTranslation('tt1', 'movie');
    await service.searchCatalog('x', { types: ['movie'] });
    await service.getTrending({ types: ['movie'] });
    await service.markAsCollected({ title: 'X', year: 2024 });
    await service.addToWatchlist({ title: 'X', year: 2024 });

    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
    // And nothing that would page the user about a provider they never set up.
    expect(sendTelegramNotification).not.toHaveBeenCalled();
    expect(service.getAuthFailure()).toBeNull();
  });

  it('returns the right empty shapes rather than throwing', async () => {
    expect(await service.getMovieWatchlist()).toBeNull();
    expect(await service.getShowSeasons(1)).toEqual([]);
    expect(await service.getSeasonEpisodes(1, 1)).toEqual([]);
    expect(await service.getMovieDetails(1)).toBeNull();
    expect(await service.searchCatalog('x', { types: ['movie'] })).toEqual([]);
    expect(await service.getTrending({ types: ['movie'] })).toEqual([]);
  });

  it('reports itself as not configured', () => {
    expect(service.isConfigured()).toBe(false);
    expect(service.isAuthenticated()).toBe(false);
  });
});
