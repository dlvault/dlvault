import { getSetting } from '../database/index';
import { setReleaseHold, type Movie } from '../database/services/movies';
import { getSeasonsByShowId } from '../database/services/seasons';
import { tmdbService, type MovieRelease, type ShowAiring } from './tmdb';
import { seerrService } from './seerr';
import { logger } from '../utils/logger';
import { parseUtcDate } from '../utils/datetime';

/**
 * Holds back SCHEDULED source searches for titles that cannot have a release
 * yet — a film before it reaches the region, a show that has not started, a
 * finished show that will not get new episodes. Without it the full sync and
 * the retry monitor searched every waiting title daily, films two years out
 * included: ~70 source queries a day on a mid-sized list.
 *
 * Only metadata from TMDb (neutral-host rule: nothing here knows a source) —
 * directly with a TMDb key, otherwise through Seerr's TMDb proxy.
 * Never in the way of a person: watchlist pick-ups, requests, Telegram and the
 * UI call processMovie directly. A title that was never searched is never
 * held, and a failed lookup never holds anything.
 */

const DAY = 24 * 60 * 60 * 1000;
const INFO_TTL_MS = 7 * DAY;
const FAILED_LOOKUP_TTL_MS = 6 * 60 * 60 * 1000;
const UNANNOUNCED = ['Rumored', 'Planned', 'In Production', 'Post Production'];
const FINISHED = ['Ended', 'Canceled'];

export type ReleaseInfo =
  | ({ kind: 'movie' } & MovieRelease)
  | ({ kind: 'show' } & ShowAiring);

/**
 * `kind` separates real dates worth telling a requester about ('release',
 * 'premiere') from plain re-check cadence ('cadence'). `label` is the German
 * text shown in the queue.
 */
export interface Hold { until: number; reason: string; kind: 'release' | 'premiere' | 'cadence'; label: string }

const de = (iso: string | number) => {
  const d = typeof iso === 'number' ? new Date(iso) : new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
};

