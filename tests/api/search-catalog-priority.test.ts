import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const settings: Record<string, string> = {};
vi.mock('../../src/database/index', () => ({
  getSetting: (key: string) => settings[key] || '',
  setSetting: (key: string, value: string) => { settings[key] = value; },
}));

const catalogItem = (name: string) => ([{
  type: 'movie' as const, title: name, year: 2020, imdbId: null, tmdbId: 1, posterPath: '/p.jpg',
}]);

const mk = (name: string) => ({
  isConfigured: vi.fn(() => false),
  searchCatalog: vi.fn(async () => catalogItem(name)),
  getTrending: vi.fn(async () => catalogItem(name)),
});
const tmdb = vi.hoisted(() => ({ v: null as any }));
const seerr = vi.hoisted(() => ({ v: null as any }));
const plex = vi.hoisted(() => ({ v: null as any }));
const trakt = vi.hoisted(() => ({ v: null as any }));

vi.mock('../../src/services/tmdb', () => ({ get tmdbService() { return tmdb.v; } }));
vi.mock('../../src/services/seerr', () => ({ get seerrService() { return seerr.v; } }));
vi.mock('../../src/services/plex', () => ({ get plexService() { return plex.v; } }));
vi.mock('../../src/services/trakt', () => ({ get traktService() { return trakt.v; } }));

vi.mock('../../src/plugins/registry', () => ({
  pluginRegistry: { aggregateSearchTitles: vi.fn(async () => []), forMediaType: vi.fn(() => []) },
}));
vi.mock('../../src/plugins/timeout', () => ({ withPluginTimeout: vi.fn(), PLUGIN_TIMEOUTS: {} }));
vi.mock('../../src/jdownloader/index', () => ({ jdownloaderService: {} }));
vi.mock('../../src/database/services/movies', () => ({
  addMovie: vi.fn(), getMovieByImdbId: vi.fn(), getMovieByTmdbId: vi.fn(), updateMovieStatus: vi.fn(),
}));
vi.mock('../../src/database/services/downloads', () => ({
  addDownload: vi.fn(), updateDownloadStatusByMovieId: vi.fn(),
}));
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: vi.fn() }));
vi.mock('../../src/scraper/filter', () => ({
  buildFilterContext: vi.fn(() => ({})), releaseRejectionReasons: vi.fn(() => []),
}));
vi.mock('../../src/services/eventbus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import router from '../../src/api/routes/search';

const app = express();
app.use(express.json());
app.use('/api/search', router);

const titleOf = (body: any) =>
  (body.groups || []).flatMap((g: any) => g.results).map((r: any) => r.title)[0];

/**
 * Which source answers the catalog is a four-way decision that used to live
 * untested inline in the route — and a mistake there breaks search for everyone
 * without any error surfacing.
 */
describe('catalog source priority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(settings).forEach(k => delete settings[k]);
    tmdb.v = mk('from-tmdb');
    seerr.v = mk('from-seerr');
    plex.v = mk('from-plex');
    trakt.v = mk('from-trakt');
  });

  describe('search', () => {
    it('uses TMDb whenever a key is present, whatever the watchlist provider is', async () => {
      // TMDb is the same data Seerr proxies, one step shorter, and it does not
      // depend on which watchlist provider happens to run.
      tmdb.v.isConfigured.mockReturnValue(true);
      seerr.v.isConfigured.mockReturnValue(true);
      settings['watchlist.provider'] = 'seerr';

      const res = await request(app).get('/api/search/all?q=x');
      expect(titleOf(res.body)).toBe('from-tmdb');
      expect(seerr.v.searchCatalog).not.toHaveBeenCalled();
    });

    it('falls back to Seerr when no TMDb key is set', async () => {
      seerr.v.isConfigured.mockReturnValue(true);
      settings['watchlist.provider'] = 'seerr';

      const res = await request(app).get('/api/search/all?q=x');
      expect(titleOf(res.body)).toBe('from-seerr');
    });

    it('falls back to Plex for a Plex-only instance', async () => {
      plex.v.isConfigured.mockReturnValue(true);
      settings['watchlist.provider'] = 'plex';

      const res = await request(app).get('/api/search/all?q=x');
      expect(titleOf(res.body)).toBe('from-plex');
    });

    it('lands on Trakt when nothing else is configured', async () => {
      const res = await request(app).get('/api/search/all?q=x');
      expect(titleOf(res.body)).toBe('from-trakt');
    });

    it('does not use Seerr as catalog while another provider is selected', async () => {
      // Seerr may be reachable but not the chosen provider; the catalog follows
      // the selection, not mere availability.
      seerr.v.isConfigured.mockReturnValue(true);
      settings['watchlist.provider'] = 'trakt';

      const res = await request(app).get('/api/search/all?q=x');
      expect(titleOf(res.body)).toBe('from-trakt');
    });
  });

  describe('trending shelf', () => {
    it('follows the same order', async () => {
      tmdb.v.isConfigured.mockReturnValue(true);
      seerr.v.isConfigured.mockReturnValue(true);
      settings['watchlist.provider'] = 'seerr';

      const res = await request(app).get('/api/search/trending');
      expect(res.body.items[0].title).toBe('from-tmdb');
    });

    it('serves a TMDb poster through dlvault, not straight from tmdb.org', async () => {
      // The image policy only allows same-origin; a redirect from dlvault is not
      // re-checked, a direct external URL would be blocked.
      tmdb.v.isConfigured.mockReturnValue(true);

      const res = await request(app).get('/api/search/trending');
      expect(res.body.items[0].poster).toBe('/api/poster/tmdb/w500/p.jpg');
    });
  });
});
