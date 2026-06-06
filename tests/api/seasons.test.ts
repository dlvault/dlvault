import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/services/movies', () => ({
  getMovieById: vi.fn(),
}));

vi.mock('../../src/database/services/seasons', () => ({
  getSeasonsByShowId: vi.fn(() => []),
  addSeason: vi.fn(),
  addSeasons: vi.fn(),
  updateSeasonStatus: vi.fn(),
  deleteSeason: vi.fn(),
  getSeason: vi.fn(),
}));

vi.mock('../../src/database/services/episodes', () => ({
  getEpisodesBySeasonId: vi.fn(() => []),
  addEpisodes: vi.fn(),
  updateEpisodeStatus: vi.fn(),
  getSeasonCompletionStatus: vi.fn(() => ({ total: 0, downloaded: 0, allDone: false })),
}));

vi.mock('../../src/database/services/activityLog', () => ({
  addLogEntry: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import express from 'express';
import request from 'supertest';
import router from '../../src/api/routes/seasons';
import * as moviesSvc from '../../src/database/services/movies';
import * as seasonsSvc from '../../src/database/services/seasons';
import * as episodesSvc from '../../src/database/services/episodes';
import { addLogEntry } from '../../src/database/services/activityLog';

const app = express();
app.use(express.json());
app.use('/api/seasons', router);

const showMovie = { id: 1, title: 'My Show', media_type: 'show' };
const movieMovie = { id: 2, title: 'A Film', media_type: 'movie' };

beforeEach(() => {
  vi.mocked(moviesSvc.getMovieById).mockReset();
  vi.mocked(seasonsSvc.getSeasonsByShowId).mockReset().mockReturnValue([] as any);
  vi.mocked(seasonsSvc.addSeason).mockReset();
  vi.mocked(seasonsSvc.addSeasons).mockReset();
  vi.mocked(seasonsSvc.updateSeasonStatus).mockReset();
  vi.mocked(seasonsSvc.deleteSeason).mockReset();
  vi.mocked(seasonsSvc.getSeason).mockReset();
  vi.mocked(episodesSvc.getEpisodesBySeasonId).mockReset().mockReturnValue([] as any);
  vi.mocked(episodesSvc.updateEpisodeStatus).mockReset();
  vi.mocked(episodesSvc.getSeasonCompletionStatus).mockReset().mockReturnValue({ total: 0, downloaded: 0, allDone: false } as any);
  vi.mocked(addLogEntry).mockReset();
});

describe('GET /api/seasons/:movieId', () => {
  it('404 when show not found', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue(null as any);
    const res = await request(app).get('/api/seasons/99');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Show not found' });
  });

  it('400 when not a show', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue(movieMovie as any);
    const res = await request(app).get('/api/seasons/2');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Not a show' });
  });

  it('returns seasons with completion stats', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue(showMovie as any);
    vi.mocked(seasonsSvc.getSeasonsByShowId).mockReturnValue([{ id: 10, season_number: 1 }] as any);
    vi.mocked(episodesSvc.getSeasonCompletionStatus).mockReturnValue({ total: 10, downloaded: 5, allDone: false } as any);
    const res = await request(app).get('/api/seasons/1');
    expect(res.status).toBe(200);
    expect(res.body.show).toMatchObject({ id: 1 });
    expect(res.body.seasons[0]).toMatchObject({ id: 10, episodes_total: 10, episodes_downloaded: 5, episodes_complete: false });
  });
});

