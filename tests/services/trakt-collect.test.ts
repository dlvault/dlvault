import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockSettings: Record<string, string> = {};

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
  setSetting: vi.fn(),
  initDatabase: vi.fn(),
}));
vi.mock('../../src/database/services/movies', () => ({
  addMovie: vi.fn(), getMovieByTraktId: vi.fn(() => null), getMovieByImdbId: vi.fn(() => null),
  getMovieByTmdbId: vi.fn(() => null), updateMovieTraktId: vi.fn(), getAllMovies: vi.fn(() => []),
  deleteMovie: vi.fn(), getMovieById: vi.fn(() => null),
}));
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: vi.fn() }));
vi.mock('../../src/database/services/seasons', () => ({
  getSeasonsByShowId: vi.fn(() => []), addSeason: vi.fn(), updateSeasonEpisodeCount: vi.fn(),
}));
vi.mock('../../src/database/services/episodes', () => ({ addEpisodes: vi.fn() }));
vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({ isConfigured: () => false, hasMovie: async () => false })),
  getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

mockedAxios.create.mockReturnValue(mockedAxios as any);

import { TraktService } from '../../src/services/trakt';

describe('TraktService.markAsCollected — 401 token-refresh retry', () => {
  let service: TraktService;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    mockedAxios.create.mockReturnValue(mockedAxios as any);
    service = new TraktService();
  });

  it('refreshes the token and retries once after a 401, then succeeds', async () => {
    mockSettings['trakt.access_token'] = 'expired';
    mockSettings['trakt.refresh_token'] = 'rt';
    mockSettings['trakt.client_id'] = 'id';
    mockSettings['trakt.client_secret'] = 'secret';

    // First collection POST 401s; refresh POST succeeds; retry POST succeeds.
    mockedAxios.post
      .mockRejectedValueOnce({ response: { status: 401 } })           // /sync/collection
      .mockResolvedValueOnce({ data: { access_token: 'new', refresh_token: 'new-rt' } }) // /oauth/token
      .mockResolvedValueOnce({ data: {} });                           // /sync/collection retry

    const result = await service.markAsCollected({ imdb_id: 'tt1234567', title: 'X', year: 2024 });

    expect(result).toBe(true);
    // 3 POSTs: original collection, refresh, retried collection.
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    const collectionCalls = mockedAxios.post.mock.calls.filter(c => c[0] === '/sync/collection');
    expect(collectionCalls).toHaveLength(2);
  });

  it('does not loop infinitely when the refreshed token still 401s', async () => {
    mockSettings['trakt.access_token'] = 'expired';
    mockSettings['trakt.refresh_token'] = 'rt';
    mockSettings['trakt.client_id'] = 'id';
    mockSettings['trakt.client_secret'] = 'secret';

    mockedAxios.post
      .mockRejectedValueOnce({ response: { status: 401 } })           // collection
      .mockResolvedValueOnce({ data: { access_token: 'new', refresh_token: 'new-rt' } }) // refresh
      .mockRejectedValueOnce({ response: { status: 401 } });          // retried collection still 401

    const result = await service.markAsCollected({ imdb_id: 'tt1', title: 'X', year: 2024 });

    expect(result).toBe(false);
    // Exactly one refresh; the retry is not attempted a second time.
    const collectionCalls = mockedAxios.post.mock.calls.filter(c => c[0] === '/sync/collection');
    expect(collectionCalls).toHaveLength(2);
  });

  it('does not refresh on a non-401 error', async () => {
    mockSettings['trakt.access_token'] = 'token';
    mockedAxios.post.mockRejectedValueOnce({ response: { status: 500 } });

    const result = await service.markAsCollected({ title: 'X', year: 2024 });

    expect(result).toBe(false);
    // Only the single failing collection POST — no refresh attempt.
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});
