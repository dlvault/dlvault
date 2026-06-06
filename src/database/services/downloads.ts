import db from '../index';

export interface Download {
  id: number;
  movie_id: number;
  season_number: number | null;
  release_name: string | null;
  quality: string | null;
  audio: string | null;
  hoster: string;
  download_url: string;
  status: 'pending' | 'sent_to_jd' | 'completed';
  jdownloader_package_id: string | null;
  created_at: string;
  updated_at: string;
}

export function getDownloadsByMovieId(movieId: number): Download[] {
  return db.prepare('SELECT * FROM downloads WHERE movie_id = ? ORDER BY created_at DESC').all(movieId) as Download[];
}

export function addDownload(download: {
  movie_id: number;
  season_number?: number | null;
  release_name?: string;
  quality?: string;
  audio?: string;
  hoster?: string;
  download_url: string;
}): Download {
  // Reuse the row if this exact URL already exists for this movie — but stamp it
  // as the newest attempt. Readers order by created_at DESC and treat the top row
  // as the copy on disk; a re-chosen release kept its old timestamp, so a later
  // release looked current. Seen as 2160p → 1080p re-download → the same 2160p
  // again: the 1080p rows stayed "newest", and the quality upgrade kept pulling
  // the 2160p release over and over.
  const existing = db.prepare('SELECT id FROM downloads WHERE movie_id = ? AND download_url = ? LIMIT 1')
    .get(download.movie_id, download.download_url) as { id: number } | undefined;
  if (existing) {
    db.prepare("UPDATE downloads SET created_at = datetime('now') WHERE id = ?").run(existing.id);
    return db.prepare('SELECT * FROM downloads WHERE id = ?').get(existing.id) as Download;
  }

  // INSERT OR IGNORE hardens the check-then-insert above against a concurrent
  // race: the (movie_id, download_url) UNIQUE index makes a losing insert a no-op
  // (changes === 0) instead of creating a duplicate row that would double-send to JD.
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO downloads (movie_id, season_number, release_name, quality, audio, hoster, download_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    download.movie_id,
    download.season_number ?? null,
    download.release_name ?? null,
    download.quality ?? null,
    download.audio ?? null,
    download.hoster ?? '',
    download.download_url
  );
  if (result.changes === 0) {
    // Lost the race (or a row appeared between the SELECT and the INSERT) — return
    // the surviving row so the contract (always returns a Download) holds.
    return db.prepare('SELECT * FROM downloads WHERE movie_id = ? AND download_url = ? LIMIT 1')
      .get(download.movie_id, download.download_url) as Download;
  }
  return db.prepare('SELECT * FROM downloads WHERE id = ?').get(result.lastInsertRowid) as Download;
}

export function updateDownloadStatus(id: number, status: Download['status'], jdPackageId?: string): void {
  if (jdPackageId) {
    db.prepare("UPDATE downloads SET status = ?, jdownloader_package_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, jdPackageId, id);
  } else {
    db.prepare("UPDATE downloads SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);
  }
}

export function updateDownloadStatusByMovieId(movieId: number, status: Download['status']): void {
  db.prepare("UPDATE downloads SET status = ?, updated_at = datetime('now') WHERE movie_id = ?")
    .run(status, movieId);
}

/**
 * Same, but confined to one season of a show.
 *
 * A show's download rows all share its movie_id, so the unscoped variant above
 * rewrote every season AND every episode row whenever a single season was sent
 * or moved: sending S02 marked S01's links `sent_to_jd`, and moving one season
 * marked the whole show `completed`. That made `downloads.status` meaningless
 * for shows — which matters, because the JD retry path uses it to decide what
 * still needs re-sending.
 *
 * Rows with a NULL season_number (movie rows, or legacy show rows written before
 * the column existed) are matched by `seasonNumber === null`.
 */
export function updateDownloadStatusBySeason(
  movieId: number,
  seasonNumber: number | null,
  status: Download['status'],
): void {
  if (seasonNumber === null) {
    db.prepare("UPDATE downloads SET status = ?, updated_at = datetime('now') WHERE movie_id = ? AND season_number IS NULL")
      .run(status, movieId);
    return;
  }
  db.prepare("UPDATE downloads SET status = ?, updated_at = datetime('now') WHERE movie_id = ? AND season_number = ?")
    .run(status, movieId, seasonNumber);
}

/**
 * Mark ONE release's rows as handed to JDownloader. The whole-title update used
 * before relabelled every earlier attempt — finished ones and blocklisted
 * ones — as in flight again; a film with three tries carried 40 such rows.
 */
export function markReleaseSent(movieId: number, releaseName: string | null | undefined, seasonNumber?: number): void {
  if (!releaseName) {
    if (seasonNumber !== undefined) updateDownloadStatusBySeason(movieId, seasonNumber, 'sent_to_jd');
    else updateDownloadStatusByMovieId(movieId, 'sent_to_jd');
    return;
  }
  if (seasonNumber !== undefined) {
    db.prepare("UPDATE downloads SET status = 'sent_to_jd', updated_at = datetime('now') WHERE movie_id = ? AND season_number = ? AND release_name = ?")
      .run(movieId, seasonNumber, releaseName);
    return;
  }
  db.prepare("UPDATE downloads SET status = 'sent_to_jd', updated_at = datetime('now') WHERE movie_id = ? AND release_name = ?")
    .run(movieId, releaseName);
}

export function getDownloadsByMovieIds(movieIds: number[]): Map<number, Download[]> {
  if (movieIds.length === 0) return new Map();
  const placeholders = movieIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM downloads WHERE movie_id IN (${placeholders}) ORDER BY created_at DESC`).all(...movieIds) as Download[];
  const map = new Map<number, Download[]>();
  for (const row of rows) {
    const list = map.get(row.movie_id) || [];
    list.push(row);
    map.set(row.movie_id, list);
  }
  return map;
}

export function getAllDownloads(): Download[] {
  return db.prepare(`
    SELECT d.*, m.title as movie_title
    FROM downloads d
    LEFT JOIN movies m ON d.movie_id = m.id
    ORDER BY d.created_at DESC
  `).all() as (Download & { movie_title: string })[];
}
