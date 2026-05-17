import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn(() => ''),
  setSetting: vi.fn(),
  initDatabase: vi.fn(),
}));

vi.mock('../../src/database/services/movies', () => ({
  getAllMovies: vi.fn(() => []),
  getMoviesByStatus: vi.fn(() => []),
  updateMovieStatus: vi.fn(),
  incrementRetryCount: vi.fn(),
}));

vi.mock('../../src/database/services/downloads', () => ({
  getDownloadsByMovieIds: vi.fn(() => new Map()),
}));

vi.mock('../../src/database/services/activityLog', () => ({
  addLogEntry: vi.fn(),
}));

vi.mock('../../src/jdownloader/index', () => ({
  jdownloaderService: {
    isConfigured: vi.fn(() => false),
    getDownloadPackages: vi.fn(() => Promise.resolve([])),
    getLinkGrabberPackages: vi.fn(() => Promise.resolve([])),
  },
}));

vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({ isConfigured: vi.fn(() => false), hasMovie: vi.fn(() => false) })),
  getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));

vi.mock('../../src/services/trakt', () => ({
  traktService: { isConfigured: vi.fn(() => false), isAuthenticated: vi.fn(() => false) },
}));

vi.mock('../../src/services/notifications', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../../src/services/eventbus', () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock('../../src/services/scheduler', () => ({
  processingMovies: new Set<number>(),
}));