describe('POST /api/seasons/:movieId', () => {
  it('404 when show not found', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue(null as any);
    const res = await request(app).post('/api/seasons/99').send({ seasonNumber: 1 });
    expect(res.status).toBe(404);
  });

  it('adds multiple seasons via seasonNumbers', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue(showMovie as any);
    vi.mocked(seasonsSvc.addSeasons).mockReturnValue([{ id: 1 }, { id: 2 }] as any);
    const res = await request(app).post('/api/seasons/1').send({ seasonNumbers: [1, 2], quality: '1080p' });
    expect(res.status).toBe(200);
    expect(res.body.seasons).toHaveLength(2);
    expect(seasonsSvc.addSeasons).toHaveBeenCalledWith(1, [1, 2], '1080p');
    expect(addLogEntry).toHaveBeenCalledWith(1, 'seasons_added', expect.any(String));
  });

  it('400 when seasonNumbers all invalid', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue(showMovie as any);
    const res = await request(app).post('/api/seasons/1').send({ seasonNumbers: [0, -1, 1.5] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid season numbers' });
  });

  it('adds a single season via seasonNumber', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue(showMovie as any);
    vi.mocked(seasonsSvc.addSeason).mockReturnValue({ id: 3, season_number: 3 } as any);
    const res = await request(app).post('/api/seasons/1').send({ seasonNumber: 3 });
    expect(res.status).toBe(200);
    expect(res.body.season).toMatchObject({ id: 3 });
    expect(seasonsSvc.addSeason).toHaveBeenCalledWith(1, 3, undefined);
    expect(addLogEntry).toHaveBeenCalledWith(1, 'season_added', expect.any(String));
  });

  it('400 when neither seasonNumber nor seasonNumbers provided', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue(showMovie as any);
    const res = await request(app).post('/api/seasons/1').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'seasonNumber or seasonNumbers required' });
  });

  it('400 when seasonNumber is invalid (zero)', async () => {
    vi.mocked(moviesSvc.getMovieById).mockReturnValue(showMovie as any);
    const res = await request(app).post('/api/seasons/1').send({ seasonNumber: 0 });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/seasons/:movieId/:seasonNumber', () => {
  it('404 when season not found', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue(undefined as any);
    const res = await request(app).put('/api/seasons/1/1').send({ status: 'wanted' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Season not found' });
  });

  it('400 when status missing', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue({ id: 10 } as any);
    const res = await request(app).put('/api/seasons/1/1').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'status required' });
  });

  it('updates season status', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue({ id: 10 } as any);
    const res = await request(app).put('/api/seasons/1/1').send({ status: 'downloaded' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(seasonsSvc.updateSeasonStatus).toHaveBeenCalledWith(10, 'downloaded');
  });

  it('500 when update throws', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue({ id: 10 } as any);
    vi.mocked(seasonsSvc.updateSeasonStatus).mockImplementation(() => { throw new Error('db'); });
    const res = await request(app).put('/api/seasons/1/1').send({ status: 'wanted' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to update season' });
  });
});

describe('DELETE /api/seasons/:movieId/:seasonNumber', () => {
  it('404 when season not found', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue(undefined as any);
    const res = await request(app).delete('/api/seasons/1/1');
    expect(res.status).toBe(404);
  });

  it('deletes the season', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue({ id: 10 } as any);
    const res = await request(app).delete('/api/seasons/1/1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(seasonsSvc.deleteSeason).toHaveBeenCalledWith(10);
  });

  it('500 when delete throws', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue({ id: 10 } as any);
    vi.mocked(seasonsSvc.deleteSeason).mockImplementation(() => { throw new Error('db'); });
    const res = await request(app).delete('/api/seasons/1/1');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to delete season' });
  });
});

describe('GET /api/seasons/:movieId/:seasonNumber/episodes', () => {
  it('404 when season not found', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue(undefined as any);
    const res = await request(app).get('/api/seasons/1/1/episodes');
    expect(res.status).toBe(404);
  });

  it('returns episodes and completion', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue({ id: 10, season_number: 1 } as any);
    vi.mocked(episodesSvc.getEpisodesBySeasonId).mockReturnValue([{ id: 1, episode_number: 1 }] as any);
    vi.mocked(episodesSvc.getSeasonCompletionStatus).mockReturnValue({ total: 1, downloaded: 0, allDone: false } as any);
    const res = await request(app).get('/api/seasons/1/1/episodes');
    expect(res.status).toBe(200);
    expect(res.body.episodes).toHaveLength(1);
    expect(res.body.completion).toMatchObject({ total: 1 });
  });
});

describe('PUT /api/seasons/:movieId/:seasonNumber/episodes/:episodeNumber', () => {
  it('404 when season not found', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue(undefined as any);
    const res = await request(app).put('/api/seasons/1/1/episodes/1').send({ status: 'x' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Season not found' });
  });

  it('404 when episode not found', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue({ id: 10 } as any);
    vi.mocked(episodesSvc.getEpisodesBySeasonId).mockReturnValue([{ id: 1, episode_number: 5 }] as any);
    const res = await request(app).put('/api/seasons/1/1/episodes/1').send({ status: 'x' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Episode not found' });
  });

  it('400 when status missing', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue({ id: 10 } as any);
    vi.mocked(episodesSvc.getEpisodesBySeasonId).mockReturnValue([{ id: 2, episode_number: 1 }] as any);
    const res = await request(app).put('/api/seasons/1/1/episodes/1').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'status required' });
  });

  it('updates episode status', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue({ id: 10 } as any);
    vi.mocked(episodesSvc.getEpisodesBySeasonId).mockReturnValue([{ id: 2, episode_number: 1 }] as any);
    const res = await request(app).put('/api/seasons/1/1/episodes/1').send({ status: 'downloaded' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(episodesSvc.updateEpisodeStatus).toHaveBeenCalledWith(2, 'downloaded');
  });

  it('500 when update throws', async () => {
    vi.mocked(seasonsSvc.getSeason).mockReturnValue({ id: 10 } as any);
    vi.mocked(episodesSvc.getEpisodesBySeasonId).mockReturnValue([{ id: 2, episode_number: 1 }] as any);
    vi.mocked(episodesSvc.updateEpisodeStatus).mockImplementation(() => { throw new Error('db'); });
    const res = await request(app).put('/api/seasons/1/1/episodes/1').send({ status: 'x' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to update episode' });
  });
});
