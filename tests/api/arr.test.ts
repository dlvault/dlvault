import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSettings: Record<string, string> = {};
vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] ?? ''),
  setSetting: vi.fn((key: string, value: string) => { mockSettings[key] = value; }),
}));

const movies: any[] = [];
let nextId = 1;
vi.mock('../../src/database/services/movies', () => ({
  addMovie: (m: any) => { const row = { ...m, id: nextId++ }; movies.push(row); return row; },
  getMovieByTmdbId: vi.fn((tmdbId: number, type: string) =>
    movies.find(m => m.tmdb_id === tmdbId && m.media_type === type) || null),
  getMovieByImdbId: vi.fn((imdbId: string) => movies.find(m => m.imdb_id === imdbId) || null),
  getMovieByTvdbId: vi.fn((tvdbId: number) => movies.find(m => m.tvdb_id === tvdbId) || undefined),
  setMovieTvdbId: vi.fn((id: number, tvdbId: number) => {
    const m = movies.find(x => x.id === id); if (m) m.tvdb_id = tvdbId;
  }),
  setSeasonsExplicit: vi.fn((id: number, explicit: boolean) => {
    const m = movies.find(x => x.id === id); if (m) m.seasons_explicit = explicit ? 1 : 0;
  }),
  getAllMovies: vi.fn(() => movies),
}));

const seasons: any[] = [];
let nextSeasonId = 1;
vi.mock('../../src/database/services/seasons', () => ({
  getSeasonsByShowId: vi.fn((movieId: number) => seasons.filter(s => s.movie_id === movieId)),
  addSeason: (movieId: number, seasonNumber: number, quality?: string) => {
    const row = { id: nextSeasonId++, movie_id: movieId, season_number: seasonNumber, desired_quality: quality, status: 'pending', episode_count: null };
    seasons.push(row);
    return row;
  },
}));

const downloads: any[] = [];
vi.mock('../../src/database/services/downloads', () => ({ getAllDownloads: vi.fn(() => downloads) }));

const jdPackages = vi.hoisted(() => ({ value: [] as any[] | null }));
vi.mock('../../src/jdownloader/index', () => ({
  jdownloaderService: { getDownloadPackages: vi.fn(async () => jdPackages.value) },
}));
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: vi.fn() }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { radarrRouter, sonarrRouter, getArrApiKey } from '../../src/api/routes/arr';

const app = express();
app.use(express.json());
app.use('/radarr/api/v3', radarrRouter);
app.use('/sonarr/api/v3', sonarrRouter);

const KEY = 'test-key-0123456789abcdef';

/**
 * Contract captured from a live Jellyseerr 2.7.3 driving a stand-in server.
 * The two details these tests pin down are the ones guesswork gets wrong:
 * authentication travels in the query string, and the path is camelCase.
 */