function dayStart(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Pure rule: until when (and why) a scheduled search for this title should
 * wait, or null to search now.
 *
 * Films: until the regional digital/disc date (German releases appear around
 * it); without one, until the theatrical date plus `graceDays`; without any
 * date but still unannounced, weekly. Shows: until the premiere; a finished
 * show monthly; a running one at most weekly, earlier once the next episode
 * has aired.
 */
export function releaseHold(
  movie: Movie, info: ReleaseInfo | null, now: number, graceDays: number,
  opts: { nothingMonitored?: boolean } = {},
): Hold | null {
  if (!info || !movie.last_checked_at) return null;
  // Under repair (integrity check found a truncated episode, a stereo copy is
  // being replaced): there IS something to fetch now. The show still reads
  // 'downloaded', and the weekly cadence pushed the re-download a week out.
  if (movie.repair === 1) return null;
  const lastChecked = parseUtcDate(movie.last_checked_at);

  if (info.kind === 'movie') {
    if (movie.status !== 'pending' && movie.status !== 'not_found') return null;
    const digital = dayStart(info.digital);
    if (digital !== null) {
      return now < digital ? { until: digital, reason: `digital/disc release ${info.digital!.slice(0, 10)}`, kind: 'release', label: `Erscheint digital/auf Disc am ${de(info.digital!)}` } : null;
    }
    const theatrical = dayStart(info.theatrical);
    if (theatrical !== null) {
      const until = theatrical + graceDays * DAY;
      return now < until ? { until, reason: `theatrical release ${info.theatrical!.slice(0, 10)} + ${graceDays} days`, kind: 'release', label: `Kinostart ${de(info.theatrical!)} — Suche ab ${de(until)}` } : null;
    }
    if (info.status && UNANNOUNCED.includes(info.status)) {
      const until = lastChecked + 7 * DAY;
      return now < until ? { until, reason: `no release date yet (${info.status})`, kind: 'cadence', label: 'Noch kein Erscheinungstermin — wöchentliche Prüfung' } : null;
    }
    return null;
  }

  const first = dayStart(info.firstAir);
  if (first !== null && now < first + DAY) {
    return { until: first + DAY, reason: `premiere ${info.firstAir!.slice(0, 10)}`, kind: 'premiere', label: `Startet am ${de(info.firstAir!)}` };
  }
  // Still missing seasons: normal cadence. Except when the wanted seasons do
  // not exist yet ("from season 2 on", TMDb knows only S01) — then there is
  // nothing to fetch, exactly like a complete show, and every pass searched
  // the source for nothing.
  if (movie.status !== 'downloaded' && !opts.nothingMonitored) return null;
  if (info.status && FINISHED.includes(info.status)) {
    const until = lastChecked + 30 * DAY;
    return now < until ? { until, reason: `show ${info.status.toLowerCase()}, monthly check`, kind: 'cadence', label: 'Serie abgeschlossen — monatliche Prüfung' } : null;
  }
  const next = dayStart(info.nextAir);
  if (next !== null) {
    const until = Math.min(next + DAY, lastChecked + 7 * DAY);
    return now < until ? { until, reason: `next episode ${info.nextAir!.slice(0, 10)}`, kind: 'cadence', label: `Nächste Folge am ${de(info.nextAir!)}` } : null;
  }
  // Running, fully downloaded, no next episode announced: nothing new can air
  // before a date shows up, so weekly is enough (the info cache refreshes weekly too).
  const until = lastChecked + 7 * DAY;
  return now < until ? { until, reason: 'no next episode announced, weekly check', kind: 'cadence', label: 'Keine neue Folge angekündigt — wöchentliche Prüfung' } : null;
}

const infoCache = new Map<number, { info: ReleaseInfo | null; at: number; ttl: number }>();
const lastLogged = new Map<number, number>();

/** Last release info looked up for a title (undefined: not looked up since start). */
export function cachedReleaseInfo(movieId: number): ReleaseInfo | null | undefined {
  return infoCache.get(movieId)?.info;
}

export function _resetReleaseHold(): void {
  infoCache.clear();
  lastLogged.clear();
}

interface ReleaseSource {
  findTmdbId(type: 'movie' | 'tv', imdbId: string): Promise<number | null>;
  getMovieRelease(tmdbId: number, region: string): Promise<MovieRelease>;
  getShowAiring(tmdbId: number): Promise<ShowAiring>;
}

/** A TMDb key wins; Seerr serves the same TMDb data for installs without one. */
function releaseSource(): ReleaseSource | null {
  if (tmdbService.isConfigured()) return tmdbService;
  if (seerrService.isConfigured()) return seerrService;
  return null;
}

async function releaseInfo(movie: Movie, source: ReleaseSource): Promise<ReleaseInfo | null> {
  const cached = infoCache.get(movie.id);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.info;
  const type = movie.media_type === 'show' ? 'tv' : 'movie';
  let info: ReleaseInfo | null = null;
  let ttl = INFO_TTL_MS;
  try {
    const id = movie.tmdb_id || (movie.imdb_id ? await source.findTmdbId(type, movie.imdb_id) : null);
    if (id) {
      info = type === 'movie'
        ? { kind: 'movie', ...(await source.getMovieRelease(id, tmdbService.region())) }
        : { kind: 'show', ...(await source.getShowAiring(id)) };
    }
  } catch (err: any) {
    logger.debug(`Release hold: release-date lookup for ${movie.title} failed: ${err?.message || err}`);
    ttl = FAILED_LOOKUP_TTL_MS;
  }
  infoCache.set(movie.id, { info, at: Date.now(), ttl });
  return info;
}

/**
 * Keep the row in step with the verdict, so the queue can show "erscheint am …".
 * A date a requester should hear about is passed on once per date.
 */
function record(movie: Movie, hold: Hold | null): void {
  const until = hold ? fmt(hold.until) : null;
  const label = hold ? hold.label : null;
  if ((movie.release_hold_until ?? null) === until && (movie.release_hold_reason ?? null) === label) return;
  setReleaseHold(movie.id, until, label);
  if (hold && hold.kind !== 'cadence') {
    import('./telegram')
      .then(({ notifyReleaseHold }) => notifyReleaseHold(movie, fmt(hold.until), hold.label))
      .catch(() => { /* best effort */ });
  }
}

/**
 * A show with a season cutoff whose known seasons all lie below it. Only when
 * the season list is seeded from TMDb (counts present) — without that the
 * source search is the only way a new season is discovered.
 */
function nothingMonitored(movie: Movie): boolean {
  if (!movie.season_cutoff) return false;
  const seasons = getSeasonsByShowId(movie.id);
  if (seasons.length === 0 || seasons.some(s => s.episode_count == null)) return false;
  return seasons.every(s => s.season_number < movie.season_cutoff!);
}

/**
 * Fill the release-date cache for waiting titles after a restart. The cache
 * lives in memory and was otherwise empty until the next daily sync — so after
 * every update the problem list called films still in cinemas "long not found".
 * One lookup at a time; a title already cached is free.
 */
export async function warmReleaseInfo(movies: Movie[]): Promise<number> {
  if (getSetting('scheduler.release_hold') === 'false') return 0;
  const source = releaseSource();
  if (!source) return 0;
  let n = 0;
  for (const m of movies) {
    if (m.status !== 'not_found' && !(m.media_type === 'show' && m.status === 'downloaded')) continue;
    if (infoCache.has(m.id)) continue;
    await releaseInfo(m, source);
    n++;
  }
  return n;
}

/** True = skip this scheduled search. Errors never hold. */
export async function heldForRelease(movie: Movie): Promise<boolean> {
  try {
    const source = getSetting('scheduler.release_hold') === 'false' ? null : releaseSource();
    if (!source || !movie.last_checked_at || movie.repair === 1) {
      record(movie, null);
      return false;
    }
    const graceRaw = parseInt(getSetting('scheduler.release_grace_days') || '', 10);
    const graceDays = Number.isFinite(graceRaw) && graceRaw >= 0 ? graceRaw : 30;
    const now = Date.now();
    const hold = releaseHold(movie, await releaseInfo(movie, source), now, graceDays, {
      nothingMonitored: movie.media_type === 'show' && nothingMonitored(movie),
    });
    record(movie, hold);
    if (!hold) return false;
    if (now - (lastLogged.get(movie.id) || 0) > DAY) {
      lastLogged.set(movie.id, now);
      logger.info(`Release hold: ${movie.title} — next search ${fmt(hold.until)} (${hold.reason})`);
    }
    return true;
  } catch (err: any) {
    logger.debug(`Release hold: check for ${movie.title} skipped: ${err?.message || err}`);
    return false;
  }
}
