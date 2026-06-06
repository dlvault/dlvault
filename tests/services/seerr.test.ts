import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockSettings: Record<string, string> = {};

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
  setSetting: vi.fn((key: string, value: string) => { mockSettings[key] = value; }),
}));

const movies: any[] = [];
let nextId = 1;
const addMovie = vi.hoisted(() => vi.fn());
const deleteMovie = vi.hoisted(() => vi.fn());
vi.mock('../../src/database/services/movies', () => ({
  addMovie: (m: any) => { const row = { ...m, id: nextId++ }; movies.push(row); addMovie(m); return row; },
  getMovieByTmdbId: vi.fn((tmdbId: number, type: string) =>
    movies.find(m => m.tmdb_id === tmdbId && m.media_type === type) || null),
  getMovieByImdbId: vi.fn((imdbId: string) => movies.find(m => m.imdb_id === imdbId) || null),
  getMovieByTvdbId: vi.fn((tvdbId: number) => movies.find(m => m.tvdb_id === tvdbId) || undefined),
  setMovieTvdbId: vi.fn((id: number, tvdbId: number) => {
    const m = movies.find(x => x.id === id); if (m) m.tvdb_id = tvdbId;
  }),
  setMovieTmdbId: vi.fn((id: number, tmdbId: number) => {
    const m = movies.find(x => x.id === id); if (m) m.tmdb_id = tmdbId;
  }),
  getAllMovies: vi.fn(() => movies),
  setSeasonsExplicit: vi.fn((id: number, explicit: boolean) => {
    const m = movies.find(x => x.id === id); if (m) m.seasons_explicit = explicit ? 1 : 0;
  }),
  deleteMovie: (id: number) => { deleteMovie(id); const i = movies.findIndex(m => m.id === id); if (i >= 0) movies.splice(i, 1); },
}));

const seasons: any[] = [];
let nextSeasonId = 1;
const updateSeasonEpisodeCount = vi.hoisted(() => vi.fn());
vi.mock('../../src/database/services/seasons', () => ({
  getSeasonsByShowId: vi.fn((movieId: number) => seasons.filter(s => s.movie_id === movieId)),
  addSeason: (movieId: number, seasonNumber: number, quality?: string) => {
    const row = { id: nextSeasonId++, movie_id: movieId, season_number: seasonNumber, desired_quality: quality, status: 'pending' };
    seasons.push(row);
    return row;
  },
  updateSeasonEpisodeCount: (id: number, count: number) => {
    updateSeasonEpisodeCount(id, count);
    const s = seasons.find(x => x.id === id);
    if (s) s.episode_count = count;
  },
}));

const addLogEntry = vi.hoisted(() => vi.fn());
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry }));

let libraryConfigured = false;
let libraryHas: boolean | null = false;
vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({
    isConfigured: () => libraryConfigured,
    hasMovie: async () => libraryHas,
  })),
  getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));

vi.mock('../../src/services/processingState', () => ({ processingMovies: new Set<number>() }));
const sendTelegramNotification = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../src/services/telegram', () => ({ sendTelegramNotification }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { SeerrService, MEDIA_AVAILABLE, MEDIA_PARTIALLY_AVAILABLE, MEDIA_PROCESSING, MEDIA_PENDING } from '../../src/services/seerr';
import { processingMovies } from '../../src/services/processingState';

/** Shapes copied from a live Seerr 2.7.3 response. */
const movieRequest = (over: any = {}) => ({
  id: 1, status: 2, type: 'movie', is4k: false, seasons: [],
  media: { id: 100, mediaType: 'movie', tmdbId: 550, tvdbId: null, imdbId: null, status: 3 },
  requestedBy: { displayName: 'Anna' },
  ...over,
});
const tvRequest = (over: any = {}) => ({
  id: 2, status: 2, type: 'tv', is4k: false,
  seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
  media: { id: 101, mediaType: 'tv', tmdbId: 1399, tvdbId: 121361, imdbId: null, status: 2 },
  ...over,
});

const movieMeta = { title: 'Fight Club', releaseDate: '1999-10-15', imdbId: 'tt0137523' };
const tvMeta = {
  name: 'Game of Thrones', firstAirDate: '2011-04-17',
  externalIds: { imdbId: 'tt0944947' },
  seasons: [
    { seasonNumber: 0, episodeCount: 300 },   // specials bucket
    { seasonNumber: 1, episodeCount: 10 },
    { seasonNumber: 2, episodeCount: 10 },
    { seasonNumber: 3, episodeCount: 10 },
  ],
};