vi.mock('../../src/services/telegram', () => ({
  sendTelegramNotification: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { normalizeTitle, folderMatchesMovie, startPostProcessor, stopPostProcessor, applyRenameTemplate, pickMainMediaFile, parseSeasonEpisode } from '../../src/services/postprocess';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('PostProcessor — normalizeTitle', () => {
  it('should lowercase and strip special chars', () => {
    expect(normalizeTitle('Test Movie: The Sequel!')).toBe('test movie the sequel');
  });

  it('should convert German umlauts', () => {
    expect(normalizeTitle('Über den Dächern')).toBe('ueber den daechern');
  });

  it('should convert ß to ss', () => {
    expect(normalizeTitle('Große Straße')).toBe('grosse strasse');
  });

  it('should collapse multiple whitespace', () => {
    expect(normalizeTitle('  Hello   World  ')).toBe('hello world');
  });

  it('should handle dots from release names', () => {
    const normalized = normalizeTitle('Pretty.Lethal.Schoen.Toedlich.2026'.replace(/\./g, ' '));
    expect(normalized).toBe('pretty lethal schoen toedlich 2026');
  });
});

describe('PostProcessor — folderMatchesMovie', () => {
  it('should match folder with exact title and year', () => {
    expect(folderMatchesMovie(
      'Test.Movie.2024.1080p.WEB-DL',
      { title: 'Test Movie', year: 2024 },
      [],
    )).toBe(true);
  });

  it('should not match folder with wrong year', () => {
    expect(folderMatchesMovie(
      'Test.Movie.2023.1080p.WEB-DL',
      { title: 'Test Movie', year: 2024 },
      [],
    )).toBe(false);
  });

  it('should not match folder with missing title words', () => {
    expect(folderMatchesMovie(
      'Other.Movie.2024.1080p',
      { title: 'Test Movie', year: 2024 },
      [],
    )).toBe(false);
  });

  it('should match via release name as PRIMARY method', () => {
    expect(folderMatchesMovie(
      'Die.Unschuld.2024.GERMAN.1080p',
      { title: 'Monster', year: 2024 },
      [{ release_name: 'Die.Unschuld.2024.GERMAN.1080p.WEB-DL' }],
    )).toBe(true);
  });

  it('should match exact release name prefix', () => {
    expect(folderMatchesMovie(
      'Pretty.Lethal.Schoen.Toedlich.2026.GERMAN.1080p.WEB-DL',
      { title: 'Pretty Lethal', year: 2026 },
      [{ release_name: 'Pretty.Lethal.Schoen.Toedlich.2026.GERMAN.1080p.WEB-DL.x264' }],
    )).toBe(true);
  });

  it('should match when folder is a truncated release name', () => {
    expect(folderMatchesMovie(
      'Some.Long.Release.Name.2024',
      { title: 'Totally Different Title', year: 2024 },
      [{ release_name: 'Some.Long.Release.Name.2024.GERMAN.1080p.WEB-DL' }],
    )).toBe(true);
  });

  it('should NOT match release name from a DIFFERENT movie', () => {
    expect(folderMatchesMovie(
      'Love.Actually.2003.GERMAN.1080p',
      { title: 'Love Story', year: 1970 },
      [{ release_name: 'Love.Story.1970.GERMAN.1080p.WEB-DL' }],
    )).toBe(false);
  });

  it('should prefer release name match over ambiguous title match', () => {
    expect(folderMatchesMovie(
      'Der.Film.The.Movie.2024.GERMAN.1080p',
      { title: 'The Movie', year: 2024 },
      [{ release_name: 'Der.Film.The.Movie.2024.GERMAN.1080p.WEB-DL' }],
    )).toBe(true);
  });

  it('should match when movie has no year (year=null)', () => {
    expect(folderMatchesMovie(
      'Test.Movie.1080p.WEB-DL',
      { title: 'Test Movie', year: null },
      [],
    )).toBe(true);
  });

  it('should handle German umlauts in folder names', () => {
    expect(folderMatchesMovie(
      'Schoene.Bescherung.2024.GERMAN.1080p',
      { title: 'Schöne Bescherung', year: 2024 },
      [],
    )).toBe(true);
  });

  it('should not match short title "IT" against "ITEM.2026"', () => {
    expect(folderMatchesMovie(
      'ITEM.2026.1080p',
      { title: 'IT', year: 2026 },
      [],
    )).toBe(false);
  });

  it('should match short title "IT" with exact word boundary and year', () => {
    expect(folderMatchesMovie(
      'IT.2017.GERMAN.1080p.WEB-DL',
      { title: 'IT', year: 2017 },
      [],
    )).toBe(true);
  });
});

describe('PostProcessor — start/stop', () => {
  it('should export start and stop functions', () => {
    expect(typeof startPostProcessor).toBe('function');
    expect(typeof stopPostProcessor).toBe('function');
  });
});

describe('PostProcessor — applyRenameTemplate', () => {
  it('pads {season} to 2 digits', () => {
    expect(applyRenameTemplate('S{season}', { title: 'X', year: null, season: 1 })).toBe('S01');
    expect(applyRenameTemplate('S{season}', { title: 'X', year: null, season: 12 })).toBe('S12');
  });

  it('pads {episode} to 2 digits', () => {
    expect(applyRenameTemplate('E{episode}', { title: 'X', year: null, episode: 3 })).toBe('E03');
  });

  it('renders flat movie file name', () => {
    expect(applyRenameTemplate('{title} ({year})', { title: 'Pretty Lethal', year: 2026 }))
      .toBe('Pretty Lethal (2026)');
  });

  it('renders series file with season + episode', () => {
    expect(applyRenameTemplate('{title} S{season}E{episode}', {
      title: 'Scrubs', year: 2001, season: 1, episode: 3,
    })).toBe('Scrubs S01E03');
  });

  it('strips path traversal from title', () => {
    expect(applyRenameTemplate('{title}', { title: '../etc/passwd', year: null }))
      .toBe('. etc passwd');
  });
});

describe('PostProcessor — parseSeasonEpisode', () => {
  it('parses standard SxxExx', () => {
    expect(parseSeasonEpisode('Scrubs.S01E03.GERMAN.1080p')).toEqual({ season: 1, episode: 3 });
  });

  it('parses 1-digit season + 1-digit episode', () => {
    expect(parseSeasonEpisode('Show S1E5 release')).toEqual({ season: 1, episode: 5 });
  });

  it('returns episode null for season-only folder', () => {
    const r = parseSeasonEpisode('Show.S02.GERMAN.COMPLETE');
    expect(r.season).toBe(2);
    expect(r.episode).toBeNull();
  });

  it('returns nulls when nothing matches', () => {
    expect(parseSeasonEpisode('random.folder.name')).toEqual({ season: null, episode: null });
  });
});

describe('PostProcessor — pickMainMediaFile', () => {
  function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-test-'));
  }

  it('returns the largest media file above the threshold', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'sample.mkv'), Buffer.alloc(50 * 1024 * 1024)); // 50MB junk
      fs.writeFileSync(path.join(dir, 'movie.mkv'), Buffer.alloc(400 * 1024 * 1024)); // 400MB main
      fs.writeFileSync(path.join(dir, 'extra.mkv'), Buffer.alloc(310 * 1024 * 1024)); // 310MB smaller
      const main = pickMainMediaFile(dir, 300);
      expect(main).toBe(path.join(dir, 'movie.mkv'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-media files', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'huge.nfo'), Buffer.alloc(500 * 1024 * 1024));
      fs.writeFileSync(path.join(dir, 'movie.mkv'), Buffer.alloc(400 * 1024 * 1024));
      expect(pickMainMediaFile(dir, 300)).toBe(path.join(dir, 'movie.mkv'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans one level of subdirectories', () => {
    const dir = makeTempDir();
    try {
      const sub = path.join(dir, 'release');
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, 'movie.mp4'), Buffer.alloc(400 * 1024 * 1024));
      expect(pickMainMediaFile(dir, 300)).toBe(path.join(sub, 'movie.mp4'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when nothing meets the threshold', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'tiny.mkv'), Buffer.alloc(10 * 1024 * 1024));
      expect(pickMainMediaFile(dir, 300)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
