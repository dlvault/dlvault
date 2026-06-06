import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/services/movies', () => ({
  getAllMovies: vi.fn(() => []),
  getMovieById: vi.fn(),
  deleteMovie: vi.fn(),
  updateMovieStatus: vi.fn(),
  resetRetryCount: vi.fn(),
  updateLastRetryAt: vi.fn(),
  setSeasonCutoff: vi.fn(),
  updateQualityOverride: vi.fn(),
  addMovie: vi.fn(),
  getMovieByImdbId: vi.fn(),
  getMovieByTmdbId: vi.fn(),
}));
vi.mock('../../src/database/index', () => ({ getSetting: vi.fn(() => '') }));
vi.mock('../../src/services/trakt', () => ({
  traktService: { isConfigured: vi.fn(() => false), isAuthenticated: vi.fn(() => false), addToWatchlist: vi.fn(() => Promise.resolve()) },
}));
vi.mock('../../src/services/plex', () => ({
  plexService: { isConfigured: vi.fn(() => false), addToWatchlist: vi.fn(() => Promise.resolve()) },
}));
vi.mock('../../src/database/services/downloads', () => ({ getDownloadsByMovieId: vi.fn(() => []) }));
vi.mock('../../src/database/services/activityLog', () => ({
  addLogEntry: vi.fn(), getLogsByMovieId: vi.fn(() => []),
}));
vi.mock('../../src/database/services/seasons', () => ({ getSeasonsByShowId: vi.fn(() => []) }));
vi.mock('../../src/database/services/episodes', () => ({ getEpisodesBySeasonId: vi.fn(() => []) }));
vi.mock('../../src/services/scheduler', () => ({ processMovie: vi.fn(() => Promise.resolve()) }));
vi.mock('../../src/services/metadata', () => ({ enrichMovieMetadata: vi.fn(() => Promise.resolve(null)) }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import express from 'express';
import request from 'supertest';
import router from '../../src/api/routes/movies';
import * as moviesSvc from '../../src/database/services/movies';
import { addLogEntry } from '../../src/database/services/activityLog';
import { processMovie } from '../../src/services/scheduler';
import { getSetting } from '../../src/database/index';
import { traktService } from '../../src/services/trakt';
import { plexService } from '../../src/services/plex';

const app = express();
app.use(express.json());
app.use('/api/movies', router);

const film = { id: 1, title: 'A Film', year: 2024, media_type: 'movie', status: 'not_found', last_retry_at: null };
const serie = { id: 2, title: 'A Show', year: 2020, media_type: 'show', status: 'downloaded', last_retry_at: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(moviesSvc.getMovieById).mockReset();
});

describe('DELETE /api/movies/:id', () => {
  it('deletes and reports success', async () => {
    const res = await request(app).delete('/api/movies/1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(moviesSvc.deleteMovie).toHaveBeenCalledWith(1);
  });

  it('answers 500 rather than crashing when the delete throws', async () => {
    vi.mocked(moviesSvc.deleteMovie).mockImplementationOnce(() => { throw new Error('DB locked'); });
    const res = await request(app).delete('/api/movies/1');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to delete/);
  });
});

describe('POST /api/movies/:id/retry', () => {
  it('404s for a title that is not tracked', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue(undefined as any);
    const res = await request(app).post('/api/movies/99/retry');
    expect(res.status).toBe(404);
    expect(processMovie).not.toHaveBeenCalled();
  });

  it('resets the title and starts a fresh search', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue({ ...film } as any);
    const res = await request(app).post('/api/movies/1/retry');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Retry started' });
    expect(moviesSvc.updateMovieStatus).toHaveBeenCalledWith(1, 'pending');
    expect(moviesSvc.resetRetryCount).toHaveBeenCalledWith(1);
    expect(moviesSvc.updateLastRetryAt).toHaveBeenCalledWith(1);
    expect(processMovie).toHaveBeenCalled();
  });

  it('retries a title stuck in downloading — its JD package may be long gone', async () => {
    // Refusing this left a movie permanently stuck when its download vanished
    // out from under it, with no way back through the UI.
    vi.mocked(moviesSvc.getMovieById).mockReturnValue({ ...film, status: 'downloading' } as any);
    const res = await request(app).post('/api/movies/1/retry');
    expect(res.status).toBe(200);
    expect(processMovie).toHaveBeenCalled();
  });

  it('refuses a second retry inside the 60s cooldown', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue({
      ...film, last_retry_at: new Date(Date.now() - 10_000).toISOString().replace('T', ' ').replace('Z', ''),
    } as any);

    const res = await request(app).post('/api/movies/1/retry');

    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/\d+s/);
    expect(processMovie).not.toHaveBeenCalled();
  });

  it('allows the retry again once the cooldown has passed', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue({
      ...film, last_retry_at: new Date(Date.now() - 120_000).toISOString().replace('T', ' ').replace('Z', ''),
    } as any);

    const res = await request(app).post('/api/movies/1/retry');

    expect(res.status).toBe(200);
    expect(processMovie).toHaveBeenCalled();
  });

  it('404s when the title disappears between the reset and the re-read', async () => {
    vi.mocked(moviesSvc.getMovieById)
      .mockReturnValueOnce({ ...film } as any)
      .mockReturnValueOnce(undefined as any);

    const res = await request(app).post('/api/movies/1/retry');

    expect(res.status).toBe(404);
    expect(processMovie).not.toHaveBeenCalled();
  });
});

