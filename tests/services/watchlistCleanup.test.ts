import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSettings, movieRef, plexRemove, traktRemove } = vi.hoisted(() => ({
  mockSettings: {} as Record<string, string>, movieRef: { m: null as any },
  plexRemove: vi.fn(async (..._a: any[]) => true), traktRemove: vi.fn(async (..._a: any[]) => true),
}));
vi.mock('../../src/database/index', () => ({ getSetting: (k: string) => mockSettings[k] ?? '' }));
vi.mock('../../src/database/services/movies', () => ({ getMovieById: () => movieRef.m }));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/services/plex', () => ({ plexService: { removeFromWatchlist: plexRemove } }));
vi.mock('../../src/services/trakt', () => ({ traktService: { removeFromWatchlist: traktRemove } }));

import { cleanupWatchlist } from '../../src/services/watchlistCleanup';

const film = (over: Record<string, any> = {}) => ({ id: 1, title: 'Film', year: 2020, media_type: 'movie', imdb_id: 'tt1', tmdb_id: 7, watchlist_source: 'plex', ...over });

beforeEach(() => {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  plexRemove.mockClear(); traktRemove.mockClear();
  movieRef.m = film();
});

describe('cleanupWatchlist', () => {
  it('does nothing by default', async () => {
    expect(await cleanupWatchlist(1)).toBe(false);
    expect(plexRemove).not.toHaveBeenCalled();
  });
  it('removes from Plex when enabled and the title came from Plex', async () => {
    mockSettings['watchlist.remove_after_download'] = 'true';
    expect(await cleanupWatchlist(1)).toBe(true);
    expect(plexRemove).toHaveBeenCalledOnce();
    expect(traktRemove).not.toHaveBeenCalled();
  });
  it('removes from Trakt for a Trakt title', async () => {
    mockSettings['watchlist.remove_after_download'] = 'true';
    movieRef.m = film({ watchlist_source: 'trakt', media_type: 'show' });
    await cleanupWatchlist(1);
    expect(traktRemove).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'show', imdb_id: 'tt1' }));
  });
  it('leaves manual and Seerr titles alone', async () => {
    mockSettings['watchlist.remove_after_download'] = 'true';
    for (const s of ['manual', 'seerr', null]) {
      movieRef.m = film({ watchlist_source: s });
      expect(await cleanupWatchlist(1)).toBe(false);
    }
    expect(plexRemove).not.toHaveBeenCalled();
    expect(traktRemove).not.toHaveBeenCalled();
  });
});
