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
const { plexExternalIds } = await import('../../src/services/libraryProvider');

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
          ratingKey: '10', title: 'The Velmora', year: 1999, type: 'movie',
          summary: 'A hacker learns the truth.', thumb: '/t/10',
          Guid: [{ id: 'imdb://tt9100133' }, { id: 'tmdb://603' }],
          Media: [{ videoResolution: '4k' }],
        },
      ]);

      const movies = await service.getMovies();
      expect(movies).toHaveLength(1);
      expect(movies[0]).toMatchObject({
        id: '10', name: 'The Velmora', year: 1999,
        imdbId: 'tt9100133', tmdbId: '603', mediaType: 'movie',
        videoQuality: '4K',
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
          ratingKey: '10', title: 'The Velmora', year: 1999, type: 'movie',
          Guid: [{ id: 'imdb://tt9100133' }, { id: 'tmdb://603' }],
        },
      ]);
      await service.getMovies(); // warm the cache so hasMovie hits no network
    });

    it('matches by imdb id', async () => {
      expect(await service.hasMovie('tt9100133')).toBe(true);
    });
    it('matches by tmdb id', async () => {
      expect(await service.hasMovie(null, 603)).toBe(true);
    });
    it('matches by title + year', async () => {
      expect(await service.hasMovie(null, null, 'the velmora', 1999)).toBe(true);
    });
    it('returns false for an unknown movie', async () => {
      expect(await service.hasMovie('tt9999999', 1, 'Nope', 2000)).toBe(false);
    });
  });

  describe('hasMovie when Plex misidentified the file', () => {
    beforeEach(async () => {
      configured();
      mockMovieLibrary([
        {
          // Plex matched "Quillon (2026).mkv" to a different film entirely.
          ratingKey: '11', title: 'The Quillon Affair', year: 1988, type: 'movie',
          Guid: [{ id: 'imdb://tt9100777' }],
          Media: [{ videoResolution: '1080', Part: [{ file: '/data/Filme/Quillon (2026).mkv' }] }],
        },
        {
          ratingKey: '12', title: 'Something Else', year: 2001, type: 'movie',
          Media: [{ Part: [{ file: '/data/Filme/Wardline.2024.German.DL.1080p.WEB.x264-GRP/wardline-1080p.mkv' }] }],
        },
      ]);
      await service.getMovies();
    });

    it('still finds the film by the name dlvault gave its file or folder', async () => {
      // Without this a Seerr request for a film already on disk was downloaded again.
      expect(await service.hasMovie('tt9100555', 555, 'Quillon', 2026)).toBe(true);
      expect(await service.hasMovie(null, null, 'Wardline', 2024)).toBe(true);
    });

    it('does not match another year or a longer title', async () => {
      expect(await service.hasMovie(null, null, 'Quillon', 2025)).toBe(false);
      expect(await service.hasMovie(null, null, 'Quill', 2026)).toBe(false);
    });
  });

  describe('deleteItem (configured)', () => {
    it('deletes and evicts from cache on success', async () => {
      configured();
      mockMovieLibrary([{ ratingKey: '10', title: 'The Velmora', year: 1999, type: 'movie', Guid: [] }]);
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
          Metadata: [{ ratingKey: '50', title: 'Salt Ledger', year: 2008, type: 'show', Guid: [{ id: 'imdb://tt9100903' }] }],
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

      const result = await service.getShowEpisodes('tt9100903');
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

describe('PlexLibraryService — audit fixes', () => {
  const service = PlexLibraryModule.plexLibraryService;
  type Item = Record<string, any>;
  let sections: { key: string; type: string; title: string }[];
  let items: Record<string, Item[]>;
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings['plex.server_url'] = 'http://plex:32400';
    mockSettings['plex.token'] = 't';
    service.clearCache();
    sections = [{ key: '1', type: 'movie', title: 'Filme' }, { key: '2', type: 'show', title: 'Serien' }];
    items = { '1': [], '2': [] };
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/library/sections')) return { data: { MediaContainer: { Directory: sections } } };
      const m = url.match(/sections\/(\d+)\/all$/);
      if (m) return { data: { MediaContainer: { Metadata: items[m[1]], totalSize: items[m[1]].length } } };
      if (/sections\/\d+\/refresh$/.test(url)) return { data: {} };
      if (url.endsWith('/library/metadata/21/allLeaves')) {
        return { data: { MediaContainer: { Metadata: [{ parentIndex: 1, index: 1 }, { parentIndex: 1, index: 2 }] } } };
      }
      throw new Error(`unexpected ${url}`);
    });
  });

  it('reads ids from legacy agents and TVDB ids', () => {
    const ids = plexExternalIds;
    expect(ids({ guid: 'com.plexapp.agents.imdb://tt9100133?lang=de' })).toEqual({ imdbId: 'tt9100133', tmdbId: null, tvdbId: null });
    expect(ids({ guid: 'com.plexapp.agents.themoviedb://603?lang=de' }).tmdbId).toBe('603');
    expect(ids({ guid: 'com.plexapp.agents.thetvdb://121361/1/1?lang=de' }).tvdbId).toBe('121361');
    expect(ids({ Guid: [{ id: 'imdb://tt1' }, { id: 'tmdb://2' }, { id: 'tvdb://3' }] })).toEqual({ imdbId: 'tt1', tmdbId: '2', tvdbId: '3' });
    expect(ids({ guid: 'plex://movie/5d776' })).toEqual({ imdbId: null, tmdbId: null, tvdbId: null });
  });

  it('finds a film in a legacy-agent library by IMDb id although the titles differ', async () => {
    items['1'] = [{ ratingKey: '10', title: 'Der Lichtfänger', year: 2018, type: 'movie', guid: 'com.plexapp.agents.imdb://tt9900123?lang=de' }];
    expect(await service.hasMovie('tt9900123', null, 'Lanternfall', 2018)).toBe(true);
  });

  it('treats a server without visible sections as unknown, not as an empty library', async () => {
    sections = [];
    expect(await service.hasMovie('tt0000001', null, 'Grell', 2024)).toBeNull();
  });

  it('keeps the cache when an answer suddenly shrinks to a fraction', async () => {
    items['1'] = Array.from({ length: 40 }, (_, i) => ({ ratingKey: String(i), title: `Film ${i}`, year: 2000, type: 'movie', Guid: [{ id: `imdb://tt${i}` }] }));
    expect(await service.hasMovie('tt5', null)).toBe(true);
    items['1'] = items['1'].slice(0, 3);
    await service.getMovies(true);
    expect(await service.hasMovie('tt5', null)).toBe(true);
  });

  it('takes the smaller library once three answers in a row agree', async () => {
    items['1'] = Array.from({ length: 40 }, (_, i) => ({ ratingKey: String(i), title: `Film ${i}`, year: 2000, type: 'movie', Guid: [{ id: `imdb://tt${i}` }] }));
    await service.getMovies(true);
    items['1'] = items['1'].slice(0, 3);
    await service.getMovies(true);
    await service.getMovies(true);
    expect(await service.hasMovie('tt5', null)).toBe(true);   // two: still held
    await service.getMovies(true);
    expect(await service.hasMovie('tt5', null)).toBe(false);  // third: real
    expect(await service.hasMovie('tt1', null)).toBe(true);
  });

  it('does not let a same-named series from another year count as present', async () => {
    items['2'] = [{ ratingKey: '20', title: 'Wardline', year: 1980, type: 'show' }];
    const r = await service.getShowEpisodes(null, null, 'Wardline', 2024);
    expect(r).toEqual({ found: false, episodes: new Set() });
  });

  it('finds a series by its TVDB id', async () => {
    items['2'] = [{ ratingKey: '21', title: 'Sandmere – Die Serie', year: 2023, type: 'show', Guid: [{ id: 'tvdb://4242' }] }];
    const r = await service.getShowEpisodes(null, null, 'Sandmere', 2023, 4242);
    expect(r?.found).toBe(true);
    expect([...r!.episodes]).toEqual(['S01E01', 'S01E02']);
  });

  it('reports films the account watched or started, from the listing', async () => {
    items['1'] = [
      { ratingKey: '1', title: 'Grell', year: 2024, type: 'movie', Guid: [{ id: 'imdb://tt9000001' }], viewCount: 1 },
      { ratingKey: '2', title: 'Sandmere', year: 2023, type: 'movie', viewOffset: 120000 },
      { ratingKey: '3', title: 'Wardline', year: 2022, type: 'movie', lastViewedAt: 1700000000 },
      { ratingKey: '4', title: 'Lanternfall', year: 2021, type: 'movie' },
    ];
    items['2'] = [{ ratingKey: '9', title: 'Quillon', year: 2020, type: 'show', viewCount: 3 }];
    const w = await service.getWatchedMovies();
    expect(w?.map(x => x.name)).toEqual(['Grell', 'Sandmere', 'Wardline']);
    expect(w?.[0].imdbId).toBe('tt9000001');
  });

  it('also counts films another account played, from the play history', async () => {
    items['1'] = [
      { ratingKey: '1', title: 'Grell', year: 2024, type: 'movie', viewCount: 1 },
      { ratingKey: '2', title: 'Sandmere', year: 2023, type: 'movie' },
      { ratingKey: '3', title: 'Wardline', year: 2022, type: 'movie' },
    ];
    const base = mockedAxios.get.getMockImplementation()!;
    mockedAxios.get.mockImplementation(async (url: string, cfg?: any) => {
      if (url.endsWith('/status/sessions/history/all')) {
        return { data: { MediaContainer: { Metadata: [{ ratingKey: '2', type: 'movie' }, { ratingKey: '9', type: 'episode' }] } } };
      }
      return base(url, cfg);
    });
    const w = await service.getWatchedMovies();
    expect(w?.map(x => x.name)).toEqual(['Grell', 'Sandmere']);
  });

  it('answers null for watched films when Plex shows no sections', async () => {
    sections = [];
    expect(await service.getWatchedMovies()).toBeNull();
  });

  it('asks every section to rescan', async () => {
    expect(await service.refreshLibrary()).toBe(true);
    const calls = mockedAxios.get.mock.calls.map(c => c[0]).filter(u => String(u).endsWith('/refresh'));
    expect(calls).toEqual(['http://plex:32400/library/sections/1/refresh', 'http://plex:32400/library/sections/2/refresh']);
  });
});
