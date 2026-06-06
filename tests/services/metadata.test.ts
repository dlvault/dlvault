import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/index', () => ({ getSetting: vi.fn(() => '') }));
vi.mock('../../src/database/services/movies', () => ({
  getMovieById: vi.fn(),
  getMovieByImdbId: vi.fn(() => undefined),
  setMovieImdbId: vi.fn(() => true),
  setMovieYear: vi.fn(),
  updateMovieMetadata: vi.fn(),
  clearMovieMetadata: vi.fn(),
}));
vi.mock('../../src/services/omdb', () => ({
  findImdbId: vi.fn(async () => null),
  getMovieDetails: vi.fn(async () => null),
  isConfigured: vi.fn(() => false),
}));
vi.mock('../../src/services/seerr', () => ({ seerrService: { getMeta: vi.fn(async () => null), searchCatalog: vi.fn(async () => []) } }));
vi.mock('../../src/services/tmdb', () => ({ tmdbService: {
  getImdbId: vi.fn(async () => null),
  isConfigured: vi.fn(() => false),
  region: vi.fn(() => 'DE'),
  getShowAiring: vi.fn(),
  getMovieRelease: vi.fn(),
} }));
vi.mock('../../src/services/trakt', () => ({ traktService: { getTranslation: vi.fn(async () => null) } }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { resolveMovieImdbId, resolveMovieYear, verifyMovieImdbId } from '../../src/services/metadata';
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
    vi.mocked(seerrService.searchCatalog).mockResolvedValue([]);
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

  it('never guesses by title when the tmdb id has no imdb id yet', async () => {
    // A new release: TMDb lists no imdb id yet, and the title search found a
    // namesake (a 2-minute short of the same name).
    vi.mocked(omdb.isConfigured).mockReturnValue(true);
    vi.mocked(omdb.findImdbId).mockResolvedValue('tt9');
    vi.mocked(seerrService.searchCatalog).mockResolvedValue([{ type: 'movie', title: 'Der Weg nach Hause', year: 2026, imdbId: null, tmdbId: 1 } as any]);
    const m = row();
    expect(await resolveMovieImdbId(m)).toBe(m);
    expect(omdb.findImdbId).not.toHaveBeenCalled();
    expect(seerrService.searchCatalog).not.toHaveBeenCalled();
    expect(movies.setMovieImdbId).not.toHaveBeenCalled();
  });

  describe('title-only row with a localized title', () => {
    const hit = (title: string, tmdbId: number, year: number | null = 2022): any =>
      ({ type: 'show', title, year, imdbId: null, tmdbId });
    const localizedShow = () => row({ title: 'Stille Wasser – Ein Fall für Kommissar Berg', year: 2022, tmdb_id: null, media_type: 'show' });

    it('resolves through Seerr search, which knows the German title', async () => {
      vi.mocked(seerrService.searchCatalog).mockResolvedValue([hit('Stille Wasser - Ein Fall für Kommissar Berg', 4711)]);
      vi.mocked(seerrService.getMeta).mockResolvedValue(meta('tt0000042', 2022));

      await resolveMovieImdbId(localizedShow());

      expect(seerrService.searchCatalog).toHaveBeenCalledWith('Stille Wasser – Ein Fall für Kommissar Berg', { types: ['show'], limit: 20 });
      expect(seerrService.getMeta).toHaveBeenCalledWith('tv', 4711);
      expect(movies.setMovieImdbId).toHaveBeenCalledWith(7, 'tt0000042');
    });

    it('takes no guess when the title is only similar ("Grell" is not "Grell Island")', async () => {
      vi.mocked(seerrService.searchCatalog).mockResolvedValue([hit('Grell Island', 1, 2000)]);
      await resolveMovieImdbId(row({ title: 'Grell', year: 2020, tmdb_id: null }));
      expect(seerrService.getMeta).not.toHaveBeenCalled();
      expect(movies.setMovieImdbId).not.toHaveBeenCalled();
    });

    it('takes no guess when two results share the title, or the year is off', async () => {
      vi.mocked(seerrService.searchCatalog).mockResolvedValue([hit('Stille Wasser – Ein Fall für Kommissar Berg', 1), hit('Stille Wasser – Ein Fall für Kommissar Berg', 2)]);
      await resolveMovieImdbId(localizedShow());
      vi.mocked(seerrService.searchCatalog).mockResolvedValue([hit('Stille Wasser – Ein Fall für Kommissar Berg', 1, 2010)]);
      await resolveMovieImdbId(localizedShow());
      expect(seerrService.getMeta).not.toHaveBeenCalled();
    });
  });

  it('goes to OMDb for a title-only row when Seerr has no unambiguous hit', async () => {
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

describe('resolveMovieYear', () => {
  const show = (o: any = {}) => ({ id: 9, title: 'Sandmere', year: 0, imdb_id: 'tt0000009', tmdb_id: 9009, media_type: 'show', ...o }) as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(seerrService.getMeta).mockResolvedValue(null);
    vi.mocked(tmdbService.isConfigured).mockReturnValue(false);
    vi.mocked(movies.getMovieById).mockImplementation(((id: number) => show({ id, year: 2025 })) as any);
  });

  it('takes the year from Seerr', async () => {
    vi.mocked(seerrService.getMeta).mockResolvedValue({ title: 'Sandmere', year: 2025, releaseDate: '2025-03-01', imdbId: null, seasons: [] } as any);
    const r = await resolveMovieYear(show());
    expect(seerrService.getMeta).toHaveBeenCalledWith('tv', 9009);
    expect(movies.setMovieYear).toHaveBeenCalledWith(9, 2025);
    expect(r.year).toBe(2025);
  });

  it('falls back to TMDb without Seerr', async () => {
    vi.mocked(tmdbService.isConfigured).mockReturnValue(true);
    vi.mocked(tmdbService.getShowAiring).mockResolvedValue({ status: 'Ended', firstAir: '2025-03-01', nextAir: null });
    await resolveMovieYear(show());
    expect(movies.setMovieYear).toHaveBeenCalledWith(9, 2025);
  });

  it('leaves rows with a year, without a tmdb id, or without an answer alone', async () => {
    await resolveMovieYear(show({ year: 2020 }));
    await resolveMovieYear(show({ tmdb_id: null }));
    await resolveMovieYear(show());
    expect(movies.setMovieYear).not.toHaveBeenCalled();
  });

  it('never throws on a failed lookup', async () => {
    vi.mocked(seerrService.getMeta).mockRejectedValue(new Error('down'));
    const m = show();
    expect(await resolveMovieYear(m)).toBe(m);
  });
});

describe('verifyMovieImdbId — a stored id checked against the tmdb id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(movies.setMovieImdbId).mockReturnValue(true);
    vi.mocked(movies.getMovieByImdbId).mockReturnValue(undefined);
    vi.mocked(seerrService.getMeta).mockResolvedValue(null);
    vi.mocked(tmdbService.getImdbId).mockResolvedValue(null);
  });

  it('corrects an id that belongs to another title and drops its metadata', async () => {
    vi.mocked(seerrService.getMeta).mockResolvedValue(meta('tt9000004', 2025));
    const out = await verifyMovieImdbId(row({ title: 'Grell', imdb_id: 'tt9000003', tmdb_id: 4243 }));
    expect(out).toEqual({ from: 'tt9000003', to: 'tt9000004' });
    expect(movies.setMovieImdbId).toHaveBeenCalledWith(7, 'tt9000004');
    expect(movies.clearMovieMetadata).toHaveBeenCalledWith(7);
  });

  it('confirms an id that agrees, and does nothing when nobody knows or there is no tmdb id', async () => {
    vi.mocked(seerrService.getMeta).mockResolvedValue(meta('TT1', 2025));
    expect(await verifyMovieImdbId(row({ imdb_id: 'tt1' }))).toBe('confirmed');
    vi.mocked(seerrService.getMeta).mockResolvedValue(null);
    expect(await verifyMovieImdbId(row({ imdb_id: 'tt1' }))).toBeNull();
    expect(await verifyMovieImdbId(row({ imdb_id: 'tt1', tmdb_id: null }))).toBeNull();
    expect(movies.setMovieImdbId).not.toHaveBeenCalled();
  });

  it('leaves the row alone when the right id already belongs to another row', async () => {
    vi.mocked(seerrService.getMeta).mockResolvedValue(meta('tt2', 2025));
    vi.mocked(movies.setMovieImdbId).mockReturnValue(false);
    expect(await verifyMovieImdbId(row({ imdb_id: 'tt1' }))).toBeNull();
    expect(movies.clearMovieMetadata).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('survives a failing lookup', async () => {
    vi.mocked(seerrService.getMeta).mockRejectedValue(new Error('down'));
    expect(await verifyMovieImdbId(row({ imdb_id: 'tt1' }))).toBeNull();
  });
});