/** Routes a GET to the right fixture based on its path. */
function respond(requests: any[], opts: { pages?: number } = {}) {
  return vi.fn(async (url: string, config?: any) => {
    if (url === '/request') {
      const skip = config?.params?.skip ?? 0;
      const take = config?.params?.take ?? 50;
      return {
        data: {
          pageInfo: { pages: opts.pages ?? 1, results: requests.length },
          results: requests.slice(skip, skip + take),
        },
      };
    }
    if (url.startsWith('/movie/')) {
      // Distinct ids must yield distinct IMDb ids, otherwise the dedupe check
      // correctly collapses them and the fixture, not the code, is wrong.
      const id = Number(url.split('/').pop());
      if (id !== 550) return { data: { title: `Movie ${id}`, releaseDate: '2020-01-01', imdbId: `tt${id}` } };
      return { data: movieMeta };
    }
    if (url.startsWith('/tv/')) return { data: tvMeta };
    if (url === '/settings/about') return { data: { version: '2.7.3' } };
    if (url.startsWith('/search')) return {
      data: {
        results: [
          { id: 603, mediaType: 'movie', title: 'Matrix', releaseDate: '1999-03-30', posterPath: '/abc.jpg' },
          { id: 711, mediaType: 'tv', name: 'Threat Matrix', firstAirDate: '2003-09-18', posterPath: '/def.jpg' },
          // Seerr mixes people into search and trending results.
          { id: 287, mediaType: 'person', name: 'Brad Pitt' },
        ],
      },
    };
    if (url === '/discover/trending') return {
      data: {
        results: [
          { id: 550, mediaType: 'movie', title: 'Fight Club', releaseDate: '1999-10-15', posterPath: '/xyz.jpg' },
          { id: 999, mediaType: 'person', name: 'Somebody' },
        ],
      },
    };
    throw new Error(`unexpected GET ${url}`);
  });
}

