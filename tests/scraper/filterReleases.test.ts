import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/index', () => {
  const settings: Record<string, string> = {
    'quality.minimum': '1080p',
    'quality.maximum': '2160p',
    'quality.audio_minimum': '5.1',
    'quality.exclude_types': 'complete,remux',
    'quality.language': 'german',
    'hosters.enabled': 'example-host',
  };
  return {
    getSetting: (key: string) => settings[key] || '',
    setSetting: vi.fn(),
    getAllSettings: () => ({ ...settings }),
    initDatabase: vi.fn(),
    invalidateSettingsCache: vi.fn(),
  };
});

import { filterReleases } from '../../src/scraper/filter';
import type { ScrapedRelease } from '../../src/scraper/constants';

function makeRelease(overrides: Partial<ScrapedRelease> = {}): ScrapedRelease {
  return {
    title: 'Test Release',
    quality: '1080p',
    audio: '5.1',
    language: 'german',
    size: '8 GB',
    releaseType: 'rip',
    isDolbyVision: false,
    season: null,
    episode: null,
    isSeasonPack: false,
    links: [{ hoster: 'example-host', url: 'https://example.org/file/abc' }],
    ...overrides,
  };
}

describe('filterReleases', () => {
  it('should accept releases matching quality and audio requirements', () => {
    expect(filterReleases([makeRelease({ quality: '1080p', audio: '5.1' })])).toHaveLength(1);
  });

  it('should reject releases below minimum quality', () => {
    expect(filterReleases([makeRelease({ quality: '720p' })])).toHaveLength(0);
  });

  it('should reject releases below minimum audio', () => {
    expect(filterReleases([makeRelease({ audio: '2.0' })])).toHaveLength(0);
  });

  it('should accept unknown audio when minimum audio is set', () => {
    // filterReleases intentionally treats 'unknown' audio (not detected in the
    // release title) as passing — otherwise releases where the audio codec
    // isn't in the filename get incorrectly rejected.
    expect(filterReleases([makeRelease({ audio: 'unknown' })])).toHaveLength(1);
  });

  it('should reject excluded release types', () => {
    expect(filterReleases([
      makeRelease({ releaseType: 'complete' }),
      makeRelease({ releaseType: 'remux' }),
    ])).toHaveLength(0);
  });

  it('should accept non-excluded release types', () => {
    expect(filterReleases([makeRelease({ releaseType: 'rip' })])).toHaveLength(1);
  });

  it('should reject releases without links', () => {
    expect(filterReleases([makeRelease({ links: [] })])).toHaveLength(0);
  });

  it('should sort by quality descending, then audio descending', () => {
    const result = filterReleases([
      makeRelease({ title: 'A', quality: '1080p', audio: '5.1' }),
      makeRelease({ title: 'B', quality: '2160p', audio: '7.1' }),
      makeRelease({ title: 'C', quality: '2160p', audio: '5.1' }),
    ]);
    expect(result.map(r => r.title)).toEqual(['B', 'C', 'A']);
  });

  it('should accept 2160p (within max range)', () => {
    expect(filterReleases([makeRelease({ quality: '2160p', audio: '7.1' })])).toHaveLength(1);
  });

  it('should reject non-german language', () => {
    expect(filterReleases([makeRelease({ language: 'english' })])).toHaveLength(0);
  });

  it('should accept unknown language (passes filter)', () => {
    expect(filterReleases([makeRelease({ language: 'unknown' })])).toHaveLength(1);
  });

  it('should handle empty input', () => {
    expect(filterReleases([])).toEqual([]);
  });

  it('should filter mixed releases correctly', () => {
    const result = filterReleases([
      makeRelease({ title: 'Good', quality: '1080p', audio: '5.1' }),
      makeRelease({ title: 'Too Low', quality: '480p', audio: '5.1' }),
      makeRelease({ title: 'Excluded', quality: '1080p', audio: '5.1', releaseType: 'remux' }),
      makeRelease({ title: 'No Links', quality: '1080p', audio: '5.1', links: [] }),
      makeRelease({ title: 'Bad Audio', quality: '1080p', audio: '2.0' }),
      makeRelease({ title: 'Also Good', quality: '2160p', audio: '7.1' }),
    ]);
    expect(result.map(r => r.title)).toEqual(['Also Good', 'Good']);
  });
});
