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

import { getLibraryProvider, getLibraryProviderType, getLibraryProviderName, videoQualityFromDimensions, videoQualityFromPlexResolution } from '../../src/services/libraryProvider';

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

describe('videoQualityFromDimensions', () => {
  it('grades by width, tolerating scope/letterbox height crops', () => {
    expect(videoQualityFromDimensions(3840, 2160)).toBe('4K');
    expect(videoQualityFromDimensions(3840, 1608)).toBe('4K');   // 2.39:1 crop
    expect(videoQualityFromDimensions(1920, 1080)).toBe('1080p');
    expect(videoQualityFromDimensions(1920, 800)).toBe('1080p'); // 2.39:1 crop
    expect(videoQualityFromDimensions(1280, 720)).toBe('720p');
    expect(videoQualityFromDimensions(720, 576)).toBe('SD');
  });

  it('falls back to height when width is missing', () => {
    expect(videoQualityFromDimensions(null, 2160)).toBe('4K');
    expect(videoQualityFromDimensions(undefined, 1080)).toBe('1080p');
    expect(videoQualityFromDimensions(0, 720)).toBe('720p');
    expect(videoQualityFromDimensions(null, 480)).toBe('SD');
  });

  it('returns null without any dimensions', () => {
    expect(videoQualityFromDimensions(null, null)).toBeNull();
    expect(videoQualityFromDimensions(0, 0)).toBeNull();
    expect(videoQualityFromDimensions(undefined, undefined)).toBeNull();
  });
});

describe('videoQualityFromPlexResolution', () => {
  it('maps Plex resolution tags to canonical labels', () => {
    expect(videoQualityFromPlexResolution('4k')).toBe('4K');
    expect(videoQualityFromPlexResolution('2160')).toBe('4K');
    expect(videoQualityFromPlexResolution('1080')).toBe('1080p');
    expect(videoQualityFromPlexResolution(1080)).toBe('1080p'); // Plex sends numbers too
    expect(videoQualityFromPlexResolution('720')).toBe('720p');
    expect(videoQualityFromPlexResolution('sd')).toBe('SD');
    expect(videoQualityFromPlexResolution('480')).toBe('SD');
  });

  it('returns null for missing input', () => {
    expect(videoQualityFromPlexResolution(null)).toBeNull();
    expect(videoQualityFromPlexResolution(undefined)).toBeNull();
    expect(videoQualityFromPlexResolution('')).toBeNull();
  });
});
