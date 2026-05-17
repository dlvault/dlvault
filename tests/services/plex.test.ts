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
  addMovie: vi.fn((data: any) => ({ id: Math.floor(Math.random() * 1000), ...data })),
  getMovieByTraktId: vi.fn(() => null),
  getMovieByTmdbId: vi.fn(() => null),
  getMovieByImdbId: vi.fn(() => null),
  getAllMovies: vi.fn(() => []),
  deleteMovie: vi.fn(),
}));

vi.mock('../../src/database/services/activityLog', () => ({
  addLogEntry: vi.fn(),
}));

vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({ isConfigured: () => false, hasMovie: async () => false })),
  getLibraryProviderName: vi.fn(() => 'Plex'),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { PlexService } from '../../src/services/plex';
import { getMovieByTraktId, getMovieByTmdbId, getMovieByImdbId, addMovie, getAllMovies, deleteMovie } from '../../src/database/services/movies';
import { addLogEntry } from '../../src/database/services/activityLog';
import { getLibraryProvider } from '../../src/services/libraryProvider';

describe('PlexService', () => {
  let service: PlexService;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    service = new PlexService();
  });

  describe('isConfigured', () => {
    it('should return false when no token is set', () => {
      expect(service.isConfigured()).toBe(false);
    });

    it('should return true when token is set', () => {
      mockSettings['plex.token'] = 'abc123';
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('testConnection', () => {
    it('should return success:false when not configured', async () => {
      const result = await service.testConnection();
      expect(result).toEqual({ success: false });
    });

    it('should return success with username and movieCount', async () => {
      mockSettings['plex.token'] = 'valid-token';

      // Mock user endpoint
      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.includes('plex.tv/api/v2/user')) {
          return { data: { username: 'TestUser', title: 'TestUser' } };
        }
        // Mock watchlist endpoint (called by getWatchlist)
        if (url.includes('watchlist/all')) {
          return {
            data: {
              MediaContainer: {
                totalSize: 2,
                Metadata: [
                  { title: 'Movie 1', year: 2024, ratingKey: '1', type: 'movie', Guid: [{ id: 'tmdb://123' }] },
                  { title: 'Movie 2', year: 2023, ratingKey: '2', type: 'movie', Guid: [{ id: 'tmdb://456' }] },
                ],
              },
            },
          };
        }
        return { data: {} };
      });

      const result = await service.testConnection();
      expect(result.success).toBe(true);
      expect(result.username).toBe('TestUser');
      expect(result.movieCount).toBe(2);
    });

    it('should return success:false on API error', async () => {
      mockSettings['plex.token'] = 'bad-token';
      mockedAxios.get.mockRejectedValue(new Error('401 Unauthorized'));

      const result = await service.testConnection();
      expect(result).toEqual({ success: false });
    });
  });

  describe('getWatchlist', () => {
    it('should return empty array when not configured', async () => {
      const result = await service.getWatchlist();
      expect(result).toEqual([]);
    });

    it('should fetch and parse watchlist items with IMDb and TMDb IDs', async () => {
      mockSettings['plex.token'] = 'token123';

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            totalSize: 1,
            Metadata: [
              {
                title: 'Inception',
                year: 2010,
                ratingKey: '42',
                type: 'movie',
                Guid: [
                  { id: 'imdb://tt1375666' },
                  { id: 'tmdb://27205' },
                ],
              },
            ],
          },
        },
      });

      const result = await service.getWatchlist();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        title: 'Inception',
        year: 2010,
        imdbId: 'tt1375666',
        tmdbId: 27205,
        plexKey: '42',
        mediaType: 'movie',
      });
    });

    it('should handle items with lowercase guids field', async () => {
      mockSettings['plex.token'] = 'token123';

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            totalSize: 1,
            Metadata: [
              {
                title: 'Test Movie',
                year: 2024,
                ratingKey: '99',
                type: 'movie',
                guids: [{ id: 'tmdb://555' }],
              },
            ],
          },
        },
      });

      const result = await service.getWatchlist();
      expect(result[0].tmdbId).toBe(555);
      expect(result[0].imdbId).toBeNull();
    });

    it('should handle shows with type=show', async () => {
      mockSettings['plex.token'] = 'token123';

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            totalSize: 1,
            Metadata: [
              {
                title: 'Breaking Bad',
                year: 2008,
                ratingKey: '10',
                type: 'show',
                Guid: [{ id: 'tmdb://1396' }],
              },
            ],
          },
        },
      });

      const result = await service.getWatchlist();
      expect(result[0].mediaType).toBe('show');
    });

    it('should handle items without any GUIDs', async () => {
      mockSettings['plex.token'] = 'token123';

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            totalSize: 1,
            Metadata: [
              { title: 'No ID Movie', year: 2024, ratingKey: '5', type: 'movie' },
            ],
          },
        },
      });

      const result = await service.getWatchlist();
      expect(result[0].imdbId).toBeNull();
      expect(result[0].tmdbId).toBeNull();
    });

    it('should paginate through multiple pages', async () => {
      mockSettings['plex.token'] = 'token123';

      // Page 1: 100 items
      const page1Items = Array.from({ length: 100 }, (_, i) => ({
        title: `Movie ${i}`,
        year: 2024,
        ratingKey: String(i),
        type: 'movie',
        Guid: [{ id: `tmdb://${i}` }],
      }));

      // Page 2: 10 items
      const page2Items = Array.from({ length: 10 }, (_, i) => ({
        title: `Movie ${100 + i}`,
        year: 2024,
        ratingKey: String(100 + i),
        type: 'movie',
        Guid: [{ id: `tmdb://${100 + i}` }],
      }));

      mockedAxios.get
        .mockResolvedValueOnce({ data: { MediaContainer: { totalSize: 110, Metadata: page1Items } } })
        .mockResolvedValueOnce({ data: { MediaContainer: { totalSize: 110, Metadata: page2Items } } });

      const result = await service.getWatchlist();
      expect(result).toHaveLength(110);
    });

    it('should fall back to metadata API when discover fails', async () => {
      mockSettings['plex.token'] = 'token123';

      mockedAxios.get
        // First call to discover API fails
        .mockRejectedValueOnce(new Error('502 Bad Gateway'))
        // Fallback to metadata API succeeds
        .mockResolvedValueOnce({
          data: {
            MediaContainer: {
              totalSize: 1,
              Metadata: [
                { title: 'Fallback Movie', year: 2024, ratingKey: '1', type: 'movie', Guid: [{ id: 'tmdb://999' }] },
              ],
            },
          },
        });

      const result = await service.getWatchlist();
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Fallback Movie');
      // Verify it tried the metadata API
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
      expect(mockedAxios.get.mock.calls[1][0]).toContain('metadata.provider.plex.tv');
    });

    it('should return empty on API error', async () => {
      mockSettings['plex.token'] = 'token123';
      mockedAxios.get.mockRejectedValue({ response: { status: 500, data: 'Internal Error' }, message: 'Error' });

      const result = await service.getWatchlist();
      expect(result).toEqual([]);
    });
  });

  describe('syncWatchlist', () => {
    it('should add new movies from watchlist', async () => {
      mockSettings['plex.token'] = 'token123';
      mockSettings['quality.minimum'] = '1080p';

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            totalSize: 1,
            Metadata: [
              { title: 'New Movie', year: 2024, ratingKey: '1', type: 'movie', Guid: [{ id: 'imdb://tt1234567' }, { id: 'tmdb://12345' }] },
            ],
          },
        },
      });

      const count = await service.syncWatchlist();
      expect(count).toBe(1);
      expect(addMovie).toHaveBeenCalledWith(expect.objectContaining({
        title: 'New Movie',
        year: 2024,
        tmdb_id: 12345,
        imdb_id: 'tt1234567',
        status: 'pending',
        media_type: 'movie',
      }));
      expect(addLogEntry).toHaveBeenCalled();
    });

    it('should skip items without TMDb ID', async () => {
      mockSettings['plex.token'] = 'token123';

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            totalSize: 1,
            Metadata: [
              { title: 'No ID Movie', year: 2024, ratingKey: '1', type: 'movie', Guid: [{ id: 'imdb://tt999' }] },
            ],
          },
        },
      });

      const count = await service.syncWatchlist();
      expect(count).toBe(0);
      expect(addMovie).not.toHaveBeenCalled();
    });

    it('should skip existing movies (by tmdb)', async () => {
      mockSettings['plex.token'] = 'token123';

      vi.mocked(getMovieByTmdbId).mockReturnValueOnce({ id: 1, tmdb_id: 12345, title: 'Existing', status: 'pending' } as any);

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            totalSize: 1,
            Metadata: [
              { title: 'Existing', year: 2024, ratingKey: '1', type: 'movie', Guid: [{ id: 'tmdb://12345' }] },
            ],
          },
        },
      });

      const count = await service.syncWatchlist();
      expect(count).toBe(0);
    });

    it('should skip existing movies (by imdb)', async () => {
      mockSettings['plex.token'] = 'token123';

      vi.mocked(getMovieByImdbId).mockReturnValueOnce({ id: 1, imdb_id: 'tt999', title: 'Existing', status: 'pending' } as any);

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            totalSize: 1,
            Metadata: [
              { title: 'Existing', year: 2024, ratingKey: '1', type: 'movie', Guid: [{ id: 'imdb://tt999' }, { id: 'tmdb://555' }] },
            ],
          },
        },
      });

      const count = await service.syncWatchlist();
      expect(count).toBe(0);
    });

    it('should mark movies already in library as downloaded', async () => {
      mockSettings['plex.token'] = 'token123';

      const mockProvider = { isConfigured: () => true, hasMovie: vi.fn().mockResolvedValue(true) };
      vi.mocked(getLibraryProvider).mockReturnValue(mockProvider as any);

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            totalSize: 1,
            Metadata: [
              { title: 'Library Movie', year: 2024, ratingKey: '1', type: 'movie', Guid: [{ id: 'tmdb://777' }] },
            ],
          },
        },
      });

      const count = await service.syncWatchlist();
      expect(count).toBe(0);
      expect(addMovie).toHaveBeenCalledWith(expect.objectContaining({
        status: 'downloaded',
      }));
    });

    it('should remove movies no longer on watchlist when provider is plex', async () => {
      mockSettings['plex.token'] = 'token123';
      mockSettings['watchlist.provider'] = 'plex';

      vi.mocked(getAllMovies).mockReturnValue([
        { id: 1, trakt_id: 111, tmdb_id: 111, title: 'Old Movie', year: 2020, status: 'pending' },
        { id: 2, trakt_id: 222, tmdb_id: 222, title: 'Still Here', year: 2021, status: 'pending' },
      ] as any);

      // Watchlist only has movie with tmdb 222
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            totalSize: 1,
            Metadata: [
              { title: 'Still Here', year: 2021, ratingKey: '2', type: 'movie', Guid: [{ id: 'tmdb://222' }] },
            ],
          },
        },
      });
      // Movie 222 already exists
      vi.mocked(getMovieByTmdbId).mockImplementation((id: number) => {
        if (id === 222) return { id: 2, tmdb_id: 222, title: 'Still Here', status: 'pending' } as any;
        return null;
      });

      await service.syncWatchlist();
      expect(deleteMovie).toHaveBeenCalledWith(1);
      expect(deleteMovie).not.toHaveBeenCalledWith(2);
    });

    it('should NOT remove manually added movies (trakt_id=null)', async () => {
      mockSettings['plex.token'] = 'token123';
      mockSettings['watchlist.provider'] = 'plex';

      vi.mocked(getAllMovies).mockReturnValue([
        { id: 1, trakt_id: null, tmdb_id: 999, title: 'Manual Movie', year: 2024, status: 'pending' },
      ] as any);

      mockedAxios.get.mockResolvedValueOnce({
        data: { MediaContainer: { totalSize: 0, Metadata: [] } },
      });

      await service.syncWatchlist();
      expect(deleteMovie).not.toHaveBeenCalled();
    });

    it('should NOT remove movies with downloading/downloaded status', async () => {
      mockSettings['plex.token'] = 'token123';
      mockSettings['watchlist.provider'] = 'plex';

      vi.mocked(getAllMovies).mockReturnValue([
        { id: 1, trakt_id: 111, tmdb_id: 111, title: 'Downloading', year: 2024, status: 'downloading' },
        { id: 2, trakt_id: 222, tmdb_id: 222, title: 'Downloaded', year: 2024, status: 'downloaded' },
      ] as any);

      mockedAxios.get.mockResolvedValueOnce({
        data: { MediaContainer: { totalSize: 0, Metadata: [] } },
      });

      await service.syncWatchlist();
      expect(deleteMovie).not.toHaveBeenCalled();
    });

    it('should NOT remove movies when provider is trakt', async () => {
      mockSettings['plex.token'] = 'token123';
      mockSettings['watchlist.provider'] = 'trakt';

      vi.mocked(getAllMovies).mockReturnValue([
        { id: 1, trakt_id: 111, tmdb_id: 111, title: 'Should Stay', year: 2024, status: 'pending' },
      ] as any);

      mockedAxios.get.mockResolvedValueOnce({
        data: { MediaContainer: { totalSize: 0, Metadata: [] } },
      });

      await service.syncWatchlist();
      expect(deleteMovie).not.toHaveBeenCalled();
    });

    it('should generate correct slug from title', async () => {
      mockSettings['plex.token'] = 'token123';

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            totalSize: 1,
            Metadata: [
              { title: 'The Matrix: Reloaded', year: 2003, ratingKey: '1', type: 'movie', Guid: [{ id: 'tmdb://604' }] },
            ],
          },
        },
      });

      await service.syncWatchlist();
      expect(addMovie).toHaveBeenCalledWith(expect.objectContaining({
        slug: 'the-matrix-reloaded',
      }));
    });
  });
});
