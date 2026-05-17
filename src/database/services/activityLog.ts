import db from '../index';

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

export function getRecentLogs(limit: number = 100): (ActivityLogEntry & { movie_title?: string })[] {
  return db.prepare(`
    SELECT l.*, m.title as movie_title
    FROM activity_log l
    LEFT JOIN movies m ON l.movie_id = m.id
    ORDER BY l.created_at DESC
    LIMIT ?
  `).all(limit) as (ActivityLogEntry & { movie_title?: string })[];
}

export function getLogsByMovieId(movieId: number): ActivityLogEntry[] {
  return db.prepare('SELECT * FROM activity_log WHERE movie_id = ? ORDER BY created_at DESC')
    .all(movieId) as ActivityLogEntry[];
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
  const cutoffStr = cutoff.toISOString();

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
