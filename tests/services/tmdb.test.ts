import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockSettings: Record<string, string> = {};
vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] ?? ''),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { TmdbService } from '../../src/services/tmdb';

/**
 * Shapes taken from TMDb's API reference — everything is snake_case, and the
 * field carrying the title differs between films and shows.
 */
const searchBody = {
  page: 1,
  total_results: 3,
  results: [
    { id: 603, media_type: 'movie', title: 'Velmora', release_date: '1999-03-30', poster_path: '/abc.jpg' },
    { id: 1399, media_type: 'tv', name: 'Crown of Embers', first_air_date: '2011-04-17', poster_path: '/def.jpg' },
    // Multi-search and trending both mix people in.
    { id: 287, media_type: 'person', name: 'Mara Lind', profile_path: '/p.jpg' },
  ],
};

describe('TMDb as catalog source', () => {
  let service: TmdbService;
  let get: any;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    mockSettings['tmdb.api_key'] = 'plain-key-123';
    get = vi.fn(async (url: string) => {
      if (url === '/search/multi') return { data: searchBody };
      if (url === '/trending/all/week') return { data: searchBody };
      if (url === '/configuration') return { data: { images: {} } };
      throw new Error(`unexpected ${url}`);
    });
    mockedAxios.create.mockReturnValue({ get: (...a: any[]) => get(...a) } as any);
    service = new TmdbService();
  });

  describe('credentials', () => {
    it('sends a plain key as a query parameter', async () => {
      await service.searchCatalog('velmora', { types: ['movie'] });
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ params: { api_key: 'plain-key-123' } }));
    });

    it('sends a read access token as a Bearer header instead', async () => {
      // TMDb shows both credentials side by side and they are not
      // interchangeable in how they travel; pasting the wrong one is the obvious
      // mistake, so accept either.
      mockSettings['tmdb.api_key'] = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ4In0.sig';
      service = new TmdbService();
      await service.searchCatalog('velmora', { types: ['movie'] });

      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining('Bearer ') }) }));
    });

    it('is inert without a key', async () => {
      delete mockSettings['tmdb.api_key'];
      service = new TmdbService();

      expect(service.isConfigured()).toBe(false);
      expect(await service.searchCatalog('x', { types: ['movie'] })).toEqual([]);
      expect(await service.getTrending({ types: ['movie'] })).toEqual([]);
      expect(get).not.toHaveBeenCalled();
    });
  });

  describe('language', () => {
    it('asks for titles in the language releases are wanted in', async () => {
      // The sources index German titles, so searching the English one finds
      // nothing.
      mockSettings['quality.language'] = 'german';
      await service.searchCatalog('velmora', { types: ['movie'] });

      expect(get).toHaveBeenCalledWith('/search/multi', expect.objectContaining({
        params: expect.objectContaining({ language: 'de-DE' }),
      }));
    });

    it('maps the other configured languages', async () => {
      for (const [setting, locale] of [['english', 'en-US'], ['french', 'fr-FR']]) {
        mockSettings['quality.language'] = setting;
        get.mockClear();
        await service.searchCatalog('x', { types: ['movie'] });
        expect(get.mock.calls[0][1].params.language, setting).toBe(locale);
      }
    });

    it('falls back to English for something unmapped', async () => {
      mockSettings['quality.language'] = 'klingon';
      await service.searchCatalog('x', { types: ['movie'] });
      expect(get.mock.calls[0][1].params.language).toBe('en-US');
    });
  });

  describe('mapping', () => {
    it('reads the title from the right field per media type', async () => {
      const out = await service.searchCatalog('velmora', { types: ['movie', 'show'] });

      expect(out).toEqual([
        { type: 'movie', title: 'Velmora', year: 1999, imdbId: null, tmdbId: 603, posterPath: '/abc.jpg' },
        { type: 'show', title: 'Crown of Embers', year: 2011, imdbId: null, tmdbId: 1399, posterPath: '/def.jpg' },
      ]);
    });

    it('drops the people TMDb mixes in', async () => {
      const out = await service.searchCatalog('velmora', { types: ['movie', 'show'] });
      expect(out.some(r => r.title === 'Mara Lind')).toBe(false);
    });

    it('honours the requested types and the limit', async () => {
      expect(await service.searchCatalog('x', { types: ['show'] })).toHaveLength(1);
      expect(await service.searchCatalog('x', { types: ['movie', 'show'], limit: 1 })).toHaveLength(1);
    });

    it('survives a row with no usable date', async () => {
      get = vi.fn(async () => ({ data: { results: [{ id: 1, media_type: 'movie', title: 'Undated' }] } }));
      const out = await service.searchCatalog('x', { types: ['movie'] });
      expect(out[0]).toMatchObject({ title: 'Undated', year: null, posterPath: null });
    });
  });

  describe('resilience', () => {
    it('answers an empty query without calling out', async () => {
      expect(await service.searchCatalog('   ', { types: ['movie'] })).toEqual([]);
      expect(get).not.toHaveBeenCalled();
    });

    it('degrades to an empty catalog rather than throwing', async () => {
      get = vi.fn(async () => { throw new Error('boom'); });
      expect(await service.searchCatalog('x', { types: ['movie'] })).toEqual([]);
      expect(await service.getTrending({ types: ['movie'] })).toEqual([]);
    });

    it('names a rejected key rather than a generic failure', async () => {
      get = vi.fn(async () => { throw { response: { status: 401 } }; });
      const res = await service.testConnection();
      expect(res.ok).toBe(false);
      expect(res.error).toContain('abgelehnt');
    });

    it('reports a missing key as such', async () => {
      delete mockSettings['tmdb.api_key'];
      service = new TmdbService();
      expect((await service.testConnection()).ok).toBe(false);
    });
  });
});