describe('PUT /api/movies/:id/season-cutoff', () => {
  it('404s for an unknown title', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue(undefined as any);
    const res = await request(app).put('/api/movies/9/season-cutoff').send({ cutoff: 2 });
    expect(res.status).toBe(404);
  });

  it('refuses it for a movie — the cutoff is a series concept', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue({ ...film } as any);
    const res = await request(app).put('/api/movies/1/season-cutoff').send({ cutoff: 2 });
    expect(res.status).toBe(400);
    expect(moviesSvc.setSeasonCutoff).not.toHaveBeenCalled();
  });

  it('stores a positive cutoff and records it', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue({ ...serie } as any);
    const res = await request(app).put('/api/movies/2/season-cutoff').send({ cutoff: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, season_cutoff: 3 });
    expect(moviesSvc.setSeasonCutoff).toHaveBeenCalledWith(2, 3);
    expect(addLogEntry).toHaveBeenCalledWith(2, 'season_cutoff_set', expect.stringContaining('Staffel 3'));
  });

  it.each([null, '', undefined])('clears the cutoff for %p', async (raw) => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue({ ...serie } as any);
    const res = await request(app).put('/api/movies/2/season-cutoff').send({ cutoff: raw });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, season_cutoff: null });
    expect(moviesSvc.setSeasonCutoff).toHaveBeenCalledWith(2, null);
  });

  it.each([0, -1, 1.5, 'zwei'])('rejects %p as a cutoff', async (raw) => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue({ ...serie } as any);
    const res = await request(app).put('/api/movies/2/season-cutoff').send({ cutoff: raw });

    expect(res.status).toBe(400);
    expect(moviesSvc.setSeasonCutoff).not.toHaveBeenCalled();
  });
});

describe('PUT /api/movies/:id/quality-override', () => {
  it('404s for an unknown title', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue(undefined as any);
    const res = await request(app).put('/api/movies/9/quality-override').send({ mode: 'relaxed' });
    expect(res.status).toBe(404);
  });

  it.each(['relaxed', 'any'] as const)('accepts %s', async (mode) => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue({ ...film } as any);
    const res = await request(app).put('/api/movies/1/quality-override').send({ mode });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, quality_override: mode });
    expect(moviesSvc.updateQualityOverride).toHaveBeenCalledWith(1, mode);
  });

  it('restores the global filter when the mode is cleared', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue({ ...film } as any);
    const res = await request(app).put('/api/movies/1/quality-override').send({ mode: null });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, quality_override: null });
    expect(moviesSvc.updateQualityOverride).toHaveBeenCalledWith(1, null);
  });

  it('rejects a mode it does not know', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue({ ...film } as any);
    const res = await request(app).put('/api/movies/1/quality-override').send({ mode: 'alles' });

    expect(res.status).toBe(400);
    expect(moviesSvc.updateQualityOverride).not.toHaveBeenCalled();
  });
});