describe('Seerr provider', () => {
  let service: SeerrService;
  let get: ReturnType<typeof respond>;
  let post: any;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    movies.length = 0; seasons.length = 0; nextId = 1; nextSeasonId = 1;
    processingMovies.clear();
    libraryConfigured = false; libraryHas = false;

    mockSettings['seerr.url'] = 'http://seerr:5055';
    mockSettings['seerr.api_key'] = 'key-1';
    mockSettings['watchlist.provider'] = 'seerr';
    mockSettings['quality.minimum'] = '1080p';

    get = respond([]);
    post = vi.fn(async () => ({ data: {} }));
    // The service caches one axios instance per url+key, so the mock has to
    // delegate — reassigning `get` later must reach the service.
    mockedAxios.create.mockReturnValue({
      get: (...a: any[]) => (get as any)(...a),
      post: (...a: any[]) => (post as any)(...a),
    } as any);
    service = new SeerrService();
  });

  describe('pulling requests', () => {
    it('resolves title, year and IMDb id — none of which the request itself carries', async () => {
      get = respond([movieRequest()]);

      expect(await service.syncWatchlist()).toBe(1);
      expect(addMovie).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Fight Club', year: 1999, imdb_id: 'tt0137523', tmdb_id: 550,
        media_type: 'movie', status: 'pending', watchlist_source: 'seerr',
      }));
    });

    it('names the requester in the activity log', async () => {
      get = respond([movieRequest()]);
      await service.syncWatchlist();

      const entry = addLogEntry.mock.calls.find(c => c[1] === 'movie_added');
      expect(entry?.[2]).toContain('Anna');
    });

    it('ignores requests still awaiting approval', async () => {
      get = respond([movieRequest({ status: 1 })]);

      expect(await service.syncWatchlist()).toBe(0);
      expect(addMovie).not.toHaveBeenCalled();
    });

    it('maps a 4K request to 2160p instead of the configured floor', async () => {
      get = respond([movieRequest({ is4k: true })]);
      await service.syncWatchlist();

      expect(addMovie).toHaveBeenCalledWith(expect.objectContaining({ desired_quality: '2160p' }));
    });

    it('does not re-add a title it already tracks', async () => {
      get = respond([movieRequest()]);

      await service.syncWatchlist();
      expect(await service.syncWatchlist()).toBe(0);
      expect(addMovie).toHaveBeenCalledTimes(1);
    });

    it('walks every page of the request feed', async () => {
      const many = Array.from({ length: 120 }, (_, i) =>
        movieRequest({ id: i + 1, media: { id: 100 + i, mediaType: 'movie', tmdbId: 1000 + i, tvdbId: null, imdbId: null, status: 3 } }));
      get = respond(many, { pages: 3 });

      await service.syncWatchlist();
      expect(get.mock.calls.filter(c => c[0] === '/request')).toHaveLength(3);
      expect(addMovie).toHaveBeenCalledTimes(120);
    });
  });

  describe('shows', () => {
    it('creates only the requested seasons, not the whole show', async () => {
      get = respond([tvRequest()]);
      await service.syncWatchlist();

      expect(seasons.map(s => s.season_number).sort()).toEqual([1, 2]);
    });

    it('never creates season 0 — TMDb parks 300 specials in it', async () => {
      get = respond([tvRequest({ seasons: [] })]);   // empty list = all seasons
      await service.syncWatchlist();

      expect(seasons.map(s => s.season_number).sort()).toEqual([1, 2, 3]);
      expect(seasons.some(s => s.season_number === 0)).toBe(false);
    });

    it('seeds episode counts from Seerr — no Trakt involved', async () => {
      get = respond([tvRequest()]);
      await service.syncWatchlist();

      expect(seasons.every(s => s.episode_count === 10)).toBe(true);
    });

    it('marks a named season set as closed, an "all seasons" request as open', async () => {
      get = respond([tvRequest()]);            // seasons [1, 2] named
      await service.syncWatchlist();
      expect(movies[0].seasons_explicit).toBe(1);

      movies.length = 0; seasons.length = 0;
      get = respond([tvRequest({ seasons: [] })]);   // empty = whole show
      await service.syncWatchlist();
      // Never written at all — the column defaults to open, and seedSeasons only
      // ever tightens. (The mock does not apply column defaults, hence falsy
      // rather than 0.)
      expect(movies[0].seasons_explicit).toBeFalsy();
    });

    it('adopts a show the Sonarr endpoint added first instead of duplicating it', async () => {
      // The Sonarr payload carries only a tvdbId, so the push path writes that
      // and leaves tmdb_id null. Looking up by tmdbId alone missed it and
      // created a SECOND row — one of them without the season limit, which the
      // pipeline then filled with every season the source had. Seen live: a
      // request for two seasons produced one row with two and one with three.
      movies.push({
        id: 50, tmdb_id: null, tvdb_id: 121361, imdb_id: '', media_type: 'show',
        title: 'Game of Thrones', status: 'pending', watchlist_source: 'seerr',
      });

      get = respond([tvRequest()]);
      expect(await service.syncWatchlist()).toBe(0);

      expect(movies).toHaveLength(1);
      expect(seasons.filter(s => s.movie_id === 50).map(s => s.season_number).sort()).toEqual([1, 2]);
      expect(movies[0].seasons_explicit).toBe(1);
    });

    it('back-fills the tmdb id on a show the push path created', async () => {
      // The Sonarr endpoint stores null for it, and pushStatuses looks a title
      // up by tmdbId — so without this the show's progress would never be
      // reported back to Seerr, ever.
      movies.push({
        id: 50, tmdb_id: null, tvdb_id: 121361, imdb_id: '', media_type: 'show',
        title: 'Game of Thrones', status: 'pending', watchlist_source: 'seerr',
      });
      get = respond([tvRequest()]);

      await service.syncWatchlist();
      expect(movies[0].tmdb_id).toBe(1399);
    });

    it('never lifts a season limit that an earlier request set', async () => {
      // seedSeasons runs for every tracked show on every pass. Writing the flag
      // unconditionally let a second request with an open season list silently
      // undo the first one's limit — and with two such requests the outcome
      // depended on which the loop reached last.
      get = respond([tvRequest()]);                       // seasons 1,2 named
      await service.syncWatchlist();
      expect(movies[0].seasons_explicit).toBe(1);

      get = respond([tvRequest({ id: 9, seasons: [] })]);  // "all seasons"
      await service.syncWatchlist();

      expect(movies[0].seasons_explicit).toBe(1);
    });

    it('records the tvdb id on a show it creates itself', async () => {
      // Without it the Sonarr endpoint would not recognise the same series and
      // would add its own copy.
      get = respond([tvRequest()]);
      await service.syncWatchlist();

      expect(addMovie).toHaveBeenCalledWith(expect.objectContaining({ tvdb_id: 121361 }));
    });

    it('widens the season set when a later request adds seasons', async () => {
      get = respond([tvRequest()]);
      await service.syncWatchlist();
      expect(seasons).toHaveLength(2);

      get = respond([tvRequest({ seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }] })]);
      await service.syncWatchlist();

      expect(seasons.map(s => s.season_number).sort()).toEqual([1, 2, 3]);
    });
  });

  describe('library awareness', () => {
    it('marks a title already on disk as downloaded and tells Seerr', async () => {
      libraryConfigured = true; libraryHas = true;
      get = respond([movieRequest()]);

      expect(await service.syncWatchlist()).toBe(0);
      expect(addMovie).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloaded' }));
      expect(post).toHaveBeenCalledWith('/media/100/available', { is4k: false });
    });

    it('defers rather than queues when library state is unknown', async () => {
      libraryConfigured = true; libraryHas = null;
      get = respond([movieRequest()]);

      expect(await service.syncWatchlist()).toBe(0);
      expect(addMovie).not.toHaveBeenCalled();
    });
  });

  describe('withdrawn requests', () => {
    it('drops a title whose request was declined while still pending', async () => {
      get = respond([movieRequest()]);
      await service.syncWatchlist();
      expect(movies).toHaveLength(1);

      get = respond([movieRequest({ status: 3 })]);
      await service.syncWatchlist();

      expect(deleteMovie).toHaveBeenCalled();
      expect(movies).toHaveLength(0);
    });

    it('keeps a title whose request merely FAILED — that is transient, not a withdrawal', async () => {
      // A failed request means the fulfilment server refused it once. Treating
      // that as "withdrawn" deleted titles the requester still wanted; it hit a
      // real request when dlvault's own duplicate response made Seerr mark it
      // failed.
      get = respond([movieRequest()]);
      await service.syncWatchlist();
      expect(movies).toHaveLength(1);

      get = respond([movieRequest({ status: 4 })]);   // FAILED
      await service.syncWatchlist();

      expect(deleteMovie).not.toHaveBeenCalled();
      expect(movies).toHaveLength(1);
    });

    it('keeps a title whose request Seerr already marked completed', async () => {
      get = respond([movieRequest()]);
      await service.syncWatchlist();

      get = respond([movieRequest({ status: 5 })]);   // COMPLETED
      await service.syncWatchlist();

      expect(deleteMovie).not.toHaveBeenCalled();
    });

    it('keeps work that is already downloading or on disk', async () => {
      get = respond([movieRequest()]);
      await service.syncWatchlist();
      movies[0].status = 'downloading';

      get = respond([movieRequest({ status: 3 })]);
      await service.syncWatchlist();

      expect(deleteMovie).not.toHaveBeenCalled();
    });

    it('never deletes a row processMovie() is holding — that trips a FOREIGN KEY', async () => {
      get = respond([movieRequest()]);
      await service.syncWatchlist();
      processingMovies.add(movies[0].id);

      get = respond([movieRequest({ status: 3 })]);
      await service.syncWatchlist();

      expect(deleteMovie).not.toHaveBeenCalled();
    });

    it('leaves other providers\' rows alone', async () => {
      movies.push({ id: 99, tmdb_id: 777, media_type: 'movie', status: 'pending', watchlist_source: 'plex', title: 'X', year: 2020 });
      get = respond([]);

      await service.syncWatchlist();
      expect(deleteMovie).not.toHaveBeenCalled();
    });
  });

  describe('status write-back', () => {
    it('reports a finished movie as available', async () => {
      get = respond([movieRequest()]);
      await service.syncWatchlist();
      movies[0].status = 'downloaded';

      await service.pushStatusUpdates();
      expect(post).toHaveBeenCalledWith('/media/100/available', { is4k: false });
    });

    it('reports a show with some seasons done as partially available', async () => {
      get = respond([tvRequest()]);
      await service.syncWatchlist();
      seasons[0].status = 'downloaded';

      post.mockClear();
      await service.pushStatusUpdates();
      expect(post).toHaveBeenCalledWith('/media/101/partial', { is4k: false });
    });

    it('only calls a show available once every requested season landed', async () => {
      get = respond([tvRequest()]);
      await service.syncWatchlist();
      seasons.forEach(s => { s.status = 'downloaded'; });

      post.mockClear();
      await service.pushStatusUpdates();
      expect(post).toHaveBeenCalledWith('/media/101/available', { is4k: false });
    });

    it('reports a title dlvault could not find as pending again', async () => {
      get = respond([movieRequest({ media: { id: 100, mediaType: 'movie', tmdbId: 550, tvdbId: null, imdbId: null, status: 3 } })]);
      await service.syncWatchlist();
      movies[0].status = 'not_found';

      post.mockClear();
      await service.pushStatusUpdates();
      expect(post).toHaveBeenCalledWith('/media/100/pending', { is4k: false });
    });

    it('reports on a show that carries only a tvdb id', async () => {
      // A series added purely through the Sonarr endpoint has no tmdbId; looking
      // it up by that alone meant its progress was never reported.
      movies.push({
        id: 60, tmdb_id: null, tvdb_id: 121361, media_type: 'show',
        title: 'Game of Thrones', status: 'downloaded', watchlist_source: 'seerr',
      });
      seasons.push({ id: 1, movie_id: 60, season_number: 1, status: 'downloaded' });
      seasons.push({ id: 2, movie_id: 60, season_number: 2, status: 'downloaded' });
      get = respond([tvRequest()]);

      post.mockClear();
      await service.pushStatusUpdates();

      expect(post).toHaveBeenCalledWith('/media/101/available', { is4k: false });
    });

    it('reports on a title dlvault tracked before the request existed', async () => {
      // Accepted the request but did not create the row: without this the title
      // sits at "processing" in Seerr for good, because dlvault only reported on
      // rows it owned.
      movies.push({
        id: 50, tmdb_id: 550, imdb_id: 'tt0137523', media_type: 'movie',
        status: 'not_found', title: 'Fight Club', year: 1999, watchlist_source: null,
      });
      get = respond([movieRequest()]);

      post.mockClear();
      await service.pushStatusUpdates();

      expect(post).toHaveBeenCalledWith('/media/100/pending', { is4k: false });
    });

    it('still refuses to DELETE a row it does not own', async () => {
      // Reporting and deleting are different rights: progress is owed on any
      // requested title, removal only on rows this provider created.
      movies.push({
        id: 51, tmdb_id: 550, media_type: 'movie', status: 'pending',
        title: 'Fight Club', year: 1999, watchlist_source: 'trakt',
      });
      get = respond([movieRequest({ status: 3 })]);   // declined

      await service.syncWatchlist();

      expect(deleteMovie).not.toHaveBeenCalled();
    });

    it('clears the stale progress cache once a title becomes available', async () => {
      // Seerr's tracker only adds to that cache; it keeps the last snapshot when
      // a title leaves the queue and clears it just once a day. A finished film
      // therefore showed "processing" and a 0% bar for hours, even though the
      // status underneath was already correct.
      get = respond([movieRequest()]);
      await service.syncWatchlist();
      movies[0].status = 'downloaded';

      post.mockClear();
      await service.pushStatusUpdates();

      expect(post).toHaveBeenCalledWith('/media/100/available', { is4k: false });
      expect(post).toHaveBeenCalledWith('/settings/jobs/download-sync-reset/run');
    });

    it('leaves the cache alone when nothing finished', async () => {
      // Resetting on every pass would blank the bar for titles still running.
      get = respond([movieRequest()]);
      await service.syncWatchlist();
      movies[0].status = 'not_found';

      post.mockClear();
      await service.pushStatusUpdates();

      expect(post).toHaveBeenCalledWith('/media/100/pending', { is4k: false });
      expect(post).not.toHaveBeenCalledWith('/settings/jobs/download-sync-reset/run');
    });

    it('stays quiet when Seerr already shows the right status', async () => {
      // media.status 3 == processing, which is what a 'pending' movie maps to.
      get = respond([movieRequest()]);
      await service.syncWatchlist();

      post.mockClear();
      expect(await service.pushStatusUpdates()).toBe(0);
      expect(post).not.toHaveBeenCalled();
    });

    it('shares one request fetch between pull and push', async () => {
      get = respond([movieRequest()]);

      await service.syncWatchlist();
      expect(get.mock.calls.filter(c => c[0] === '/request')).toHaveLength(1);
    });
  });

  describe('credential failure', () => {
    const rejected = { response: { status: 403, data: 'Forbidden' } };

    it('stops issuing requests instead of retrying every two minutes', async () => {
      get = vi.fn(async () => { throw rejected; });

      await service.syncWatchlist();
      const after = get.mock.calls.length;
      for (let i = 0; i < 5; i++) await service.syncWatchlist();

      expect(get.mock.calls.length).toBe(after);
    });

    it('alerts once, not once per attempt', async () => {
      get = vi.fn(async () => { throw rejected; });

      for (let i = 0; i < 4; i++) await service.syncWatchlist();

      expect(sendTelegramNotification).toHaveBeenCalledTimes(1);
      expect(addLogEntry.mock.calls.filter(c => c[1] === 'seerr_auth_failed')).toHaveLength(1);
    });

    it('recovers as soon as a new API key is saved', async () => {
      get = vi.fn(async () => { throw rejected; });
      await service.syncWatchlist();
      expect(service.getAuthFailure()).not.toBeNull();

      mockSettings['seerr.api_key'] = 'key-2';
      get = respond([movieRequest()]);

      expect(await service.syncWatchlist()).toBe(1);
      expect(service.getAuthFailure()).toBeNull();
    });

    it('treats a server error as transient and keeps trying', async () => {
      get = vi.fn(async () => { throw { response: { status: 500, data: 'boom' } }; });

      await service.syncWatchlist();
      const after = get.mock.calls.length;
      await service.syncWatchlist();

      expect(service.getAuthFailure()).toBeNull();
      expect(get.mock.calls.length).toBeGreaterThan(after);
    });
  });
});

