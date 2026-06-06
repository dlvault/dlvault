import { getSetting } from '../database/index';
import type { Movie } from '../database/services/movies';
import { getSeasonsByShowId } from '../database/services/seasons';
import { addLogEntry } from '../database/services/activityLog';
import {
  getReleaseChoice, setReleaseChoice,
  type ReleaseChoice,
} from '../database/services/releaseChoices';
import type { ScrapedRelease } from '../scraper/constants';
import { logger } from '../utils/logger';

/**
 * Which release to take when quality and hoster pull in different directions.
 *
 * The best-first sort only looks at the release: a 2160p that is only on a
 * hoster without a premium account beats a full 1080p on the one the user pays
 * for. Two opt-in answers:
 *
 * - `quality.prefer_hoster`: the user's first-choice hoster (first entry of the
 *   source plugin's `hosters` setting) wins over a better quality. Only among
 *   releases that already passed the quality filter.
 * - `telegram.release_choice`: in exactly that case, ask the operator in the
 *   admin chat instead. No answer within an hour → the rule above (or plain
 *   quality order when it is off). "Später" asks again after 24 h.
 *
 * Neutral host: the hoster names are opaque strings from the plugin's own
 * links and setting — nothing here knows a hoster.
 */

export const CHOICE_TIMEOUT_MS = 60 * 60 * 1000;
export const CHOICE_LATER_MS = 24 * 60 * 60 * 1000;

type Release = Pick<ScrapedRelease, 'title' | 'quality' | 'size' | 'links' | 'season' | 'episode' | 'isSeasonPack'>;

/** First entry of the plugin's ordered `hosters` setting, or '' if there is none. */
export function preferredHoster(pluginId: string): string {
  const raw = getSetting(`plugins.${pluginId}.hosters`) || '';
  return (raw.split(',')[0] || '').trim().toLowerCase();
}

function hostersOf(r: Release): string[] {
  return [...new Set((r.links || []).map(l => (l.hoster || '').trim().toLowerCase()).filter(Boolean))];
}

/** Releases compete within a group: the film, one season's packs, one episode. */
function groupKey(r: Release): string {
  if (r.season === null || r.season === undefined) return 'film';
  return r.isSeasonPack ? `s${r.season}` : `s${r.season}e${r.episode ?? ''}`;
}

/**
 * Move, per group, the best release that has the preferred hoster to the front
 * of that group — when the group's best release lacks it. A best release whose
 * links are not known yet (empty) stays where it is.
 */
export function promoteByHoster(releases: Release[], preferred: string): Release[] {
  if (!preferred || releases.length < 2) return releases;
  const out = [...releases];
  const seen = new Set<string>();
  for (let i = 0; i < out.length; i++) {
    const key = groupKey(out[i]);
    if (seen.has(key)) continue;
    seen.add(key);
    const top = out[i];
    const hosters = hostersOf(top);
    if (hosters.length === 0 || hosters.includes(preferred)) continue;
    const j = out.findIndex((r, k) => k > i && groupKey(r) === key && hostersOf(r).includes(preferred));
    if (j === -1) continue;
    const [cand] = out.splice(j, 1);
    out.splice(i, 0, cand);
  }
  return out;
}

interface Doubt {
  key: string;
  label: string;
  /** [release with the preferred hoster, best release without it] */
  options: [Release, Release];
}

/**
 * The first group whose best release lacks the preferred hoster while another
 * passing release of that group has it. Shows: season packs of seasons that
 * still need downloading only — a season already in JD or on disk asks nothing.
 */
