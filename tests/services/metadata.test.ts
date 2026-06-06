import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/index', () => ({ getSetting: vi.fn(() => '') }));
vi.mock('../../src/database/services/movies', () => ({
  getMovieById: vi.fn(),
  getMovieByImdbId: vi.fn(() => undefined),
  setMovieImdbId: vi.fn(() => true),
  setMovieYear: vi.fn(),
  updateMovieMetadata: vi.fn(),
}));
vi.mock('../../src/services/omdb', () => ({
  findImdbId: vi.fn(async () => null),
  getMovieDetails: vi.fn(async () => null),
  isConfigured: vi.fn(() => false),
}));
vi.mock('../../src/services/seerr', () => ({ seerrService: { getMeta: vi.fn(async () => null) } }));
vi.mock('../../src/services/tmdb', () => ({ tmdbService: { getImdbId: vi.fn(async () => null) } }));
vi.mock('../../src/services/trakt', () => ({ traktService: { getTranslation: vi.fn(async () => null) } }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { resolveMovieImdbId } from '../../src/services/metadata';
import * as movies from '../../src/database/services/movies';
import * as omdb from '../../src/services/omdb';
import { seerrService } from '../../src/services/seerr';
import { tmdbService } from '../../src/services/tmdb';
import { logger } from '../../src/utils/logger';

/** A row the way Seerr's Radarr contract creates it: tmdb id + localized title, no imdb id. */
const row = (o: Partial<any> = {}): any => ({
  id: 7, title: 'Der Weg nach Hause', year: 2026, imdb_id: '', tmdb_id: 4242, media_type: 'movie', ...o,
});
const meta = (imdbId: string | null, year = 2026): any =>
  ({ title: 'X', year, releaseDate: year ? `${year}-01-01` : '', imdbId, seasons: [] });

describe('resolveMovieImdbId — where the id comes from', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(movies.setMovieImdbId).mockReturnValue(true);
    vi.mocked(movies.getMovieByImdbId).mockReturnValue(undefined);
    // The row is re-read after the write; hand back a copy that carries the id.
    vi.mocked(movies.getMovieById).mockImplementation(((id: number) => row({ id, imdb_id: 'tt-fresh' })) as any);
    vi.mocked(omdb.isConfigured).mockReturnValue(false);
    vi.mocked(omdb.findImdbId).mockResolvedValue(null);
    vi.mocked(seerrService.getMeta).mockResolvedValue(null);
    vi.mocked(tmdbService.getImdbId).mockResolvedValue(null);
  });

  it('leaves a row that already has an id alone', async () => {
    const m = row({ imdb_id: 'tt1' });
    expect(await resolveMovieImdbId(m)).toBe(m);
    expect(seerrService.getMeta).not.toHaveBeenCalled();
    expect(omdb.findImdbId).not.toHaveBeenCalled();
  });

  it('asks Seerr by tmdb id first and never bothers OMDb with a localized title', async () => {
    vi.mocked(seerrService.getMeta).mockResolvedValue(meta('tt4242'));
    vi.mocked(omdb.isConfigured).mockReturnValue(true);

    const out = await resolveMovieImdbId(row());

    expect(seerrService.getMeta).toHaveBeenCalledWith('movie', 4242);
    expect(movies.setMovieImdbId).toHaveBeenCalledWith(7, 'tt4242');
    expect(omdb.findImdbId).not.toHaveBeenCalled();
    expect(out.imdb_id).toBe('tt-fresh');
  });

  it('asks TMDb directly when Seerr has no answer', async () => {
    vi.mocked(tmdbService.getImdbId).mockResolvedValue('tt5555');
    await resolveMovieImdbId(row());
    expect(tmdbService.getImdbId).toHaveBeenCalledWith('movie', 4242);
    expect(movies.setMovieImdbId).toHaveBeenCalledWith(7, 'tt5555');
  });

  it('uses the tv endpoints for a show', async () => {
    vi.mocked(seerrService.getMeta).mockResolvedValue(meta('tt7', 2023));
    await resolveMovieImdbId(row({ media_type: 'show' }));
    expect(seerrService.getMeta).toHaveBeenCalledWith('tv', 4242);
  });

  it('completes a missing year from the same answer, but never overwrites one', async () => {
    vi.mocked(seerrService.getMeta).mockResolvedValue(meta('tt7', 2023));

    await resolveMovieImdbId(row({ year: 0 }));
    expect(movies.setMovieYear).toHaveBeenCalledWith(7, 2023);

    vi.mocked(movies.setMovieYear).mockClear();
    await resolveMovieImdbId(row({ year: 2026 }));
    expect(movies.setMovieYear).not.toHaveBeenCalled();
  });

  it('falls back to OMDb by title when the tmdb id leads nowhere', async () => {
    vi.mocked(omdb.isConfigured).mockReturnValue(true);
    vi.mocked(omdb.findImdbId).mockResolvedValue('tt9');
    await resolveMovieImdbId(row());
    expect(omdb.findImdbId).toHaveBeenCalledWith('Der Weg nach Hause', 2026, 'movie');
    expect(movies.setMovieImdbId).toHaveBeenCalledWith(7, 'tt9');
  });

  it('goes straight to OMDb for a title-only row', async () => {
    vi.mocked(omdb.isConfigured).mockReturnValue(true);
    vi.mocked(omdb.findImdbId).mockResolvedValue('tt9');
    await resolveMovieImdbId(row({ tmdb_id: null }));
    expect(seerrService.getMeta).not.toHaveBeenCalled();
    expect(tmdbService.getImdbId).not.toHaveBeenCalled();
    expect(movies.setMovieImdbId).toHaveBeenCalledWith(7, 'tt9');
  });

  it('writes nothing when nobody knows the id', async () => {
    const m = row();
    expect(await resolveMovieImdbId(m)).toBe(m);
    expect(movies.setMovieImdbId).not.toHaveBeenCalled();
    expect(movies.setMovieYear).not.toHaveBeenCalled();
  });

  it('refuses to merge into another entry that already owns the id, and names it', async () => {
    vi.mocked(seerrService.getMeta).mockResolvedValue(meta('tt4242'));
    vi.mocked(movies.setMovieImdbId).mockReturnValue(false);
    vi.mocked(movies.getMovieByImdbId).mockReturnValue({ id: 3, title: 'Other' } as any);

    const m = row();
    expect(await resolveMovieImdbId(m)).toBe(m);
    expect(movies.setMovieYear).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"Other" (#3)'));
  });

  it('survives a lookup that throws', async () => {
    vi.mocked(tmdbService.getImdbId).mockRejectedValue(new Error('boom'));
    const m = row();
    expect(await resolveMovieImdbId(m)).toBe(m);
    expect(movies.setMovieImdbId).not.toHaveBeenCalled();
  });
});
