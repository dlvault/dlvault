import db from '../index';
import { toSqliteUtc } from '../../utils/datetime';

export interface ActivityLogEntry {
  id: number;
  movie_id: number | null;
  action: string;
  details: string | null;
  created_at: string;
}

export function addLogEntry(movieId: number | null, action: string, details?: string): void {
  db.prepare('INSERT INTO activity_log (movie_id, action, details) VALUES (?, ?, ?)')
    .run(movieId, action, details ?? null);
}

export function getRecentLogs(limit: number = 100, action?: string): (ActivityLogEntry & { movie_title?: string })[] {
  const where = action ? 'WHERE l.action = ?' : '';
  const params = action ? [action, limit] : [limit];
  return db.prepare(`
    SELECT l.*, m.title as movie_title
    FROM activity_log l
    LEFT JOIN movies m ON l.movie_id = m.id
    ${where}
    ORDER BY l.created_at DESC
    LIMIT ?
  `).all(...params) as (ActivityLogEntry & { movie_title?: string })[];
}

export function getLogsByMovieId(movieId: number): ActivityLogEntry[] {
  return db.prepare('SELECT * FROM activity_log WHERE movie_id = ? ORDER BY created_at DESC')
    .all(movieId) as ActivityLogEntry[];
}

/**
 * Returns true if an activity entry with the given action exists for this
 * movie within the last `sinceHours`. Used by hourly reconcilers to dedupe
 * "still in the same broken state" warnings into once-per-day reminders.
 */
export function hasRecentActivityEntry(movieId: number, action: string, sinceHours: number): boolean {
  const row = db.prepare(
    `SELECT 1 FROM activity_log
     WHERE movie_id = ? AND action = ?
       AND created_at > datetime('now', ? || ' hours')
     LIMIT 1`,
  ).get(movieId, action, `-${sinceHours}`);
  return !!row;
}

/**
 * Delete activity_log rows older than 90 days, capped per call so a huge
 * backlog can't stall the writer. Runs at boot (database init has its own
 * inline copy) and hourly via reconcileDatabase — the boot-only prune fell
 * behind on long uptimes (~1-2k new rows/day vs. one capped batch per boot).
 */
export function pruneOldActivityLogs(maxRows = 5000): number {
  const res = db.prepare(
    `DELETE FROM activity_log WHERE id IN
       (SELECT id FROM activity_log WHERE created_at < datetime('now', '-90 days') LIMIT ?)`,
  ).run(maxRows);
  return res.changes;
}

const SUCCESS_ACTIONS = new Set([
  'release_found',
  'sent_to_jdownloader',
  'download_finished',
  'extraction_finished',
  'moved_to_library',
  'quality_upgrade',
]);
const ERROR_ACTIONS = new Set(['not_found', 'error', 'jdownloader_error', 'captcha_pending']);

/**
 * "Diese Woche" delta for the dashboard hero, counted directly from the DB
 * over the last 7 days.
 *
 * This MUST query the table rather than be derived client-side from the
 * recent-logs feed: the dashboard only loads the last 20 log rows, so the old
 * client-side bucketing capped this number far below reality (showing e.g.
 * "+2" on a day with many more adds). `created_at` is stored as UTC via
 * `datetime('now')`, matching the comparison value here.
 */
export function getWeekDelta(): { added: number; completed: number } {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN action = 'movie_added'      THEN 1 ELSE 0 END) AS added,
      SUM(CASE WHEN action = 'moved_to_library' THEN 1 ELSE 0 END) AS completed
    FROM activity_log
    WHERE created_at >= datetime('now', '-7 days')
  `).get() as { added: number | null; completed: number | null };
  return { added: row.added ?? 0, completed: row.completed ?? 0 };
}

/**
 * Get aggregated activity stats for the last N days.
 */
export function getActivityStats(days: number = 30): {
  daily: { date: string; success: number; error: number; other: number }[];
  totals: { success: number; error: number; other: number; total: number };
  topActions: { action: string; count: number }[];
  completed: number;
} {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  // Match SQLite's space-separated UTC format so boundary-day rows aren't
  // dropped by a lexicographic comparison — see toSqliteUtc().
  const cutoffStr = toSqliteUtc(cutoff);

  // Daily breakdown grouped by action
  const rows = db.prepare(`
    SELECT DATE(created_at) as date, action, COUNT(*) as count
    FROM activity_log
    WHERE created_at >= ?
    GROUP BY DATE(created_at), action
    ORDER BY date ASC
  `).all(cutoffStr) as { date: string; action: string; count: number }[];

  // Pre-fill all days
  const dailyMap = new Map<string, { success: number; error: number; other: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dailyMap.set(d.toISOString().slice(0, 10), { success: 0, error: 0, other: 0 });
  }

  const totals = { success: 0, error: 0, other: 0, total: 0 };
  for (const row of rows) {
    const entry = dailyMap.get(row.date) || { success: 0, error: 0, other: 0 };
    if (SUCCESS_ACTIONS.has(row.action)) {
      entry.success += row.count;
      totals.success += row.count;
    } else if (ERROR_ACTIONS.has(row.action)) {
      entry.error += row.count;
      totals.error += row.count;
    } else {
      entry.other += row.count;
      totals.other += row.count;
    }
    dailyMap.set(row.date, entry);
  }
  totals.total = totals.success + totals.error + totals.other;

  // Top actions
  const topActions = db.prepare(`
    SELECT action, COUNT(*) as count FROM activity_log
    WHERE created_at >= ? GROUP BY action ORDER BY count DESC LIMIT 10
  `).all(cutoffStr) as { action: string; count: number }[];

  // Completed downloads in period
  const completed = (db.prepare(`
    SELECT COUNT(*) as c FROM activity_log WHERE action = 'moved_to_library' AND created_at >= ?
  `).get(cutoffStr) as { c: number }).c;

  return {
    daily: [...dailyMap.entries()].map(([date, counts]) => ({ date, ...counts })),
    totals,
    topActions,
    completed,
  };
}
