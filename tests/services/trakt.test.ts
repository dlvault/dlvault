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
  addMovie: vi.fn((data: any) => ({ id: 1, ...data })),
  getMovieByTraktId: vi.fn(() => null),
  getMovieByImdbId: vi.fn(() => null),
  getMovieByTmdbId: vi.fn(() => null),
  updateMovieTraktId: vi.fn(),
  getAllMovies: vi.fn(() => []),
  deleteMovie: vi.fn(),
  getMovieById: vi.fn(() => null),
}));

vi.mock('../../src/database/services/activityLog', () => ({
  addLogEntry: vi.fn(),
}));

vi.mock('../../src/database/services/seasons', () => ({
  getSeasonsByShowId: vi.fn(() => []),
  addSeason: vi.fn((movieId: number, num: number) => ({ id: 100 + num, movie_id: movieId, season_number: num })),
  updateSeasonEpisodeCount: vi.fn(),
}));

vi.mock('../../src/database/services/episodes', () => ({
  addEpisodes: vi.fn(),
}));

vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({ isConfigured: () => false, hasMovie: async () => false })),
  getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Mock axios.create to return the mocked axios
mockedAxios.create.mockReturnValue(mockedAxios as any);

import { TraktService } from '../../src/services/trakt';
import { setSetting } from '../../src/database/index';

