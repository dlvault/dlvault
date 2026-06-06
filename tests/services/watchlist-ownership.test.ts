import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockSettings: Record<string, string> = {};

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
  setSetting: vi.fn(),
  initDatabase: vi.fn(),
}));
vi.mock('../../src/database/services/movies', () => ({
  addMovie: vi.fn((m: any) => ({ id: 99, ...m })),
  getMovieByTraktId: vi.fn(() => null),
  getMovieByImdbId: vi.fn(() => null),
  getMovieByTmdbId: vi.fn(() => null),
  updateMovieTraktId: vi.fn(),
  getAllMovies: vi.fn(() => []),
  deleteMovie: vi.fn(),
  getMovieById: vi.fn(() => null),
}));
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: vi.fn() }));
vi.mock('../../src/database/services/seasons', () => ({
  getSeasonsByShowId: vi.fn(() => []), addSeason: vi.fn(), updateSeasonEpisodeCount: vi.fn(),
}));
vi.mock('../../src/database/services/episodes', () => ({ addEpisodes: vi.fn() }));
vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({ isConfigured: () => false, hasMovie: async () => false })),
  getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));
vi.mock('../../src/services/requests', () => ({ requestTitle: vi.fn(async () => ({ movie: { id: 1 }, created: true })) }));
vi.mock('../../src/services/scheduler', () => ({ processingMovies: new Set() }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

mockedAxios.create.mockReturnValue(mockedAxios as any);

import { TraktService } from '../../src/services/trakt';
import { deleteMovie, getAllMovies } from '../../src/database/services/movies';

/**
 * Regression cover for the two watchlists fighting over the same rows.
 *
 * In `both` mode the Trakt sync runs first and used to delete every entry whose
 * trakt_id wasn't on the Trakt watchlist. Plex entries carried a fake trakt_id
 * (their TMDb id), so they were deleted, re-added by the Plex sync as "new", and
 * re-searched against the sources every single 2-minute cycle.
 */
/**
 * A watchlist containing one unrelated title, so the deletion sweep is armed
 * (a non-empty fetch) but matches none of the fixture rows. Both endpoints must
 * answer — a null from either marks the fetch failed and skips deletion entirely.
 */
function mockWatchlist(): void {
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.includes('/watchlist/movies')) {
      return {
        data: [{ movie: { title: 'Other', year: 2020, ids: { trakt: 1, imdb: 'tt1', tmdb: 2, slug: 'other' } } }],
        headers: {},
      } as any;
    }
    if (url.includes('/watchlist/shows')) return { data: [], headers: {} } as any;
    return { data: { username: 'tester' }, headers: {} } as any;
  });
}

describe('Trakt deletion sweep respects watchlist ownership', () => {
  let service: TraktService;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    mockedAxios.create.mockReturnValue(mockedAxios as any);
    mockSettings['trakt.access_token'] = 'tok';
    mockSettings['trakt.client_id'] = 'id';
    mockSettings['trakt.username'] = 'tester';
    service = new TraktService();
  });

  it('never deletes a Plex-owned entry', async () => {
    mockSettings['watchlist.provider'] = 'both';
    vi.mocked(getAllMovies).mockReturnValue([
      // Plex-owned. A pre-fix row would have carried trakt_id = tmdb_id here.
      { id: 1, trakt_id: 4242, tmdb_id: 4242, title: 'Plex Film', year: 2024, status: 'pending', watchlist_source: 'plex' },
      // Trakt-owned and gone from the watchlist — this one SHOULD go.
      { id: 2, trakt_id: 777, tmdb_id: 555, title: 'Trakt Film', year: 2023, status: 'pending', watchlist_source: 'trakt' },
    ] as any);

    // Non-empty watchlist that contains neither id, so the sweep is armed.
    mockWatchlist();

    await service.syncWatchlist();

    expect(deleteMovie).not.toHaveBeenCalledWith(1);
    expect(deleteMovie).toHaveBeenCalledWith(2);
  });

  it('still deletes legacy rows that have no recorded source', async () => {
    mockSettings['watchlist.provider'] = 'trakt';
    vi.mocked(getAllMovies).mockReturnValue([
      { id: 3, trakt_id: 888, tmdb_id: 1, title: 'Legacy', year: 2019, status: 'pending', watchlist_source: null },
    ] as any);
    mockWatchlist();

    await service.syncWatchlist();

    expect(deleteMovie).toHaveBeenCalledWith(3);
  });

  it('leaves manually added entries alone', async () => {
    mockSettings['watchlist.provider'] = 'trakt';
    vi.mocked(getAllMovies).mockReturnValue([
      { id: 4, trakt_id: null, tmdb_id: 9, title: 'Manual', year: 2022, status: 'pending', watchlist_source: 'manual' },
    ] as any);
    mockWatchlist();

    await service.syncWatchlist();

    expect(deleteMovie).not.toHaveBeenCalled();
  });
});
