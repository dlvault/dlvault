import db from '../index';

/**
 * Library files the truncation check already judged (path → size at the time).
 * Kept in the database: in memory only, every restart — and every update —
 * started over with the same first slice, and titles further down the library
 * were never reached.
 *
 * Best effort: a failure here only means a file is probed once more.
 */

export function loadCheckedFiles(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const rows = db.prepare('SELECT path, size FROM file_checks').all() as { path: string; size: number }[];
    for (const r of rows) out.set(r.path, r.size);
  } catch { /* see above */ }
  return out;
}

export function markFileChecked(path: string, size: number): void {
  try {
    db.prepare(`INSERT INTO file_checks (path, size, checked_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(path) DO UPDATE SET size = excluded.size, checked_at = excluded.checked_at`).run(path, size);
  } catch { /* see above */ }
}

/** Forget files no longer on disk, so the table does not grow with every rename. */
export function pruneCheckedFiles(keep: (path: string) => boolean): number {
  try {
    const all = [...loadCheckedFiles().keys()];
    const gone = all.filter(p => !keep(p));
    // Most of them "gone" is an unmounted share, not deleted files.
    if (gone.length > all.length / 2) return 0;
    const del = db.prepare('DELETE FROM file_checks WHERE path = ?');
    for (const p of gone) del.run(p);
    return gone.length;
  } catch {
    return 0;
  }
}