describe('TraktService', () => {
  let service: TraktService;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    service = new TraktService();
  });

  describe('isConfigured', () => {
    it('should return false when no settings are set', () => {
      expect(service.isConfigured()).toBe(false);
    });

    it('should return false when only client_id is set', () => {
      mockSettings['trakt.client_id'] = 'id123';
      expect(service.isConfigured()).toBe(false);
    });

    it('should return true when client_id and username are set', () => {
      mockSettings['trakt.client_id'] = 'id123';
      mockSettings['trakt.username'] = 'testuser';
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('isAuthenticated', () => {
    it('should return false when no access token', () => {
      expect(service.isAuthenticated()).toBe(false);
    });

    it('should return true when access token exists', () => {
      mockSettings['trakt.access_token'] = 'token123';
      expect(service.isAuthenticated()).toBe(true);
    });
  });

  describe('getAuthUrl', () => {
    it('should construct proper OAuth URL', () => {
      mockSettings['trakt.client_id'] = 'my-client-id';
      const url = service.getAuthUrl();
      expect(url).toContain('client_id=my-client-id');
      expect(url).toContain('response_type=code');
      expect(url).toContain('redirect_uri=');
    });
  });

  describe('exchangeCode', () => {
    it('should store tokens on success', async () => {
      mockSettings['trakt.client_id'] = 'id';
      mockSettings['trakt.client_secret'] = 'secret';

      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'at123', refresh_token: 'rt123' },
      });
      // Mock fetchAndStoreUsername
      mockedAxios.get.mockResolvedValueOnce({
        data: { username: 'testuser' },
      });

      const result = await service.exchangeCode('auth-code');

      expect(result).toBe(true);
      expect(setSetting).toHaveBeenCalledWith('trakt.access_token', 'at123');
      expect(setSetting).toHaveBeenCalledWith('trakt.refresh_token', 'rt123');
    });

    it('should return false on failure', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('Invalid code'));

      const result = await service.exchangeCode('bad-code');
      expect(result).toBe(false);
    });
  });

  describe('refreshToken', () => {
    it('should refresh and store new tokens', async () => {
      mockSettings['trakt.refresh_token'] = 'old-rt';
      mockSettings['trakt.client_id'] = 'id';
      mockSettings['trakt.client_secret'] = 'secret';

      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'new-at', refresh_token: 'new-rt' },
      });

      const result = await service.refreshToken();

      expect(result).toBe(true);
      expect(setSetting).toHaveBeenCalledWith('trakt.access_token', 'new-at');
    });

    it('should return false on failure', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('Expired'));

      const result = await service.refreshToken();
      expect(result).toBe(false);
    });

    it('should coalesce concurrent refresh attempts', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'at', refresh_token: 'rt' },
      });

      const [r1, r2] = await Promise.all([
        service.refreshToken(),
        service.refreshToken(),
      ]);

      expect(r1).toBe(true);
      expect(r2).toBe(true);
      // Only one POST call should have been made
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('getMovieWatchlist', () => {
    it('should return null when not configured', async () => {
      // null is distinct from []: the caller treats null as "API error, do not
      // reconcile" to avoid mass-deleting tracked movies when Trakt is offline.
      const result = await service.getMovieWatchlist();
      expect(result).toBeNull();
    });

    it('should fetch watchlist when configured', async () => {
      mockSettings['trakt.username'] = 'user';
      mockSettings['trakt.client_id'] = 'id';

      const watchlist = [{ movie: { title: 'Test', year: 2024, ids: { trakt: 1 } } }];
      mockedAxios.get.mockResolvedValueOnce({ data: watchlist });

      const result = await service.getMovieWatchlist();
      expect(result).toEqual(watchlist);
    });

    it('should retry with refreshed token on 401', async () => {
      mockSettings['trakt.username'] = 'user';
      mockSettings['trakt.client_id'] = 'id';
      mockSettings['trakt.refresh_token'] = 'rt';

      // First call fails with 401
      mockedAxios.get.mockRejectedValueOnce({ response: { status: 401 } });
      // Refresh token succeeds
      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'new-at', refresh_token: 'new-rt' },
      });
      // Retry succeeds
      mockedAxios.get.mockResolvedValueOnce({ data: [] });

      const result = await service.getMovieWatchlist();
      expect(result).toEqual([]);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('should return null on non-401 errors', async () => {
      mockSettings['trakt.username'] = 'user';
      mockSettings['trakt.client_id'] = 'id';

      mockedAxios.get.mockRejectedValueOnce({ response: { status: 500, data: 'Internal error' } });

      const result = await service.getMovieWatchlist();
      expect(result).toBeNull();
    });
  });

  describe('getShowWatchlist', () => {
    it('should return null when not configured', async () => {
      // See getMovieWatchlist — null means "API unavailable, do not reconcile".
      const result = await service.getShowWatchlist();
      expect(result).toBeNull();
    });

    it('should fetch show watchlist', async () => {
      mockSettings['trakt.username'] = 'user';
      mockSettings['trakt.client_id'] = 'id';

      const watchlist = [{ show: { title: 'Test Show', year: 2024, ids: { trakt: 10 } } }];
      mockedAxios.get.mockResolvedValueOnce({ data: watchlist });

      const result = await service.getShowWatchlist();
      expect(result).toEqual(watchlist);
    });
  });

  describe('getShowSeasons', () => {
    it('should fetch and filter seasons', async () => {
      mockSettings['trakt.client_id'] = 'id';

      mockedAxios.get.mockResolvedValueOnce({
        data: [
          { number: 0, episode_count: 3, aired_episodes: 2 }, // specials — filtered
          { number: 1, episode_count: 10, aired_episodes: 10 },
          { number: 2, episode_count: 8, aired_episodes: 5 },
          { number: 3, episode_count: 10, aired_episodes: 0 }, // unaired — filtered
        ],
      });

      const seasons = await service.getShowSeasons(42);

      expect(seasons).toHaveLength(2);
      expect(seasons[0]).toEqual({ number: 1, episode_count: 10, aired_episodes: 10 });
      expect(seasons[1]).toEqual({ number: 2, episode_count: 8, aired_episodes: 5 });
    });
  });

  describe('markAsCollected', () => {
    it('should return false when not authenticated', async () => {
      const result = await service.markAsCollected({ title: 'Test', year: 2024 });
      expect(result).toBe(false);
    });

    it('should post to collection API when authenticated', async () => {
      mockSettings['trakt.access_token'] = 'token';
      mockedAxios.post.mockResolvedValueOnce({ data: {} });

      const result = await service.markAsCollected({
        imdb_id: 'tt1234567',
        tmdb_id: 555,
        title: 'Test Movie',
        year: 2024,
      });

      expect(result).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/sync/collection',
        expect.objectContaining({
          movies: [expect.objectContaining({
            title: 'Test Movie',
            year: 2024,
          })],
        }),
        expect.any(Object),
      );
    });

    it('should return false on API error', async () => {
      mockSettings['trakt.access_token'] = 'token';
      mockedAxios.post.mockRejectedValueOnce(new Error('API error'));

      const result = await service.markAsCollected({ title: 'Test', year: 2024 });
      expect(result).toBe(false);
    });
  });
});
