import db from '../index';

export interface BlocklistEntry {
  id: number;
  release_name: string;
  title: string | null;
  reason: string | null;
  movie_id: number | null;
  created_at: string;
}

export function getBlocklist(): BlocklistEntry[] {
  return db.prepare('SELECT * FROM blocklist ORDER BY created_at DESC').all() as BlocklistEntry[];
}

export function addBlocklistEntry(entry: {
  release_name: string;
  title?: string;
  reason?: string;
  movie_id?: number;
}): BlocklistEntry {
  const stmt = db.prepare(`
    INSERT INTO blocklist (release_name, title, reason, movie_id)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(
    entry.release_name,
    entry.title ?? null,
    entry.reason ?? null,
    entry.movie_id ?? null,
  );
  return db.prepare('SELECT * FROM blocklist WHERE id = ?').get(result.lastInsertRowid) as BlocklistEntry;
}

export function removeBlocklistEntry(id: number): boolean {
  const result = db.prepare('DELETE FROM blocklist WHERE id = ?').run(id);
  return result.changes > 0;
}

export function clearBlocklist(): number {
  const result = db.prepare('DELETE FROM blocklist').run();
  return result.changes;
}

export function isReleaseBlocklisted(releaseName: string): boolean {
  const normalized = releaseName.toLowerCase().trim();
  const entry = db.prepare(
    'SELECT id FROM blocklist WHERE LOWER(release_name) = ? LIMIT 1'
  ).get(normalized);
  return !!entry;
}
