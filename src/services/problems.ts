import db, { getSetting } from '../database/index';
import { getAllMovies, type Movie } from '../database/services/movies';
import { parseUtcDate } from '../utils/datetime';
import { getResolveStats } from './scheduler';
import { checkRoom } from './diskGuard';
import { getWatchdogFindings } from './watchdog';
import { cachedReleaseInfo, releaseInfoReady, type ReleaseInfo } from './releaseHold';

/**
 * Everything that needs a person's attention, in one list.
 *
 * Until now this lived in log lines and activity entries: a title that has not
 * been found for three months, a move that keeps failing, a file the media
 * server lost, a release rejected at import. Each finding here is derived from
 * current state or a recent activity entry, so it disappears on its own once
 * the cause is gone — there is nothing to dismiss and nothing to fall out of
 * sync.
 */

export type ProblemSeverity = 'error' | 'warning' | 'info';
export type ProblemAction = 'retry' | 'open' | 'settings' | 'redownload' | 'mark_removed' | 'remove';

export interface Problem {
  key: string;
  severity: ProblemSeverity;
  kind: string;
  movieId: number | null;
  title: string;
  detail: string;
  /** ISO-ish SQLite UTC timestamp (or null) — when it started / was most recently observed. */
  since: string | null;
  actions: ProblemAction[];
}

const DAY = 24 * 60 * 60 * 1000;
/** Sends of one release within a week from which a loop is assumed. */
const REPEAT_SENDS = 4;

const NOT_FOUND_LABEL: Record<string, string> = {
  not_available: 'kein Release bei der Quelle',
  no_download: 'Release gefunden, aber kein Download möglich',
  quality_mismatch: 'Releases vorhanden, keins erfüllt die Anforderungen',
};

/** Activity kinds worth surfacing, the window they stay relevant, and how. */
const ACTIVITY_RULES: {
  action: string; days: number; severity: ProblemSeverity; kind: string;
  /** Still relevant for this title in its current state? */
  stillRelevant: (m: Movie) => boolean;
  actions: ProblemAction[];
}[] = [
  { action: 'move_failed', days: 7, severity: 'error', kind: 'Umzug in die Mediathek scheitert',
    stillRelevant: m => m.status === 'downloading', actions: ['open'] },
  { action: 'disk_space_low', days: 1, severity: 'error', kind: 'Zu wenig Speicherplatz',
    stillRelevant: m => m.status !== 'downloaded', actions: ['settings'] },
  // Unexplained loss only — a film watched before it vanished is marked
  // removed by libraryRemovals.ts and never shows up here.
  { action: 'library_missing', days: 30, severity: 'warning', kind: 'Film fehlt in der Bibliothek',
    stillRelevant: m => m.status === 'downloaded' && !m.removed_at, actions: ['redownload', 'mark_removed'] },
  { action: 'audio_language_mismatch', days: 7, severity: 'warning', kind: 'Keine deutsche Tonspur',
    stillRelevant: m => m.status === 'downloaded', actions: ['retry', 'open'] },
  { action: 'repair_abandoned', days: 7, severity: 'warning', kind: 'Reparatur aufgegeben',
    stillRelevant: () => true, actions: ['retry', 'open'] },
  // Not for a repair: the old copy is still there and the search goes on.
  { action: 'import_rejected', days: 3, severity: 'info', kind: 'Download beim Import abgelehnt',
    stillRelevant: m => m.repair !== 1, actions: ['open'] },
  { action: 'integrity_missing', days: 3, severity: 'info', kind: 'Staffel unvollständig — wird nachgeladen',
    stillRelevant: m => m.status !== 'downloaded', actions: ['open'] },
  { action: 'integrity_incomplete', days: 3, severity: 'info', kind: 'Folge unvollständig — wird nachgeladen',
    stillRelevant: m => m.status !== 'downloaded', actions: ['open'] },
  { action: 'upgrade_failed', days: 3, severity: 'info', kind: 'Qualitäts-Upgrade gescheitert',
    stillRelevant: () => true, actions: ['open'] },
];

const SEVERITY_ORDER: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

/** How long a German release usually trails the cinema / first airing. */
const THEATRICAL_TO_DIGITAL_DAYS = 270;
const DIGITAL_GRACE_DAYS = 60;

/**
 * Pure rule: is "not found" simply the normal wait for a German release? A film
 * in cinemas this summer, a series that premiered three months ago — nothing
 * anyone can do, and a dozen of them buried the real problems. Unknown info
 * cannot vouch for anything and returns false.
 */
export function isExpectedWait(info: ReleaseInfo | null | undefined, now: number): boolean {
  if (!info) return false;
  const day = (iso: string | null | undefined) => (iso ? Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) : NaN);
  if (info.kind === 'movie') {
    const digital = day(info.digital);
    if (Number.isFinite(digital)) return now < digital + DIGITAL_GRACE_DAYS * DAY;
    const theatrical = day(info.theatrical);
    return Number.isFinite(theatrical) && now < theatrical + THEATRICAL_TO_DIGITAL_DAYS * DAY;
  }
  const first = day(info.firstAir);
  return Number.isFinite(first) && now < first + THEATRICAL_TO_DIGITAL_DAYS * DAY;
}