describe('TMDb external ids — the imdb id behind a tmdb id', () => {
  let service: TmdbService;
  let get: any;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    mockSettings['tmdb.api_key'] = 'plain-key-123';
    get = vi.fn(async (url: string) => {
      if (url === '/movie/603/external_ids') return { data: { id: 603, imdb_id: 'tt9100133' } };
      if (url === '/tv/1399/external_ids') return { data: { id: 1399, imdb_id: 'tt9100944', tvdb_id: 121361 } };
      if (url === '/movie/1/external_ids') return { data: { id: 1, imdb_id: null } };
      throw new Error(`unexpected ${url}`);
    });
    mockedAxios.create.mockReturnValue({ get: (...a: any[]) => get(...a) } as any);
    service = new TmdbService();
  });

  it('reads the imdb id from the external_ids endpoint, per media type', async () => {
    expect(await service.getImdbId('movie', 603)).toBe('tt9100133');
    expect(await service.getImdbId('tv', 1399)).toBe('tt9100944');
  });

  it('answers null when TMDb has no mapping, and on a failed call', async () => {
    expect(await service.getImdbId('movie', 1)).toBeNull();
    expect(await service.getImdbId('movie', 999)).toBeNull();
  });

  it('is inert without a key', async () => {
    delete mockSettings['tmdb.api_key'];
    service = new TmdbService();
    expect(await service.getImdbId('movie', 603)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('TMDb release dates (release hold)', () => {
  let service: TmdbService;
  let get: any;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    mockSettings['tmdb.api_key'] = 'plain-key-123';
    get = vi.fn(async (url: string) => {
      if (url === '/movie/11') return { data: { status: 'Released', release_date: '2026-07-01' } };
      if (url === '/movie/11/release_dates') return { data: { results: [
        { iso_3166_1: 'US', release_dates: [{ type: 4, release_date: '2026-08-01T00:00:00.000Z' }] },
        { iso_3166_1: 'DE', release_dates: [
          { type: 3, release_date: '2026-07-17T00:00:00.000Z' },
          { type: 5, release_date: '2026-11-20T00:00:00.000Z' },
          { type: 4, release_date: '2026-10-30T00:00:00.000Z' },
        ] },
      ] } };
      if (url === '/tv/22') return { data: { status: 'Returning Series', first_air_date: '2024-01-05', next_episode_to_air: { air_date: '2026-10-14' } } };
      if (url === '/find/tt0000001') return { data: { movie_results: [{ id: 11 }], tv_results: [] } };
      throw new Error(`unexpected ${url}`);
    });
    mockedAxios.create.mockReturnValue({ get: (...a: any[]) => get(...a) } as any);
    service = new TmdbService();
  });

  it('reads the regional theatrical and earliest digital/disc date', async () => {
    expect(await service.getMovieRelease(11, 'DE')).toEqual({ status: 'Released', theatrical: '2026-07-17', digital: '2026-10-30' });
  });

  it('falls back to the primary date when the region has no entry', async () => {
    expect(await service.getMovieRelease(11, 'FR')).toEqual({ status: 'Released', theatrical: '2026-07-01', digital: null });
  });

  it('reads a show\'s next air date', async () => {
    expect(await service.getShowAiring(22)).toEqual({ status: 'Returning Series', firstAir: '2024-01-05', nextAir: '2026-10-14' });
  });

  it('maps an imdb id to the tmdb id of the right type', async () => {
    expect(await service.findTmdbId('movie', 'tt0000001')).toBe(11);
    expect(await service.findTmdbId('tv', 'tt0000001')).toBeNull();
  });

  it('derives the region from the language setting', () => {
    expect(service.region()).toBe('DE');
  });
});
