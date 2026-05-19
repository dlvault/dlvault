import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockSettings: Record<string, string> = {};

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  getMovieDetails,
  getSeasonEpisodes,
  isConfigured,
  testConnection,
} from '../../src/services/omdb';

const ok = (data: any) => ({ data: { Response: 'True', ...data } });

// NOTE: omdb.ts keeps a module-level response cache that isn't exported/reset
// between tests, so each test uses a distinct imdbId to avoid cache hits.

describe('OMDb Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps queued *Once implementations; reset axios.get so a
    // mockResolvedValueOnce can't leak into the next test.
    mockedAxios.get.mockReset();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
  });

  describe('isConfigured', () => {
    it('is false without an API key', () => {
      expect(isConfigured()).toBe(false);
    });

    it('is true once an API key is set', () => {
      mockSettings['omdb.api_key'] = 'KEY';
      expect(isConfigured()).toBe(true);
    });
  });

  describe('getMovieDetails', () => {
    it('returns null for an empty imdbId without calling the API', async () => {
      mockSettings['omdb.api_key'] = 'KEY';
      const result = await getMovieDetails('');
      expect(result).toBeNull();
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('returns null when no API key is configured', async () => {
      const result = await getMovieDetails('tt0133093');
      expect(result).toBeNull();
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('maps a successful response and normalises N/A fields to null', async () => {
      mockSettings['omdb.api_key'] = 'KEY';
      mockedAxios.get.mockResolvedValueOnce(ok({
        Released: '1999-03-31', // ISO so parseDate is timezone-stable
        Poster: 'https://img/poster.jpg',
        Plot: 'N/A',
        Genre: 'Action, Sci-Fi',
        imdbRating: '8.7',
        Runtime: '136 min',
        Director: 'The Wachowskis',
        Production: 'N/A',
        Country: 'United States',
        Type: 'movie',
        totalSeasons: undefined,
      }));

      const result = await getMovieDetails('tt0133093');
      expect(result).toEqual({
        released: '1999-03-31',
        poster: 'https://img/poster.jpg',
        plot: null,
        genre: 'Action, Sci-Fi',
        rating: 8.7,
        runtime: 136,
        director: 'The Wachowskis',
        studio: null,        // OMDb "Production" was N/A
        country: 'United States',
        type: 'movie',
        totalSeasons: null,
      });
    });

    it('parses totalSeasons for series', async () => {
      mockSettings['omdb.api_key'] = 'KEY';
      mockedAxios.get.mockResolvedValueOnce(ok({
        Released: 'N/A',
        Poster: 'N/A',
        Plot: 'A show',
        Genre: 'Drama',
        Type: 'series',
        totalSeasons: '5',
      }));

      const result = await getMovieDetails('tt_series');
      expect(result?.totalSeasons).toBe(5);
      expect(result?.released).toBeNull();
      expect(result?.poster).toBeNull();
      expect(result?.type).toBe('series');
    });

    it('returns null when the API reports a non-True response', async () => {
      mockSettings['omdb.api_key'] = 'KEY';
      mockedAxios.get.mockResolvedValueOnce({ data: { Response: 'False', Error: 'not found' } });
      expect(await getMovieDetails('tt404')).toBeNull();
    });

    it('returns null and swallows network errors', async () => {
      mockSettings['omdb.api_key'] = 'KEY';
      mockedAxios.get.mockRejectedValueOnce(new Error('boom'));
      expect(await getMovieDetails('tt_neterr')).toBeNull();
    });

    it('serves a cached response on the second identical call', async () => {
      mockSettings['omdb.api_key'] = 'KEY';
      mockedAxios.get.mockResolvedValueOnce(ok({ Type: 'movie' }));

      await getMovieDetails('tt_cache');
      await getMovieDetails('tt_cache');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('getSeasonEpisodes', () => {
    it('returns [] for an empty imdbId', async () => {
      mockSettings['omdb.api_key'] = 'KEY';
      expect(await getSeasonEpisodes('', 1)).toEqual([]);
    });

    it('returns [] when the response has no Episodes', async () => {
      mockSettings['omdb.api_key'] = 'KEY';
      mockedAxios.get.mockResolvedValueOnce(ok({}));
      expect(await getSeasonEpisodes('tt_noeps', 1)).toEqual([]);
    });

    it('maps episodes and falls back to a placeholder title for N/A', async () => {
      mockSettings['omdb.api_key'] = 'KEY';
      mockedAxios.get.mockResolvedValueOnce(ok({
        Episodes: [
          { Episode: '1', Title: 'Pilot', Released: '2020-01-05' },
          { Episode: '2', Title: 'N/A', Released: 'N/A' },
        ],
      }));

      const eps = await getSeasonEpisodes('tt_eps', 1);
      expect(eps).toEqual([
        { number: 1, title: 'Pilot', air_date: '2020-01-05' },
        { number: 2, title: 'Episode 2', air_date: null },
      ]);
    });
  });

  describe('testConnection', () => {
    it('fails when no API key is configured', async () => {
      const res = await testConnection();
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/API-Key/);
    });

    it('succeeds for a valid key', async () => {
      mockSettings['omdb.api_key'] = 'KEY';
      mockedAxios.get.mockResolvedValueOnce(ok({}));
      expect(await testConnection()).toEqual({ success: true });
    });

    it('reports the API error message on a non-True response', async () => {
      mockSettings['omdb.api_key'] = 'KEY';
      mockedAxios.get.mockResolvedValueOnce({ data: { Response: 'False', Error: 'Invalid API key!' } });
      const res = await testConnection();
      expect(res.success).toBe(false);
      expect(res.error).toBe('Invalid API key!');
    });

    it('maps a 401 to an invalid-key message', async () => {
      mockSettings['omdb.api_key'] = 'KEY';
      mockedAxios.get.mockRejectedValueOnce({ response: { status: 401 }, message: 'Request failed' });
      const res = await testConnection();
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Ungültiger API-Key/);
    });

    it('surfaces a generic network error message', async () => {
      mockSettings['omdb.api_key'] = 'KEY';
      mockedAxios.get.mockRejectedValueOnce({ message: 'ETIMEDOUT' });
      const res = await testConnection();
      expect(res.success).toBe(false);
      expect(res.error).toBe('ETIMEDOUT');
    });
  });
});