export function findDoubt(releases: Release[], preferred: string, movie: Movie, isShow: boolean): Doubt | null {
  if (!preferred) return null;
  let wanted: (season: number) => boolean = () => true;
  if (isShow) {
    const status = new Map(getSeasonsByShowId(movie.id).map(s => [s.season_number, s.status]));
    const cutoff = movie.season_cutoff;
    wanted = n => (cutoff == null || n >= cutoff) && (!status.has(n) || ['pending', 'not_found'].includes(status.get(n)!));
  }
  const groups = new Map<string, Release[]>();
  for (const r of releases) {
    if (isShow && !(r.isSeasonPack && r.season != null && wanted(r.season))) continue;
    if (!isShow && r.season != null) continue;
    const key = groupKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  for (const [key, list] of groups) {
    const top = list[0];
    const hosters = hostersOf(top);
    if (hosters.length === 0 || hosters.includes(preferred)) continue;
    const cand = list.find(r => hostersOf(r).includes(preferred));
    if (!cand) continue;
    return { key, label: key === 'film' ? 'Film' : `Staffel ${top.season}`, options: [cand, top] };
  }
  return null;
}

/** True while an asked question still blocks this title (pending < 1 h, "Später" < 24 h). */
export function isWaitingForChoice(movieId: number, now = Date.now()): boolean {
  if (getSetting('telegram.release_choice') !== 'true') return false;
  const d = getReleaseChoice(movieId);
  if (!d) return false;
  return (d.status === 'pending' && now - d.at < CHOICE_TIMEOUT_MS)
    || (d.status === 'later' && now - d.at < CHOICE_LATER_MS);
}

export type ChoiceVerdict<R> = { wait: true } | { wait: false; releases: R[] };

/**
 * Order the releases for this pass, or tell the caller to wait for the
 * operator. `ask` sends the question and returns whether it went out — when it
 * did not (Telegram off, no admin chat), the rule applies right away.
 */
export async function decideRelease<R extends Release>(
  movie: Movie,
  releases: R[],
  pluginId: string,
  isShow: boolean,
  ask: (movie: Movie, choice: ReleaseChoice) => Promise<boolean>,
  now = Date.now(),
): Promise<ChoiceVerdict<R>> {
  const preferred = preferredHoster(pluginId);
  const rule = (): R[] => (getSetting('quality.prefer_hoster') === 'true'
    ? promoteByHoster(releases, preferred) as R[]
    : releases);

  if (getSetting('telegram.release_choice') !== 'true') return { wait: false, releases: rule() };
  const doubt = findDoubt(releases, preferred, movie, isShow);
  if (!doubt) return { wait: false, releases: rule() };

  const d = getReleaseChoice(movie.id);
  if (d && d.key === doubt.key) {
    if (d.status === 'chosen') {
      const list = rule();
      const idx = list.findIndex(r => r.title === d.chosenTitle && groupKey(r) === doubt.key);
      if (idx > -1) {
        const first = list.findIndex(r => groupKey(r) === doubt.key);
        const [pick] = list.splice(idx, 1);
        list.splice(first, 0, pick);
      }
      return { wait: false, releases: list };
    }
    if (d.status === 'auto') return { wait: false, releases: rule() };
    if (d.status === 'pending') {
      if (now - d.at < CHOICE_TIMEOUT_MS) return { wait: true };
      setReleaseChoice(movie.id, { ...d, status: 'auto', at: now });
      addLogEntry(movie.id, 'choice_auto', `Keine Antwort innerhalb 1 Std — Standardregel (${doubt.label})`);
      logger.info(`${movie.title}: no answer to the release question — default rule`);
      return { wait: false, releases: rule() };
    }
    if (d.status === 'later' && now - d.at < CHOICE_LATER_MS) return { wait: true };
  }

  const choice: ReleaseChoice = {
    key: doubt.key,
    label: doubt.label,
    status: 'pending',
    at: now,
    options: doubt.options.map(r => ({ title: r.title, quality: r.quality, hosters: hostersOf(r), size: r.size || '' })),
  };
  setReleaseChoice(movie.id, choice);
  let sent = false;
  try {
    sent = await ask(movie, choice);
  } catch (err: any) {
    logger.warn(`${movie.title}: release question not sent: ${err?.message || err}`);
  }
  if (!sent) {
    setReleaseChoice(movie.id, { ...choice, status: 'auto' });
    return { wait: false, releases: rule() };
  }
  addLogEntry(movie.id, 'choice_asked',
    `Telegram (${doubt.label}): ${choice.options.map(o => `${o.quality}/${o.hosters.join('+')}`).join(' | ')}`);
  logger.info(`${movie.title}: asked the operator which release to take (${doubt.label})`);
  return { wait: true };
}
