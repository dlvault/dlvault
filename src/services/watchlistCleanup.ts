import { getSetting } from '../database/index';
import { getMovieById } from '../database/services/movies';
import { eventBus } from './eventbus';
import { plexService } from './plex';
import { traktService } from './trakt';
import { logger } from '../utils/logger';

/**
 * Opt-in (`watchlist.remove_after_download`, default off): once a title is
 * downloaded it is taken off the watchlist it came from (Plex or Trakt), so the
 * list only shows what is still wanted. Titles added by hand, via Seerr, or
 * before the source was recorded are left alone. Best-effort — a failure is
 * logged and never affects the download.
 */
export async function cleanupWatchlist(id: number): Promise<boolean> {
  if (getSetting('watchlist.remove_after_download') !== 'true') return false;
  const m = getMovieById(id);
  if (!m || (m.watchlist_source !== 'plex' && m.watchlist_source !== 'trakt')) return false;
  const mediaType = m.media_type === 'show' ? 'show' : 'movie';
  try {
    if (m.watchlist_source === 'plex') {
      return await plexService.removeFromWatchlist({
        imdbId: m.imdb_id || undefined, tmdbId: m.tmdb_id || undefined, title: m.title, year: m.year || undefined, mediaType,
      });
    }
    return await traktService.removeFromWatchlist({
      imdb_id: m.imdb_id || undefined, tmdb_id: m.tmdb_id || undefined, title: m.title, mediaType,
    });
  } catch (err: any) {
    logger.warn(`Watchlist cleanup for ${m.title} failed: ${err?.message || err}`);
    return false;
  }
}

export function startWatchlistCleanup(): void {
  eventBus.on('movie:downloaded', (d: { id: number }) => { void cleanupWatchlist(d.id); });
}
