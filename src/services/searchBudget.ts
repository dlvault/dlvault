import fs from 'fs';
import db, { getSetting } from '../database/index';
import type { Movie } from '../database/services/movies';
import { parseUtcDate } from '../utils/datetime';
import { logger } from '../utils/logger';

/**
 * Search budget for SCHEDULED searches — three opt-in knobs so every operator
 * can find the pace that keeps their IP out of a source's rate limit:
 *
 * - `scheduler.max_searches_per_hour` (0 = unlimited): over all titles, at most
 *   this many scheduled searches may start within the last 60 minutes.
 * - `scheduler.min_days_between_searches` (0 = off): a title that was searched
 *   already waits at least this long before the NEXT scheduled search (plus a
 *   fixed per-title offset of up to 24 h, so waiting titles do not all come due
 *   in the same minute).
 * - `scheduler.loop_guard` (off): when something was already sent to JDownloader
 *   for a title and a matching file or folder still sits in the download folder,
 *   it is not searched again — otherwise a package JD fetches but the
 *   post-processor cannot place (e.g. a loose "Show - S01 1080p.mkv") is
 *   downloaded again on every pass.
 *
 * All defaults reproduce the behaviour before this existed. Never in the way of
 * a person: requests, Telegram, the UI and watchlist pick-ups call processMovie
 * directly, and a title that was never searched is never held. A title added
 * within the last two days is exempt too — it was asked for.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const YOUNG_MS = 2 * DAY;
const LOG_EVERY_MS = DAY;

const lastLogged = new Map<number, number>();
let running = 0;

export interface BudgetSettings {
  maxPerHour: number;
  minDays: number;
  loopGuard: boolean;
}

function intSetting(key: string): number {
  const n = parseInt(getSetting(key) || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function budgetSettings(): BudgetSettings {
  return {
    maxPerHour: intSetting('scheduler.max_searches_per_hour'),
    minDays: intSetting('scheduler.min_days_between_searches'),
    loopGuard: getSetting('scheduler.loop_guard') === 'true',
  };
}

export function _resetSearchBudget(): void {
  lastLogged.clear();
  running = 0;
}

/** Title words (letters/digits, accents folded) for matching a download entry name. */
function titleWords(title: string): string[] {
  return String(title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

// What may follow the title in a download entry's name: year, season/episode
// marker, resolution, language or source tag. A further plain word means a
// different title ("Show" must not match "Show Weather").
const FOLLOW_RE = /^(\d{4}|s\d{1,2}(e\d{1,3})?|staffel|\d{3,4}p|german|dubbed|dl|web|webrip|bluray|hdtv|uhd|complete|remux)$/;

/**
 * The first entry of `names` that looks like this title's leftover, or null.
 * Pure — the directory read is done by the caller.
 */
export function leftoverFor(title: string, names: string[]): string | null {
  const words = titleWords(title);
  if (words.length === 0) return null;
  for (const name of names) {
    if (name === 'unfertige') continue;
    const tokens = name.toLowerCase().normalize('NFKD').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    if (tokens.length < words.length) continue;
    if (!words.every((w, i) => tokens[i] === w)) continue;
    const next = tokens[words.length];
    if (next === undefined || FOLLOW_RE.test(next)) return name;
  }
  return null;
}

function downloadLeftover(movie: Movie): string | null {
  try {
    const dir = getSetting('paths.downloads');
    if (!dir) return null;
    const row = db.prepare('SELECT COUNT(*) AS c FROM downloads WHERE movie_id = ?').get(movie.id) as { c: number } | undefined;
    if (!row || row.c === 0) return null;
    return leftoverFor(movie.title, fs.readdirSync(dir));
  } catch {
    return null;
  }
}

/** Scheduled searches that started within the last hour (from the activity log). */
export function searchesLastHour(): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM activity_log WHERE action = 'search_started' AND created_at >= datetime('now', '-1 hour')",
  ).get() as { c: number };
  return row.c;
}

export interface SearchHold { reason: string }

/** Pure rule + the two reads it needs; null = search now. */
export function budgetHold(movie: Movie, now: number, cfg: BudgetSettings, recent: number, leftover: string | null): SearchHold | null {
  if (!movie.last_checked_at && !(movie.retry_count > 0)) return null; // never searched
  if (movie.repair === 1) return null;
  if (cfg.loopGuard && leftover) return { reason: `"${leftover}" liegt noch im Download-Ordner (von Hand prüfen/verschieben)` };
  const added = movie.added_at ? parseUtcDate(movie.added_at) : NaN;
  if (Number.isFinite(added) && now - added < YOUNG_MS) return null;
  if (cfg.minDays > 0 && movie.last_checked_at && !(movie.media_type === 'show' && movie.status === 'downloading')) {
    const offset = ((movie.id * 7919) % 24) * HOUR;
    const until = parseUtcDate(movie.last_checked_at) + cfg.minDays * DAY + offset;
    if (now < until) return { reason: `Mindestabstand ${cfg.minDays} Tage bis ${new Date(until).toISOString().slice(0, 10)}` };
  }
  if (cfg.maxPerHour > 0 && recent + running >= cfg.maxPerHour) {
    return { reason: `Stundenlimit ${cfg.maxPerHour} erreicht` };
  }
  return null;
}

/**
 * Runs `search` unless the budget holds this title back. Returns true when it
 * was held (nothing ran). Errors in the check itself never hold.
 */
export async function budgetedRun(movie: Movie, search: () => Promise<void>): Promise<boolean> {
  let hold: SearchHold | null = null;
  try {
    const cfg = budgetSettings();
    if (cfg.maxPerHour === 0 && cfg.minDays === 0 && !cfg.loopGuard) {
      await search();
      return false;
    }
    hold = budgetHold(movie, Date.now(), cfg, cfg.maxPerHour > 0 ? searchesLastHour() : 0, cfg.loopGuard ? downloadLeftover(movie) : null);
  } catch (err: any) {
    logger.debug(`Search budget: check for ${movie.title} skipped: ${err?.message || err}`);
  }
  if (hold) {
    const now = Date.now();
    if (now - (lastLogged.get(movie.id) || 0) > LOG_EVERY_MS) {
      lastLogged.set(movie.id, now);
      logger.info(`Search budget: ${movie.title} — no scheduled search now (${hold.reason})`);
    }
    return true;
  }
  running++;
  try {
    await search();
  } finally {
    running--;
  }
  return false;
}