describe('Radarr/Sonarr-compatible endpoint', () => {
  beforeEach(() => {
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    movies.length = 0; seasons.length = 0; downloads.length = 0;
    jdPackages.value = [];
    nextId = 1; nextSeasonId = 1;
    mockSettings['arr.enabled'] = 'true';
    mockSettings['arr.api_key'] = KEY;
    mockSettings['paths.movies'] = '/movies';
    mockSettings['paths.series'] = '/series';
    mockSettings['quality.minimum'] = '1080p';
  });

  describe('authentication', () => {
    it('accepts the key as a query parameter — how Seerr sends it', async () => {
      const res = await request(app).get(`/radarr/api/v3/system/status?apikey=${KEY}`);
      expect(res.status).toBe(200);
    });

    it('also accepts the header, for clients that use it', async () => {
      const res = await request(app).get('/radarr/api/v3/system/status').set('X-Api-Key', KEY);
      expect(res.status).toBe(200);
    });

    it('rejects a wrong key', async () => {
      const res = await request(app).get('/radarr/api/v3/system/status?apikey=nope');
      expect(res.status).toBe(401);
    });

    it('rejects a missing key', async () => {
      const res = await request(app).get('/radarr/api/v3/system/status');
      expect(res.status).toBe(401);
    });

    it('is invisible while disabled — not even a 401 to probe', async () => {
      mockSettings['arr.enabled'] = 'false';
      const res = await request(app).get(`/radarr/api/v3/system/status?apikey=${KEY}`);
      expect(res.status).toBe(404);
    });

    it('mints a key on first use so setup never blocks on it', () => {
      delete mockSettings['arr.api_key'];
      const key = getArrApiKey();
      expect(key).toHaveLength(32);
      expect(getArrApiKey()).toBe(key);   // stable across calls
    });
  });

  describe('the connection handshake', () => {
    it('identifies as Radarr or Sonarr depending on the mount', async () => {
      const r = await request(app).get(`/radarr/api/v3/system/status?apikey=${KEY}`);
      const s = await request(app).get(`/sonarr/api/v3/system/status?apikey=${KEY}`);
      expect(r.body.appName).toBe('Radarr');
      expect(s.body.appName).toBe('Sonarr');
    });

    it('answers the camelCase quality path Seerr actually requests', async () => {
      const res = await request(app).get(`/radarr/api/v3/qualityProfile?apikey=${KEY}`);
      expect(res.status).toBe(200);
      expect(res.body.map((p: any) => p.id)).toEqual([4, 3, 2, 1]);
    });

    it('answers /command — a 404 here made Seerr abandon the whole queue poll', async () => {
      // The tracker asks for /command before /queue. Its only log line was
      // "Unable to get queue from Radarr server", while /queue answered 200 to
      // an identical manual request — the failing call was a different one.
      const res = await request(app).get(`/radarr/api/v3/command?apikey=${KEY}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('accepts a command without pretending to run one', async () => {
      const res = await request(app).post(`/radarr/api/v3/command?apikey=${KEY}`).send({ name: 'RefreshMovie' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'RefreshMovie', status: 'completed' });
    });

    it('serves the four endpoints the handshake needs', async () => {
      for (const path of ['system/status', 'qualityProfile', 'rootfolder', 'tag']) {
        const res = await request(app).get(`/radarr/api/v3/${path}?apikey=${KEY}`);
        expect(res.status, path).toBe(200);
      }
    });
  });

  describe('root folders', () => {
    it('offers the movie library to Radarr and the series library to Sonarr', async () => {
      const r = await request(app).get(`/radarr/api/v3/rootfolder?apikey=${KEY}`);
      const s = await request(app).get(`/sonarr/api/v3/rootfolder?apikey=${KEY}`);
      expect(r.body.map((f: any) => f.path)).toEqual(['/movies']);
      expect(s.body.map((f: any) => f.path)).toEqual(['/series']);
    });

    it('adds the kids library once configured — what makes override rules useful', async () => {
      mockSettings['paths.kids_movies'] = '/kids-movies';
      const res = await request(app).get(`/radarr/api/v3/rootfolder?apikey=${KEY}`);
      expect(res.body.map((f: any) => f.path)).toEqual(['/movies', '/kids-movies']);
    });

    it('hides the kids library while it is unset', async () => {
      const res = await request(app).get(`/radarr/api/v3/rootfolder?apikey=${KEY}`);
      expect(res.body).toHaveLength(1);
    });
  });

  describe('lookup', () => {
    it('echoes a tmdb id back for Radarr', async () => {
      const res = await request(app).get(`/radarr/api/v3/movie/lookup?apikey=${KEY}&term=tmdb:603`);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].tmdbId).toBe(603);
    });

    it('echoes a tvdb id back for Sonarr — shows are addressed by tvdb, not tmdb', async () => {
      const res = await request(app).get(`/sonarr/api/v3/series/lookup?apikey=${KEY}&term=tvdb:121361`);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].tvdbId).toBe(121361);
    });

    it('returns nothing for a term it cannot parse', async () => {
      const res = await request(app).get(`/radarr/api/v3/movie/lookup?apikey=${KEY}&term=whatever`);
      expect(res.body).toEqual([]);
    });
  });

  describe('adding a movie', () => {
    const add = (body: any) => request(app).post(`/radarr/api/v3/movie?apikey=${KEY}`).send(body);
    // Exactly the payload a live Seerr sent.
    const payload = {
      title: 'Matrix', qualityProfileId: 1, profileId: 1, titleSlug: '603',
      minimumAvailability: 'released', tmdbId: 603, year: 1999,
      rootFolderPath: '/movies', monitored: true, tags: [],
      addOptions: { searchForMovie: true },
    };

    it('queues the title', async () => {
      const res = await add({ ...payload, qualityProfileId: 3 });
      expect(res.status).toBe(201);
      expect(movies[0]).toMatchObject({
        title: 'Matrix', year: 1999, tmdb_id: 603,
        media_type: 'movie', status: 'pending', watchlist_source: 'seerr',
      });
    });

    it('honours the chosen quality profile — per-request quality, the point of doing this', async () => {
      await add({ ...payload, qualityProfileId: 4 });
      expect(movies[0].desired_quality).toBe('2160p');
    });

    it('falls back to the configured floor for an unknown profile', async () => {
      await add({ ...payload, qualityProfileId: 99 });
      expect(movies[0].desired_quality).toBe('1080p');
    });

    it('reports an already-tracked title as accepted, not as an error', async () => {
      // Mirroring Radarr's 400 here was wrong in effect: Seerr logs "you can
      // safely ignore this error" and then marks the request FAILED anyway, so
      // a title dlvault was already handling showed up red for the requester.
      await add(payload);
      const second = await add(payload);

      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({ tmdbId: 603, title: 'Matrix' });
      expect(movies).toHaveLength(1);
    });

    it('refuses a payload with no tmdb id', async () => {
      const res = await add({ title: 'x' });
      expect(res.status).toBe(400);
    });
  });

  describe('adding a show', () => {
    const add = (body: any) => request(app).post(`/sonarr/api/v3/series?apikey=${KEY}`).send(body);
    // Exactly the payload a live Seerr sent for seasons 1 and 2.
    const payload = {
      tvdbId: 121361, title: 'Game of Thrones', qualityProfileId: 3, languageProfileId: 1,
      seasons: [
        { seasonNumber: 0, monitored: false },
        { seasonNumber: 1, monitored: true },
        { seasonNumber: 2, monitored: true },
        { seasonNumber: 3, monitored: false },
      ],
      tags: [], seasonFolder: true, monitored: true, rootFolderPath: '/series',
      seriesType: 'standard',
      addOptions: { ignoreEpisodesWithFiles: true, searchForMissingEpisodes: true },
    };

    it('creates only the seasons flagged monitored', async () => {
      const res = await add(payload);
      expect(res.status).toBe(201);
      expect(seasons.map(s => s.season_number).sort()).toEqual([1, 2]);
    });

    it('counts a season whose payload omits the monitored flag', async () => {
      // Requiring monitored === true yielded an empty set for such a payload,
      // which left the season limit unset — and the pipeline then discovered
      // every season at the source.
      await add({ ...payload, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }] });

      expect(seasons.map(s => s.season_number).sort()).toEqual([1, 2]);
      expect(movies[0].seasons_explicit).toBe(1);
    });

    it('still skips a season explicitly marked unmonitored', async () => {
      await add({ ...payload, seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: false }] });
      expect(seasons.map(s => s.season_number)).toEqual([1]);
    });

    it('never creates season 0 even when Seerr flags it', async () => {
      await add({ ...payload, seasons: [{ seasonNumber: 0, monitored: true }, { seasonNumber: 1, monitored: true }] });
      expect(seasons.some(s => s.season_number === 0)).toBe(false);
    });

    it('widens an existing show instead of duplicating it', async () => {
      await add(payload);
      expect(movies).toHaveLength(1);

      await add({ ...payload, tmdbId: undefined, seasons: [{ seasonNumber: 3, monitored: true }] });
      expect(movies).toHaveLength(1);
      expect(seasons.map(s => s.season_number).sort()).toEqual([1, 2, 3]);
    });

    it('marks the season set as closed so the pipeline cannot widen it', async () => {
      // Requesting S1+S2 of an eight-season show used to queue all eight, because
      // processShowSeasons auto-discovers whatever it finds at the source.
      await add(payload);
      expect(movies[0].seasons_explicit).toBe(1);
    });

    it('refuses a payload with neither tvdb nor tmdb id', async () => {
      const res = await add({ title: 'x', seasons: [] });
      expect(res.status).toBe(400);
    });
  });

  describe('reporting back', () => {
    it('lists tracked movies with their download state', async () => {
      movies.push({ id: 1, title: 'A', year: 2020, tmdb_id: 1, imdb_id: 'tt1', slug: 'a', media_type: 'movie', status: 'downloaded', desired_quality: '1080p' });
      movies.push({ id: 2, title: 'B', year: 2021, tmdb_id: 2, imdb_id: 'tt2', slug: 'b', media_type: 'movie', status: 'pending', desired_quality: '2160p' });

      const res = await request(app).get(`/radarr/api/v3/movie?apikey=${KEY}`);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({ hasFile: true, monitored: false, qualityProfileId: 3 });
      expect(res.body[1]).toMatchObject({ hasFile: false, monitored: true, qualityProfileId: 4 });
    });

    it('keeps movies out of the Sonarr list and shows out of the Radarr list', async () => {
      movies.push({ id: 1, title: 'A', year: 2020, tmdb_id: 1, slug: 'a', media_type: 'movie', status: 'pending', desired_quality: '1080p' });
      movies.push({ id: 2, title: 'S', year: 2021, tmdb_id: 2, slug: 's', media_type: 'show', status: 'pending', desired_quality: '1080p' });

      const r = await request(app).get(`/radarr/api/v3/movie?apikey=${KEY}`);
      const s = await request(app).get(`/sonarr/api/v3/series?apikey=${KEY}`);
      expect(r.body).toHaveLength(1);
      expect(s.body).toHaveLength(1);
      expect(s.body[0].title).toBe('S');
    });

    it('reports per-season progress so Seerr can show partial availability', async () => {
      movies.push({ id: 1, title: 'S', year: 2021, tmdb_id: 2, slug: 's', media_type: 'show', status: 'downloading', desired_quality: '1080p' });
      seasons.push({ id: 1, movie_id: 1, season_number: 1, status: 'downloaded', episode_count: 10 });
      seasons.push({ id: 2, movie_id: 1, season_number: 2, status: 'pending', episode_count: 10 });

      const res = await request(app).get(`/sonarr/api/v3/series?apikey=${KEY}`);
      const [s1, s2] = res.body[0].seasons;
      expect(s1.statistics.percentOfEpisodes).toBe(100);
      expect(s2.statistics.percentOfEpisodes).toBe(0);
    });

    it('puts titles dlvault is working on into the queue', async () => {
      movies.push({ id: 1, title: 'Busy', year: 2020, tmdb_id: 1, slug: 'b', media_type: 'movie', status: 'downloading', desired_quality: '1080p' });
      movies.push({ id: 2, title: 'Done', year: 2020, tmdb_id: 2, slug: 'd', media_type: 'movie', status: 'downloaded', desired_quality: '1080p' });
      downloads.push({ id: 9, movie_id: 1, release_name: 'Busy.2020.1080p', status: 'sent_to_jd' });

      const res = await request(app).get(`/radarr/api/v3/queue?apikey=${KEY}`);
      expect(res.body.totalRecords).toBe(1);
      expect(res.body.records[0]).toMatchObject({ title: 'Busy.2020.1080p', movieId: 1, status: 'downloading' });
    });

    it('reports real byte counts from JDownloader', async () => {
      // Zeroes here were not merely uninformative: Seerr computes progress as
      // (size - sizeleft) / size, so a zero size left its download bar empty.
      movies.push({ id: 1, title: 'Busy', year: 2020, tmdb_id: 1, slug: 'b', media_type: 'movie', status: 'downloading', desired_quality: '1080p' });
      downloads.push({ id: 9, movie_id: 1, release_name: 'Busy.2020', status: 'sent_to_jd' });
      // Matched by name prefix — the package-id column is never written to.
      jdPackages.value = [{ name: 'Busy (2020) - 1080p', bytesLoaded: 4_000_000_000, bytesTotal: 10_000_000_000, eta: 600 }];

      const res = await request(app).get(`/radarr/api/v3/queue?apikey=${KEY}`);
      const r = res.body.records[0];

      expect(r.size).toBe(10_000_000_000);
      expect(r.sizeleft).toBe(6_000_000_000);
      expect(r.timeleft).toBe('00:10:00');
      expect(r.estimatedCompletionTime).toBeTruthy();
    });

    it('adds up the parts of a multi-package title', async () => {
      movies.push({ id: 1, title: 'Pack', year: 2020, tmdb_id: 1, slug: 'p', media_type: 'show', status: 'downloading', desired_quality: '1080p' });
      jdPackages.value = [
        { name: 'Pack (2020) - S01 - 1080p', bytesLoaded: 1_000, bytesTotal: 3_000, eta: 100 },
        { name: 'Pack (2020) - S02 - 1080p', bytesLoaded: 500, bytesTotal: 2_000, eta: 400 },
      ];

      const res = await request(app).get(`/sonarr/api/v3/queue?apikey=${KEY}`);
      const r = res.body.records[0];

      expect(r.size).toBe(5_000);
      expect(r.sizeleft).toBe(3_500);
      // The slowest part decides when the title as a whole is done.
      expect(r.timeleft).toBe('00:06:40');
    });

    it('ignores another title\'s packages', async () => {
      movies.push({ id: 1, title: 'Busy', year: 2020, tmdb_id: 1, slug: 'b', media_type: 'movie', status: 'downloading', desired_quality: '1080p' });
      jdPackages.value = [
        { name: 'Busy (2020) - 1080p', bytesLoaded: 100, bytesTotal: 200, eta: 10 },
        { name: 'Something Else (2021) - 1080p', bytesLoaded: 9_999, bytesTotal: 9_999, eta: 5 },
      ];

      const res = await request(app).get(`/radarr/api/v3/queue?apikey=${KEY}`);
      expect(res.body.records[0].size).toBe(200);
    });

    it('matches a title whose name JDownloader had to sanitise', async () => {
      // JD refuses a colon in a package name; dlvault writes a semicolon.
      movies.push({ id: 1, title: 'Alien: Romulus', year: 2024, tmdb_id: 1, slug: 'a', media_type: 'movie', status: 'downloading', desired_quality: '1080p' });
      jdPackages.value = [{ name: 'Alien; Romulus (2024) - 1080p', bytesLoaded: 50, bytesTotal: 100, eta: 30 }];

      const res = await request(app).get(`/radarr/api/v3/queue?apikey=${KEY}`);
      expect(res.body.records[0].sizeleft).toBe(50);
    });

    it('carries every field a real Radarr sends', async () => {
      // Omitting these made Seerr's client throw away the entire response while
      // logging only "Unable to get queue" — the endpoint itself answered 200.
      movies.push({ id: 1, title: 'Busy', year: 2020, tmdb_id: 1, slug: 'b', media_type: 'movie', status: 'downloading', desired_quality: '1080p' });
      jdPackages.value = [{ name: 'Busy (2020) - 1080p', bytesLoaded: 1, bytesTotal: 2, eta: 5 }];

      const res = await request(app).get(`/radarr/api/v3/queue?apikey=${KEY}`);

      expect(res.body).toMatchObject({ sortKey: 'timeleft', sortDirection: 'ascending' });
      for (const field of ['languages', 'quality', 'customFormats', 'statusMessages',
                           'downloadId', 'protocol', 'downloadClient', 'indexer', 'outputPath']) {
        expect(res.body.records[0], field).toHaveProperty(field);
      }
    });

    it('omits the completion time when there is no estimate', async () => {
      // Seerr turns a null into the epoch, so a queued title claimed to have
      // finished in 1970.
      movies.push({ id: 1, title: 'Queued', year: 2020, tmdb_id: 1, slug: 'q', media_type: 'movie', status: 'downloading', desired_quality: '1080p' });
      jdPackages.value = [{ name: 'Queued (2020) - 1080p', bytesLoaded: 0, bytesTotal: 500, eta: 0 }];

      const res = await request(app).get(`/radarr/api/v3/queue?apikey=${KEY}`);
      expect(res.body.records[0]).not.toHaveProperty('estimatedCompletionTime');
      expect(res.body.records[0].size).toBe(500);
    });

    it('still lists the title when JDownloader cannot be reached', async () => {
      jdPackages.value = null;
      movies.push({ id: 1, title: 'Busy', year: 2020, tmdb_id: 1, slug: 'b', media_type: 'movie', status: 'downloading', desired_quality: '1080p' });

      const res = await request(app).get(`/radarr/api/v3/queue?apikey=${KEY}`);
      expect(res.body.totalRecords).toBe(1);
      expect(res.body.records[0].size).toBe(0);
    });

    it('counts a title as queued from the moment the search starts', async () => {
      movies.push({ id: 1, title: 'Searching', year: 2020, tmdb_id: 1, slug: 's', media_type: 'movie', status: 'searching', desired_quality: '1080p' });

      const res = await request(app).get(`/radarr/api/v3/queue?apikey=${KEY}`);
      expect(res.body.totalRecords).toBe(1);
      expect(res.body.records[0].status).toBe('queued');
    });
  });
});