export function collectProblems(now = Date.now()): Problem[] {
  const out: Problem[] = [];
  const movies = getAllMovies();
  const byId = new Map(movies.map(m => [m.id, m]));

  // ── State-based ─────────────────────────────────────────────────────────
  for (const m of movies) {
    const label = m.year ? `${m.title} (${m.year})` : m.title;
    if (m.status === 'not_found') {
      const waitingForDate = m.release_hold_until && parseUtcDate(m.release_hold_until) > now;
      const age = m.added_at ? now - parseUtcDate(m.added_at) : 0;
      // Under repair with releases that do not meet the bar (a stereo copy
      // waiting for 5.1): the title is in the library; the queue shows it.
      const keptCopy = m.repair === 1 && m.not_found_reason === 'quality_mismatch';
      // A title dated next year has not come out — with or without release info.
      const thisYear = new Date(now).getUTCFullYear();
      const unreleased = !!m.year && m.year > thisYear;
      const info = cachedReleaseInfo(m.id);
      // Right after a start the dates are not looked up yet; a title waiting for
      // its release would show as long-missing until they are.
      const unknownYet = info === undefined && !releaseInfoReady();
      if (!waitingForDate && !keptCopy && !unreleased && !unknownYet && age > 30 * DAY && !isExpectedWait(info, now)) {
        // "No German version" is a guess only once the title is known to be out:
        // release info says so (else isExpectedWait), or it dates from an
        // earlier year. Without Seerr/TMDb a film from this year (or with no
        // year) may simply not be out yet.
        const surelyOut = !!info || (!!m.year && m.year < thisYear);
        // Information, not a warning: nothing to do but wait for a release, and
        // a dozen of these pushed the nav badge to 15 and buried the real ones.
        out.push({
          key: `nf:${m.id}`, severity: 'info', kind: 'Seit Langem nicht gefunden',
          movieId: m.id, title: label,
          detail: `Seit ${Math.floor(age / DAY)} Tagen in der Warteschlange — `
            + (NOT_FOUND_LABEL[m.not_found_reason || ''] || 'kein passendes Release')
            + (m.not_found_reason !== 'not_available' ? ''
              : surelyOut ? '. Vermutlich gibt es keine deutsche Fassung — behalten oder entfernen?'
              : '. Erscheinungstermin unbekannt — vielleicht noch nicht erschienen'),
          since: m.added_at, actions: ['retry', 'open', 'remove'],
        });
      }
    }
    if (m.media_type === 'show' && m.status === 'downloaded') {
      // The show rolls up to 'downloaded' when every other season is in the
      // library and the rest has "no release" — right for the queue, but an
      // AIRED season with no German release then vanished from view entirely.
      const gaps = db.prepare(
        `SELECT season_number FROM seasons WHERE movie_id = ? AND status = 'not_found'
           AND COALESCE(aired_episodes, 0) > 0 AND season_number >= COALESCE(?, 1) ORDER BY season_number`,
      ).all(m.id, m.season_cutoff ?? null) as { season_number: number }[];
      // A season still airing (the show has a next episode date and the gap is
      // its LATEST season) waits for the German version, which usually follows
      // the finale. Older gaps of a running show stay visible.
      const latest = (db.prepare('SELECT MAX(season_number) AS n FROM seasons WHERE movie_id = ?').get(m.id) as { n: number | null } | undefined)?.n ?? null;
      const info = cachedReleaseInfo(m.id);
      const unknownYet = info === undefined && !releaseInfoReady();
      const airingLatest = info?.kind === 'show' && !!info.nextAir && gaps.every(g => g.season_number === latest);
      if (gaps.length > 0 && !unknownYet && !airingLatest && !isExpectedWait(info, now)) {
        const list = gaps.map(g => `S${String(g.season_number).padStart(2, '0')}`).join(', ');
        out.push({
          key: `gap:${m.id}`, severity: 'info', kind: 'Staffel ohne Release',
          movieId: m.id, title: label,
          detail: `${list} ist ausgestrahlt, aber noch kein passendes Release — wird weiter gesucht`,
          since: m.last_checked_at, actions: ['retry', 'open'],
        });
      }
    }
    if (m.status === 'downloading' && m.updated_at && now - parseUtcDate(m.updated_at) > 3 * DAY) {
      out.push({
        key: `stuck:${m.id}`, severity: 'error', kind: 'Download hängt',
        movieId: m.id, title: label,
        detail: `Seit ${Math.floor((now - parseUtcDate(m.updated_at)) / DAY)} Tagen ohne Fortschritt`,
        since: m.updated_at, actions: ['retry', 'open'],
      });
    }
  }

  // ── Activity-based: newest entry per title and action within its window ──
  // A successful import AFTER an entry resolves it: the English file that was
  // reported is gone once the German one landed, an upgrade that failed and
  // then went through is no problem any more. They stayed listed for the
  // rule's whole window.
  const lastImport = new Map<number, string>(
    (db.prepare(`SELECT movie_id, MAX(created_at) AS at FROM activity_log
                 WHERE action = 'moved_to_library' AND movie_id IS NOT NULL GROUP BY movie_id`).all() as { movie_id: number; at: string }[] || [])
      .map(r => [r.movie_id, r.at]),
  );
  const lastBack = new Map<number, string>(
    (db.prepare(`SELECT movie_id, MAX(created_at) AS at FROM activity_log
                 WHERE action = 'library_back' AND movie_id IS NOT NULL GROUP BY movie_id`).all() as { movie_id: number; at: string }[] || [])
      .map(r => [r.movie_id, r.at]),
  );
  for (const rule of ACTIVITY_RULES) {
    const rows = db.prepare(`
      SELECT movie_id, MAX(created_at) AS at, details
      FROM activity_log
      WHERE action = ? AND movie_id IS NOT NULL AND created_at >= datetime('now', ?)
      GROUP BY movie_id
    `).all(rule.action, `-${rule.days} days`) as { movie_id: number; at: string; details: string | null }[];
    for (const r of rows) {
      const m = byId.get(r.movie_id);
      if (!m || !rule.stillRelevant(m)) continue;
      const imported = lastImport.get(m.id);
      if (imported && imported > r.at) continue;
      const back = lastBack.get(m.id);
      if (rule.action === 'library_missing' && back && back > r.at) continue;
      out.push({
        key: `${rule.action}:${m.id}`, severity: rule.severity,
        // The truncation check flags films too — "Folge" was wrong there.
        kind: rule.action === 'integrity_incomplete' && m.media_type !== 'show' ? 'Datei unvollständig — wird neu geladen' : rule.kind,
        movieId: m.id, title: m.year ? `${m.title} (${m.year})` : m.title,
        detail: r.details || rule.kind, since: r.at, actions: rule.actions,
      });
    }
  }

  // The same release sent to JDownloader again and again: a loop, not bad luck.
  // A season pack lacking one episode was re-sent ~170 times in two weeks
  // without a single entry here — every step on its own looked normal.
  const repeats = db.prepare(`
    SELECT movie_id, details, COUNT(*) AS n, MAX(created_at) AS at FROM activity_log
    WHERE action = 'sent_to_jdownloader' AND movie_id IS NOT NULL AND created_at >= datetime('now', '-7 days')
    GROUP BY movie_id, details HAVING COUNT(*) >= ?
  `).all(REPEAT_SENDS) as { movie_id: number; details: string | null; n: number; at: string }[];
  for (const r of repeats) {
    const m = byId.get(r.movie_id);
    if (!m) continue;
    const what = (r.details || '').replace(/: sent \d+ link\(s\) to JDownloader$/, '');
    out.push({
      key: `repeat:${m.id}:${what}`, severity: 'warning', kind: 'Wird immer wieder geladen',
      movieId: m.id, title: m.year ? `${m.title} (${m.year})` : m.title,
      detail: `${what || 'Dasselbe Release'} in 7 Tagen ${r.n}× an JDownloader geschickt — läuft vermutlich im Kreis`,
      since: r.at, actions: ['open'],
    });
  }

  // ── System-wide ─────────────────────────────────────────────────────────
  const mass = db.prepare(`
    SELECT MAX(created_at) AS at, details FROM activity_log
    WHERE action = 'library_mass_missing' AND movie_id IS NULL AND created_at >= datetime('now', '-1 days')
  `).get() as { at: string | null; details: string | null } | undefined;
  if (mass?.at) {
    out.push({
      key: 'library_mass_missing', severity: 'error', kind: 'Viele Filme fehlen gleichzeitig',
      movieId: null, title: 'Bibliothek', detail: mass.details || 'Freigabe oder Platte prüfen',
      since: mass.at, actions: ['settings'],
    });
  }
  for (const st of getResolveStats(now)) {
    if (st.attempts >= 6 && st.ok / st.attempts < 0.2) {
      out.push({
        key: `resolve:${st.plugin}`, severity: 'error', kind: 'Link-Auflösung bricht ein',
        movieId: null, title: `Quelle ${st.plugin}`,
        detail: `Nur ${st.ok} von ${st.attempts} Auflösungen in 24 h erfolgreich`,
        since: null, actions: ['settings'],
      });
    }
  }
  const room = checkRoom(0, {
    Downloads: getSetting('paths.downloads'),
    Filme: getSetting('paths.movies'),
    Serien: getSetting('paths.series'),
  });
  if (!room.ok) {
    out.push({
      key: 'disk', severity: 'error', kind: 'Speicherplatz unter der Reserve',
      movieId: null, title: 'Speicherplatz', detail: room.detail, since: null, actions: ['settings'],
    });
  }

  for (const f of getWatchdogFindings()) {
    out.push({
      key: f.key, severity: f.severity, kind: f.kind, movieId: f.movieId, title: f.title,
      detail: f.detail, since: null, actions: f.movieId ? ['open'] : [],
    });
  }

  return out.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || (b.since ?? '').localeCompare(a.since ?? ''));
}