/**
 * The rule that cost 2.5 days of silent Trakt failures on a Plex-only instance:
 * a provider nobody connected must not touch the network at all.
 */
describe('unconfigured Seerr is inert', () => {
  let service: SeerrService;
  let get: any, post: any;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    movies.length = 0; seasons.length = 0;
    get = vi.fn(); post = vi.fn();
    service = new SeerrService();
  });

  it('makes no call across every network method', async () => {
    await service.syncWatchlist();
    await service.getRequests();
    await service.getMeta('movie', 550);
    await service.setMediaStatus(1, MEDIA_AVAILABLE);
    await service.pushStatusUpdates();

    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(sendTelegramNotification).not.toHaveBeenCalled();
    expect(service.getAuthFailure()).toBeNull();
  });

  it('reports itself as not configured', () => {
    expect(service.isConfigured()).toBe(false);
  });

  it('stays inert with a URL but no key', async () => {
    mockSettings['seerr.url'] = 'http://seerr:5055';
    expect(service.isConfigured()).toBe(false);
    await service.syncWatchlist();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('status constants match Seerr MediaStatus', () => {
  it('uses the numbers the API actually returns', () => {
    expect([MEDIA_PENDING, MEDIA_PROCESSING, MEDIA_PARTIALLY_AVAILABLE, MEDIA_AVAILABLE])
      .toEqual([2, 3, 4, 5]);
  });
});

/**
 * Seerr proxies TMDb, which is what makes it a usable catalog after Trakt closed
 * its API — and it needs no key of its own to do it.
 */
describe('registering dlvault as a fulfilment server', () => {
  let service: SeerrService;
  let get: ReturnType<typeof respond>;
  let post: any;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    mockSettings['seerr.url'] = 'http://seerr:5055';
    mockSettings['seerr.api_key'] = 'key-1';
    mockSettings['paths.movies'] = '/movies';
    mockSettings['paths.series'] = '/series';
    get = vi.fn(async () => ({ data: [] })) as any;
    post = vi.fn(async () => ({ data: {} }));
    mockedAxios.create.mockReturnValue({
      get: (...a: any[]) => (get as any)(...a),
      post: (...a: any[]) => (post as any)(...a),
      delete: vi.fn(async () => ({ data: {} })),
    } as any);
    service = new SeerrService();
  });

  it('enables sync — without it Seerr never polls the server at all', async () => {
    // Reads like "scan this server's library", but it also gates the download
    // tracker: with it off no request is ever issued and no progress is shown,
    // while the media status underneath stays correct.
    await service.registerAsArrServer('http://dlvault:3000', 'key');

    const bodies = post.mock.calls.filter((c: any[]) => /\/settings\/(radarr|sonarr)$/.test(c[0])).map((c: any[]) => c[1]);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect(b.syncEnabled).toBe(true);
  });

  it('gives each flavour its own base path and library', async () => {
    await service.registerAsArrServer('http://dlvault:3000', 'key');
    const byPath = Object.fromEntries(
      post.mock.calls.filter((c: any[]) => /\/settings\/(radarr|sonarr)$/.test(c[0]))
        .map((c: any[]) => [c[0].split('/').pop(), c[1]]));
    expect(byPath.radarr).toMatchObject({ baseUrl: '/radarr', activeDirectory: '/movies' });
    expect(byPath.sonarr).toMatchObject({ baseUrl: '/sonarr', activeDirectory: '/series' });
  });
});

