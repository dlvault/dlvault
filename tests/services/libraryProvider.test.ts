import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSettings: Record<string, string> = {};

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
  setSetting: vi.fn(),
  initDatabase: vi.fn(),
}));

vi.mock('../../src/services/jellyfin', () => ({
  jellyfinService: { name: 'jellyfin', isConfigured: () => true },
}));

vi.mock('../../src/services/plexLibrary', () => ({
  plexLibraryService: { name: 'plex', isConfigured: () => true },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getLibraryProvider, getLibraryProviderType, getLibraryProviderName } from '../../src/services/libraryProvider';

describe('LibraryProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
  });

  describe('getLibraryProviderType', () => {
    it('should default to jellyfin', () => {
      expect(getLibraryProviderType()).toBe('jellyfin');
    });

    it('should return plex when configured', () => {
      mockSettings['library.provider'] = 'plex';
      expect(getLibraryProviderType()).toBe('plex');
    });
  });

  describe('getLibraryProvider', () => {
    it('should return jellyfin service by default', () => {
      const provider = getLibraryProvider();
      expect((provider as any).name).toBe('jellyfin');
    });

    it('should return plex service when configured', () => {
      mockSettings['library.provider'] = 'plex';
      const provider = getLibraryProvider();
      expect((provider as any).name).toBe('plex');
    });
  });

  describe('getLibraryProviderName', () => {
    it('should return Jellyfin by default', () => {
      expect(getLibraryProviderName()).toBe('Jellyfin');
    });

    it('should return Plex when configured', () => {
      mockSettings['library.provider'] = 'plex';
      expect(getLibraryProviderName()).toBe('Plex');
    });
  });
});
