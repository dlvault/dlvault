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

import { JellyfinService } from '../../src/services/jellyfin';

describe('JellyfinService', () => {
  let service: JellyfinService;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    service = new JellyfinService();
  });

  describe('isConfigured', () => {
    it('should return false when nothing is set', () => {
      expect(service.isConfigured()).toBe(false);
    });

    it('should return false when only URL is set', () => {
      mockSettings['jellyfin.url'] = 'http://localhost:8096';
      expect(service.isConfigured()).toBe(false);
    });

    it('should return true when both URL and API key are set', () => {
      mockSettings['jellyfin.url'] = 'http://localhost:8096';
      mockSettings['jellyfin.api_key'] = 'api-key-123';
      expect(service.isConfigured()).toBe(true);
    });

    it('should strip trailing slashes from URL', () => {
      mockSettings['jellyfin.url'] = 'http://localhost:8096///';
      mockSettings['jellyfin.api_key'] = 'key';
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('testConnection', () => {
    it('should return false when not configured', async () => {
      const result = await service.testConnection();
      expect(result).toEqual({ success: false });
    });

    it('should test connection and return server info', async () => {
      mockSettings['jellyfin.url'] = 'http://localhost:8096';
      mockSettings['jellyfin.api_key'] = 'key';

      // System/Info call
      mockedAxios.get.mockResolvedValueOnce({
        data: { ServerName: 'My Jellyfin' },
      });
      // Users call (for getUserId)
      mockedAxios.get.mockResolvedValueOnce({
        data: [{ Id: 'user1', Name: 'Admin', Policy: { IsAdministrator: true } }],
      });
      // Items call (fetchMovies)
      mockedAxios.get.mockResolvedValueOnce({
        data: { Items: [{ Id: '1', Name: 'Movie 1', Type: 'Movie' }] },
      });

      const result = await service.testConnection();
      expect(result.success).toBe(true);
      expect(result.serverName).toBe('My Jellyfin');
      expect(result.movieCount).toBe(1);
    });

    it('should return false on connection error', async () => {
      mockSettings['jellyfin.url'] = 'http://localhost:8096';
      mockSettings['jellyfin.api_key'] = 'key';

      mockedAxios.get.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await service.testConnection();
      expect(result).toEqual({ success: false });
    });
  });

  describe('getMovies', () => {
    it('should return empty array when not configured', async () => {
      const result = await service.getMovies();
      expect(result).toEqual([]);
    });

    it('should fetch and cache movies', async () => {
      mockSettings['jellyfin.url'] = 'http://localhost:8096';
      mockSettings['jellyfin.api_key'] = 'key';

      // getUserId
      mockedAxios.get.mockResolvedValueOnce({
        data: [{ Id: 'u1', Name: 'Admin', Policy: { IsAdministrator: true } }],
      });
      // fetchMovies
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          Items: [
            {
              Id: 'm1',
              Name: 'Test Movie',
              ProductionYear: 2024,
              ProviderIds: { Imdb: 'tt1234567', Tmdb: '555' },
              Overview: 'A great movie',
              Type: 'Movie',
              ImageTags: { Primary: 'tag1' },
              DateCreated: '2024-03-15T10:30:00.0000000Z',
            },
            {
              Id: 's1',
              Name: 'Test Show',
              ProductionYear: 2023,
              Type: 'Series',
            },
          ],
        },
      });

      const movies = await service.getMovies();

      expect(movies).toHaveLength(2);
      expect(movies[0]).toEqual({
        id: 'm1',
        name: 'Test Movie',
        year: 2024,
        imdbId: 'tt1234567',
        tmdbId: '555',
        overview: 'A great movie',
        mediaType: 'movie',
        imageTag: 'tag1',
        addedAt: '2024-03-15T10:30:00',
      });
      expect(movies[1].mediaType).toBe('show');
      // Item without DateCreated → addedAt null (provider gave no timestamp).
      expect(movies[1].addedAt).toBeNull();
    });
  });

  describe('hasMovie', () => {
    it('should return false when not configured', async () => {
      const result = await service.hasMovie('tt1234567');
      expect(result).toBe(false);
    });

    it('should match by IMDb ID', async () => {
      mockSettings['jellyfin.url'] = 'http://localhost:8096';
      mockSettings['jellyfin.api_key'] = 'key';

      // Populate cache
      mockedAxios.get.mockResolvedValueOnce({
        data: [{ Id: 'u1', Name: 'Admin', Policy: { IsAdministrator: true } }],
      });
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          Items: [{
            Id: 'm1', Name: 'Movie', ProductionYear: 2024,
            ProviderIds: { Imdb: 'tt1234567', Tmdb: '100' },
            Type: 'Movie',
          }],
        },
      });

      const result = await service.hasMovie('tt1234567');
      expect(result).toBe(true);
    });

    it('should match by TMDb ID', async () => {
      mockSettings['jellyfin.url'] = 'http://localhost:8096';
      mockSettings['jellyfin.api_key'] = 'key';

      mockedAxios.get.mockResolvedValueOnce({
        data: [{ Id: 'u1', Name: 'Admin', Policy: { IsAdministrator: true } }],
      });
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          Items: [{
            Id: 'm1', Name: 'Movie', ProductionYear: 2024,
            ProviderIds: { Tmdb: '555' },
            Type: 'Movie',
          }],
        },
      });

      const result = await service.hasMovie(null, 555);
      expect(result).toBe(true);
    });

    it('should match by title + year', async () => {
      mockSettings['jellyfin.url'] = 'http://localhost:8096';
      mockSettings['jellyfin.api_key'] = 'key';

      mockedAxios.get.mockResolvedValueOnce({
        data: [{ Id: 'u1', Name: 'Admin', Policy: { IsAdministrator: true } }],
      });
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          Items: [{
            Id: 'm1', Name: 'The Matrix', ProductionYear: 1999,
            Type: 'Movie',
          }],
        },
      });

      const result = await service.hasMovie(null, null, 'The Matrix', 1999);
      expect(result).toBe(true);
    });

    it('should return false when movie not in library', async () => {
      mockSettings['jellyfin.url'] = 'http://localhost:8096';
      mockSettings['jellyfin.api_key'] = 'key';

      mockedAxios.get.mockResolvedValueOnce({ data: [{ Id: 'u1', Name: 'Admin', Policy: { IsAdministrator: true } }] });
      mockedAxios.get.mockResolvedValueOnce({ data: { Items: [] } });

      const result = await service.hasMovie('tt9999999');
      expect(result).toBe(false);
    });
  });

  describe('deleteItem', () => {
    it('should return false when not configured', async () => {
      const result = await service.deleteItem('m1');
      expect(result).toBe(false);
    });

    it('should delete item and update cache', async () => {
      mockSettings['jellyfin.url'] = 'http://localhost:8096';
      mockSettings['jellyfin.api_key'] = 'key';

      // Populate cache first
      mockedAxios.get.mockResolvedValueOnce({
        data: [{ Id: 'u1', Name: 'Admin', Policy: { IsAdministrator: true } }],
      });
      mockedAxios.get.mockResolvedValueOnce({
        data: { Items: [{ Id: 'm1', Name: 'Movie', Type: 'Movie' }] },
      });
      await service.getMovies();

      // Delete
      mockedAxios.delete.mockResolvedValueOnce({ data: {} });
      const result = await service.deleteItem('m1');

      expect(result).toBe(true);
      // Cache should be empty now
      const movies = await service.getMovies();
      expect(movies).toHaveLength(0);
    });
  });

  describe('clearCache', () => {
    it('should reset all cache state', async () => {
      mockSettings['jellyfin.url'] = 'http://localhost:8096';
      mockSettings['jellyfin.api_key'] = 'key';

      // Populate cache
      mockedAxios.get.mockResolvedValueOnce({
        data: [{ Id: 'u1', Name: 'Admin', Policy: { IsAdministrator: true } }],
      });
      mockedAxios.get.mockResolvedValueOnce({
        data: { Items: [{ Id: 'm1', Name: 'Movie', Type: 'Movie' }] },
      });
      await service.getMovies();

      service.clearCache();

      // After clear, should make a new API call
      mockedAxios.get.mockResolvedValueOnce({
        data: [{ Id: 'u1', Name: 'Admin', Policy: { IsAdministrator: true } }],
      });
      mockedAxios.get.mockResolvedValueOnce({ data: { Items: [] } });

      const result = await service.getMovies();
      expect(result).toEqual([]);
      // Two new GET calls (users + items)
      expect(mockedAxios.get).toHaveBeenCalledTimes(4);
    });
  });
});
