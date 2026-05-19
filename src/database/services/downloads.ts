import db from '../index';

export interface Download {
  id: number;
  movie_id: number;
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
  release_name?: string;
  quality?: string;
  audio?: string;
  hoster?: string;
  download_url: string;
}): Download {
  // Skip if this exact URL already exists for this movie
  const existing = db.prepare('SELECT * FROM downloads WHERE movie_id = ? AND download_url = ? LIMIT 1').get(download.movie_id, download.download_url);
  if (existing) return existing as Download;

  const stmt = db.prepare(`
    INSERT INTO downloads (movie_id, release_name, quality, audio, hoster, download_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    download.movie_id,
    download.release_name ?? null,
    download.quality ?? null,
    download.audio ?? null,
    download.hoster ?? '',
    download.download_url
  );
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