describe('Seerr as catalog source', () => {
  let service: SeerrService;
  let get: ReturnType<typeof respond>;
  let post: any;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    movies.length = 0; seasons.length = 0;
    mockSettings['seerr.url'] = 'http://seerr:5055';
    mockSettings['seerr.api_key'] = 'key-1';
    get = respond([]);
    post = vi.fn(async () => ({ data: {} }));
    mockedAxios.create.mockReturnValue({
      get: (...a: any[]) => (get as any)(...a),
      post: (...a: any[]) => (post as any)(...a),
    } as any);
    service = new SeerrService();
  });

  it('returns movies and shows in the shared catalog shape', async () => {
    const out = await service.searchCatalog('matrix', { types: ['movie', 'show'] });

    expect(out).toEqual([
      { type: 'movie', title: 'Matrix', year: 1999, imdbId: null, tmdbId: 603, posterPath: '/abc.jpg' },
      { type: 'show', title: 'Threat Matrix', year: 2003, imdbId: null, tmdbId: 711, posterPath: '/def.jpg' },
    ]);
  });

  it('drops the people Seerr mixes into search results', async () => {
    const out = await service.searchCatalog('matrix', { types: ['movie', 'show'] });
    expect(out.some(r => r.title === 'Brad Pitt')).toBe(false);
  });

  it('honours the requested media types', async () => {
    const out = await service.searchCatalog('matrix', { types: ['movie'] });
    expect(out.map(r => r.type)).toEqual(['movie']);
  });

  it('respects the limit', async () => {
    const out = await service.searchCatalog('matrix', { types: ['movie', 'show'], limit: 1 });
    expect(out).toHaveLength(1);
  });

  it('returns trending without the person entries', async () => {
    const out = await service.getTrending({ types: ['movie', 'show'] });
    expect(out).toEqual([
      { type: 'movie', title: 'Fight Club', year: 1999, imdbId: null, tmdbId: 550, posterPath: '/xyz.jpg' },
    ]);
  });

  it('encodes the query itself — a space must not become "+"', async () => {
    // Seerr refuses '+' outright ("Parameter 'query' must be url encoded"), and
    // axios's default serializer produces exactly that. German queries are the
    // normal case here, so this broke almost every real search.
    await service.searchCatalog('herr der ringe', { types: ['movie'] });

    const url = (get as any).mock.calls.find((c: any[]) => String(c[0]).startsWith('/search'))[0];
    expect(url).toContain('herr%20der%20ringe');
    expect(url).not.toContain('+');
  });

  it('answers an empty query without calling out', async () => {
    const out = await service.searchCatalog('   ', { types: ['movie'] });
    expect(out).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('is inert when Seerr is not configured', async () => {
    delete mockSettings['seerr.api_key'];
    expect(await service.searchCatalog('x', { types: ['movie'] })).toEqual([]);
    expect(await service.getTrending({ types: ['movie'] })).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('degrades to an empty catalog rather than throwing', async () => {
    get = vi.fn(async () => { throw new Error('boom'); }) as any;
    expect(await service.searchCatalog('x', { types: ['movie'] })).toEqual([]);
    expect(await service.getTrending({ types: ['movie'] })).toEqual([]);
  });
});
