import { addMovie, getMovieByTraktId, getMovieByImdbId, getMovieByTmdbId, type Movie, type MediaType } from '../database/services/movies';
import { getSetting } from '../database/index';
import { logger } from '../utils/logger';

export interface RequestInput {
  trakt_id?: number | null;
  imdb_id?: string | null;
  tmdb_id?: number | null;
  title: string;
  year?: number | null;
  slug?: string | null;
  media_type: MediaType;
  /** Initial status. Defaults to 'pending' — the normal "let the pipeline find it" request. */
  status?: Movie['status'];
  /** Quality floor for this title. Defaults to the global quality.minimum (or 1080p). */
  desired_quality?: string;
}

export interface RequestResult {
  movie: Movie;
  /** false when an existing row (matched by trakt/imdb/tmdb id) was returned untouched. */
  created: boolean;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Canonical "add a requested title to the queue" primitive shared by the
 * watchlist sync, the Telegram bot, and (soon) the discovery/request UI.
 *
 * Idempotent: if a row already exists for any supplied id it is returned
 * untouched (created=false). Callers that need their own existence handling —
 * the Telegram title+year match, or the Trakt trakt_id backfill — run it BEFORE
 * calling here and only reach this for the genuine create case.
 *
 * For shows, when a trakt_id is supplied, seasons/episodes are synced from Trakt
 * metadata immediately (the full aired list). This is the ONE place that happens,
 * so every id-bearing caller behaves identically. Callers without a trakt_id
 * (Telegram free-text) keep relying on the scheduler's source-driven season
 * discovery — unchanged.
 *
 * Logging stays with the caller (the log line names the source). Event emission
 * is opt-in (opts.emitEvent, default off) so existing callers — which emit their
 * own event or none — keep their exact behavior; the request UI opts in.
 */
export async function requestTitle(
  input: RequestInput,
  opts: { emitEvent?: boolean; syncSeasons?: boolean } = {},
): Promise<RequestResult> {
  const existing =
    (input.trakt_id ? getMovieByTraktId(input.trakt_id) : undefined) ||
    (input.imdb_id ? getMovieByImdbId(input.imdb_id) : undefined) ||
    (input.tmdb_id ? getMovieByTmdbId(input.tmdb_id) : undefined);
  if (existing) return { movie: existing, created: false };

  const desiredQuality = input.desired_quality || getSetting('quality.minimum') || '1080p';
  const movie = addMovie({
    trakt_id: (input.trakt_id ?? null) as any,
    imdb_id: input.imdb_id ?? null,
    tmdb_id: input.tmdb_id ?? null,
    title: input.title,
    year: input.year ?? null,
    slug: input.slug || slugify(input.title),
    media_type: input.media_type,
    status: input.status ?? 'pending',
    desired_quality: desiredQuality,
  });

  // Show + trakt_id → pull the full aired season/episode list now. Lazy import
  // breaks the trakt ⇄ requests cycle (trakt statically imports requestTitle).
  if ((opts.syncSeasons ?? true) && movie.media_type === 'show' && input.trakt_id) {
    try {
      const { traktService } = await import('./trakt');
      await traktService.syncShowSeasons(movie.id, input.trakt_id);
    } catch (err: any) {
      logger.debug(`requestTitle: season sync failed for ${movie.title}: ${err?.message || err}`);
    }
  }

  if (opts.emitEvent ?? false) {
    try {
      const { eventBus } = await import('./eventbus');
      eventBus.emit('movie:updated', { id: movie.id, title: movie.title, status: movie.status });
    } catch { /* event bus optional */ }
  }

  return { movie, created: true };
}