describe('POST /api/movies/manual-add', () => {
  const created = (over: Record<string, unknown> = {}) =>
    ({ id: 5, title: 'Neu', status: 'pending', ...over }) as any;

  beforeEach(() => {
    vi.mocked(getSetting).mockReturnValue('');
    vi.mocked(moviesSvc.getMovieByImdbId).mockReturnValue(undefined as any);
    vi.mocked(moviesSvc.getMovieByTmdbId).mockReturnValue(undefined as any);
    vi.mocked(moviesSvc.addMovie).mockReturnValue(created());
  });

  it('requires a title', async () => {
    const res = await request(app).post('/api/movies/manual-add').send({ year: 2024 });
    expect(res.status).toBe(400);
    expect(moviesSvc.addMovie).not.toHaveBeenCalled();
  });

  it('treats a blank title as missing', async () => {
    const res = await request(app).post('/api/movies/manual-add').send({ title: '   ' });
    expect(res.status).toBe(400);
  });

  it('adds a new title, logs it and starts the pipeline', async () => {
    const res = await request(app).post('/api/movies/manual-add')
      .send({ title: '  Neu  ', year: 2024, imdbId: 'tt9' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: 5, title: 'Neu', created: true });
    expect(moviesSvc.addMovie).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Neu', year: 2024, imdb_id: 'tt9', media_type: 'movie',
      watchlist_source: 'manual', status: 'pending', slug: 'neu',
    }));
    expect(addLogEntry).toHaveBeenCalledWith(5, 'movie_added', expect.stringContaining('Neu'));
    expect(processMovie).toHaveBeenCalled();
  });

  it('honours the configured minimum quality instead of a hardcoded 1080p', async () => {
    // Otherwise a manual add fetches 1080p and auto_upgrade immediately
    // re-downloads the very same title.
    vi.mocked(getSetting).mockImplementation((k: string) => (k === 'quality.minimum' ? '2160p' : ''));

    await request(app).post('/api/movies/manual-add').send({ title: 'Neu' });

    expect(moviesSvc.addMovie).toHaveBeenCalledWith(
      expect.objectContaining({ desired_quality: '2160p' }));
  });

  it('scopes the TMDb lookup to the requested media type', async () => {
    // The movie and TV id spaces overlap: an unscoped lookup once matched a film
    // for a requested show and kicked the pipeline on the wrong title.
    await request(app).post('/api/movies/manual-add').send({ title: 'Serie', tmdbId: 42, mediaType: 'show' });

    expect(moviesSvc.getMovieByTmdbId).toHaveBeenCalledWith(42, 'show');
    expect(moviesSvc.addMovie).toHaveBeenCalledWith(expect.objectContaining({ media_type: 'show' }));
  });

  it('reuses an existing entry instead of adding a duplicate', async () => {
    vi.mocked(moviesSvc.getMovieByImdbId).mockReturnValue(created({ id: 3, title: 'Schon da', status: 'not_found' }));

    const res = await request(app).post('/api/movies/manual-add').send({ title: 'Schon da', imdbId: 'tt3' });

    expect(res.body).toEqual({ ok: true, id: 3, title: 'Schon da', created: false });
    expect(moviesSvc.addMovie).not.toHaveBeenCalled();
    expect(processMovie).toHaveBeenCalled();   // still nudged: it has not landed yet
  });

  it.each(['downloaded', 'downloading'])('does not re-kick a title that is already %s', async (status) => {
    vi.mocked(moviesSvc.getMovieByImdbId).mockReturnValue(created({ id: 3, status }));

    const res = await request(app).post('/api/movies/manual-add').send({ title: 'X', imdbId: 'tt3' });

    expect(res.body.created).toBe(false);
    expect(processMovie).not.toHaveBeenCalled();
  });

  it('pushes to Trakt by default and to both when configured', async () => {
    await request(app).post('/api/movies/manual-add').send({ title: 'Neu' });
    expect(traktService.addToWatchlist).toHaveBeenCalled();
    expect(plexService.addToWatchlist).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(moviesSvc.addMovie).mockReturnValue(created());
    vi.mocked(getSetting).mockImplementation((k: string) => (k === 'watchlist.provider' ? 'both' : ''));

    await request(app).post('/api/movies/manual-add').send({ title: 'Neu' });
    expect(traktService.addToWatchlist).toHaveBeenCalled();
    expect(plexService.addToWatchlist).toHaveBeenCalled();
  });

  it('survives a watchlist push that rejects', async () => {
    // Best-effort: the title is added either way, the sync failure is logged.
    vi.mocked(traktService.addToWatchlist).mockRejectedValueOnce(new Error('trakt down'));

    const res = await request(app).post('/api/movies/manual-add').send({ title: 'Neu' });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(true);
  });

  it('answers 500 when the insert itself fails', async () => {
    vi.mocked(moviesSvc.addMovie).mockImplementationOnce(() => { throw new Error('UNIQUE constraint'); });

    const res = await request(app).post('/api/movies/manual-add').send({ title: 'Neu' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/UNIQUE/);
  });
});
