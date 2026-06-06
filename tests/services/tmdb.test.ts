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
    { id: 603, media_type: 'movie', title: 'Matrix', release_date: '1999-03-30', poster_path: '/abc.jpg' },
    { id: 1399, media_type: 'tv', name: 'Game of Thrones', first_air_date: '2011-04-17', poster_path: '/def.jpg' },
    // Multi-search and trending both mix people in.
    { id: 287, media_type: 'person', name: 'Brad Pitt', profile_path: '/p.jpg' },
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
      await service.searchCatalog('matrix', { types: ['movie'] });
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ params: { api_key: 'plain-key-123' } }));
    });

    it('sends a read access token as a Bearer header instead', async () => {
      // TMDb shows both credentials side by side and they are not
      // interchangeable in how they travel; pasting the wrong one is the obvious
      // mistake, so accept either.
      mockSettings['tmdb.api_key'] = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ4In0.sig';
      service = new TmdbService();
      await service.searchCatalog('matrix', { types: ['movie'] });

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
      await service.searchCatalog('matrix', { types: ['movie'] });

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
      const out = await service.searchCatalog('matrix', { types: ['movie', 'show'] });

      expect(out).toEqual([
        { type: 'movie', title: 'Matrix', year: 1999, imdbId: null, tmdbId: 603, posterPath: '/abc.jpg' },
        { type: 'show', title: 'Game of Thrones', year: 2011, imdbId: null, tmdbId: 1399, posterPath: '/def.jpg' },
      ]);
    });

    it('drops the people TMDb mixes in', async () => {
      const out = await service.searchCatalog('matrix', { types: ['movie', 'show'] });
      expect(out.some(r => r.title === 'Brad Pitt')).toBe(false);
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
