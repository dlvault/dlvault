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
});
