import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/index', () => {
  const settings: Record<string, string> = {
    'quality.minimum': '1080p',
    'quality.maximum': '2160p',
    'quality.audio_minimum': '5.1',
    'quality.exclude_types': 'complete,remux',
    'quality.language': 'german',
    'hosters.enabled': 'example-host',
    // Series override: looser resolution floor (720p) and no audio floor.
    'quality.series_override': 'true',
    'quality.series_minimum': '720p',
    'quality.series_maximum': '2160p',
    'quality.series_audio_minimum': '',
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

  it('filters by the configured language (default german) but always allows unknown', () => {
    // quality.language is 'german' in the mock — a foreign-language release is
    // rejected, an unstated ('unknown') one passes.
    expect(filterReleases([makeRelease({ language: 'english' })])).toHaveLength(0);
    expect(filterReleases([makeRelease({ language: 'unknown' })])).toHaveLength(1);
    expect(filterReleases([makeRelease({ language: 'german' })])).toHaveLength(1);
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

  it('should prefer the larger file at equal quality and audio', () => {
    const result = filterReleases([
      makeRelease({ title: 'Small', quality: '1080p', audio: '5.1', size: '13.6 GB' }),
      makeRelease({ title: 'Large', quality: '1080p', audio: '5.1', size: '25.2 GB' }),
      makeRelease({ title: 'Mid', quality: '1080p', audio: '5.1', size: '21.9 GB' }),
    ]);
    expect(result.map(r => r.title)).toEqual(['Large', 'Mid', 'Small']);
  });

  it('size never outranks resolution or audio', () => {
    const result = filterReleases([
      makeRelease({ title: 'Huge 1080p', quality: '1080p', audio: '5.1', size: '90 GB' }),
      makeRelease({ title: 'Small 2160p', quality: '2160p', audio: '5.1', size: '8 GB' }),
      makeRelease({ title: 'Huge 5.1', quality: '2160p', audio: '5.1', size: '80 GB' }),
      makeRelease({ title: 'Small 7.1', quality: '2160p', audio: '7.1', size: '8 GB' }),
    ]);
    // 2160p before 1080p; within 2160p, 7.1 before 5.1; size only breaks the
    // remaining 2160p/5.1 tie.
    expect(result.map(r => r.title)).toEqual(['Small 7.1', 'Huge 5.1', 'Small 2160p', 'Huge 1080p']);
  });

  it('places releases with an unparseable size last on the size tiebreaker', () => {
    const result = filterReleases([
      makeRelease({ title: 'No Size', quality: '1080p', audio: '5.1', size: '' }),
      makeRelease({ title: 'Known', quality: '1080p', audio: '5.1', size: '10 GB' }),
    ]);
    expect(result.map(r => r.title)).toEqual(['Known', 'No Size']);
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

  // When quality.series_override is on, shows use the series_* thresholds while
  // movies keep the global ones. Movie behaviour is the default (no mediaType arg).
  describe('series override', () => {
    it('rejects a 720p release for movies (global floor 1080p)', () => {
      expect(filterReleases([makeRelease({ quality: '720p' })], 'movie')).toHaveLength(0);
    });

    it('accepts the same 720p release for shows (series floor 720p)', () => {
      expect(filterReleases([makeRelease({ quality: '720p' })], 'show')).toHaveLength(1);
    });

    it('accepts low audio for shows (no series audio floor) but rejects it for movies', () => {
      expect(filterReleases([makeRelease({ audio: '2.0' })], 'show')).toHaveLength(1);
      expect(filterReleases([makeRelease({ audio: '2.0' })], 'movie')).toHaveLength(0);
    });

    it('still applies the global excluded release-types to shows', () => {
      expect(filterReleases([makeRelease({ releaseType: 'remux' })], 'show')).toHaveLength(0);
    });

    it('defaults to movie behaviour when no media type is passed', () => {
      expect(filterReleases([makeRelease({ quality: '720p' })])).toHaveLength(0);
    });
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
