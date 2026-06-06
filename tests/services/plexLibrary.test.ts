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

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// We need to import the class, not the singleton, to create fresh instances
// Import as module to access the class
const PlexLibraryModule = await import('../../src/services/plexLibrary');

describe('PlexLibraryService', () => {
  let service: typeof PlexLibraryModule.plexLibraryService;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    // Use the exported singleton but clear its cache
    service = PlexLibraryModule.plexLibraryService;
    service.clearCache();
  });

  describe('isConfigured', () => {
    it('should return false when nothing is set', () => {
      expect(service.isConfigured()).toBe(false);
    });

    it('should return false when only server URL is set', () => {
      mockSettings['plex.server_url'] = 'http://192.168.1.100:32400';
      expect(service.isConfigured()).toBe(false);
    });

    it('should return true when server URL and token are set', () => {
      mockSettings['plex.server_url'] = 'http://192.168.1.100:32400';
      mockSettings['plex.token'] = 'token123';
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('testConnection', () => {
    it('should return false when not configured', async () => {
      const result = await service.testConnection();
      expect(result).toEqual({ success: false });
    });

    it('should return server info on success', async () => {
      mockSettings['plex.server_url'] = 'http://192.168.1.100:32400';
      mockSettings['plex.token'] = 'token';

      // Server root
      mockedAxios.get.mockResolvedValueOnce({
        data: { MediaContainer: { friendlyName: 'My Plex' } },
      });
      // Library sections
      mockedAxios.get.mockResolvedValueOnce({
        data: { MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie' }] } },
      });
      // Section items
      mockedAxios.get.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [{ ratingKey: '1', title: 'Movie', type: 'movie' }], totalSize: 1 } },
      });

      const result = await service.testConnection();
      expect(result.success).toBe(true);
      expect(result.serverName).toBe('My Plex');
      expect(result.movieCount).toBe(1);
    });
  });

  describe('getMovies', () => {
    it('should return empty when not configured', async () => {
      const result = await service.getMovies();
      expect(result).toEqual([]);
    });
  });

  describe('hasMovie', () => {
    it('should return false when not configured', async () => {
      const result = await service.hasMovie('tt1234567');
      expect(result).toBe(false);
    });
  });

  describe('deleteItem', () => {
    it('should return false when not configured', async () => {
      const result = await service.deleteItem('123');
      expect(result).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('should be callable without error', () => {
      expect(() => service.clearCache()).not.toThrow();
    });
  });

  // Helpers for the configured-path tests below.
  function configured() {
    mockSettings['plex.server_url'] = 'http://192.168.1.100:32400';
    mockSettings['plex.token'] = 'token';
  }
  function mockMovieLibrary(items: any[]) {
    // 1) library sections, 2) the single section's items (one page).
    mockedAxios.get.mockResolvedValueOnce({
      data: { MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie' }] } },
    });
    mockedAxios.get.mockResolvedValueOnce({
      data: { MediaContainer: { Metadata: items, totalSize: items.length } },
    });
  }

  describe('getMovies (configured)', () => {
    it('parses guids/metadata and caches the result', async () => {
      configured();
      mockMovieLibrary([
        {
          ratingKey: '10', title: 'The Matrix', year: 1999, type: 'movie',
          summary: 'A hacker learns the truth.', thumb: '/t/10',
          Guid: [{ id: 'imdb://tt0133093' }, { id: 'tmdb://603' }],
        },
      ]);

      const movies = await service.getMovies();
      expect(movies).toHaveLength(1);
      expect(movies[0]).toMatchObject({
        id: '10', name: 'The Matrix', year: 1999,
        imdbId: 'tt0133093', tmdbId: '603', mediaType: 'movie',
      });

      // Second call within the TTL is served from cache — no extra requests.
      const again = await service.getMovies();
      expect(again).toHaveLength(1);
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('hasMovie (configured)', () => {
    beforeEach(async () => {
      configured();
      mockMovieLibrary([
        {
          ratingKey: '10', title: 'The Matrix', year: 1999, type: 'movie',
          Guid: [{ id: 'imdb://tt0133093' }, { id: 'tmdb://603' }],
        },
      ]);
      await service.getMovies(); // warm the cache so hasMovie hits no network
    });

    it('matches by imdb id', async () => {
      expect(await service.hasMovie('tt0133093')).toBe(true);
    });
    it('matches by tmdb id', async () => {
      expect(await service.hasMovie(null, 603)).toBe(true);
    });
    it('matches by title + year', async () => {
      expect(await service.hasMovie(null, null, 'the matrix', 1999)).toBe(true);
    });
    it('returns false for an unknown movie', async () => {
      expect(await service.hasMovie('tt9999999', 1, 'Nope', 2000)).toBe(false);
    });
  });

  describe('deleteItem (configured)', () => {
    it('deletes and evicts from cache on success', async () => {
      configured();
      mockMovieLibrary([{ ratingKey: '10', title: 'The Matrix', year: 1999, type: 'movie', Guid: [] }]);
      await service.getMovies();

      mockedAxios.delete.mockResolvedValueOnce({});
      const ok = await service.deleteItem('10');

      expect(ok).toBe(true);
      expect(mockedAxios.delete).toHaveBeenCalledWith(
        'http://192.168.1.100:32400/library/metadata/10',
        expect.any(Object),
      );
      expect(service.getCachedMovieCount()).toBe(0);
    });

    it('returns false when the delete request fails', async () => {
      configured();
      mockedAxios.delete.mockRejectedValueOnce(new Error('500'));
      expect(await service.deleteItem('10')).toBe(false);
    });
  });

  describe('getMachineIdentifier', () => {
    it('returns null when not configured', async () => {
      expect(await service.getMachineIdentifier()).toBeNull();
    });

    it('fetches and caches the identifier', async () => {
      configured();
      mockedAxios.get.mockResolvedValueOnce({ data: { MediaContainer: { machineIdentifier: 'MID123' } } });

      expect(await service.getMachineIdentifier()).toBe('MID123');
      // Cached — a second call makes no further request.
      expect(await service.getMachineIdentifier()).toBe('MID123');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('getShowEpisodes (configured)', () => {
    it('returns the set of episode keys present for a matched show', async () => {
      configured();
      // getShowEpisodes first calls getMovies (sections + items), then allLeaves.
      mockedAxios.get.mockResolvedValueOnce({
        data: { MediaContainer: { Directory: [{ key: '2', title: 'Shows', type: 'show' }] } },
      });
      mockedAxios.get.mockResolvedValueOnce({
        data: { MediaContainer: {
          Metadata: [{ ratingKey: '50', title: 'Breaking Bad', year: 2008, type: 'show', Guid: [{ id: 'imdb://tt0903747' }] }],
          totalSize: 1,
        } },
      });
      mockedAxios.get.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [
          { parentIndex: 1, index: 1 },
          { parentIndex: 1, index: 2 },
          { parentIndex: 0, index: 5 }, // specials (parentIndex 0) ignored
        ] } },
      });

      const result = await service.getShowEpisodes('tt0903747');
      expect(result?.found).toBe(true);
      expect(result?.episodes.size).toBe(2);
    });

    it('reports found:false when the show is not in the library', async () => {
      configured();
      mockMovieLibrary([]); // empty library
      const result = await service.getShowEpisodes('tt0000000', null, 'Missing');
      expect(result).toEqual({ found: false, episodes: new Set() });
    });
  });
});
