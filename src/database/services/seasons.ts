import db from '../index';

export interface Season {
  id: number;
  movie_id: number;
  season_number: number;
  status: 'pending' | 'searching' | 'found' | 'downloading' | 'downloaded' | 'not_found';
  desired_quality: string;
  source_url: string | null;
  last_checked_at: string | null;
  episode_count: number | null;
  aired_episodes: number | null;
  created_at: string;
  updated_at: string;
}

export function getSeasonsByShowId(movieId: number): Season[] {
  return db.prepare('SELECT * FROM seasons WHERE movie_id = ? ORDER BY season_number ASC')
    .all(movieId) as Season[];
}

export function getSeasonsByShowIds(movieIds: number[]): Map<number, Season[]> {
  if (movieIds.length === 0) return new Map();
  const placeholders = movieIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM seasons WHERE movie_id IN (${placeholders}) ORDER BY movie_id ASC, season_number ASC`,
  ).all(...movieIds) as Season[];
  const map = new Map<number, Season[]>();
  for (const row of rows) {
    const list = map.get(row.movie_id) || [];
    list.push(row);
    map.set(row.movie_id, list);
  }
  return map;
}

export function getSeason(movieId: number, seasonNumber: number): Season | undefined {
  return db.prepare('SELECT * FROM seasons WHERE movie_id = ? AND season_number = ?')
    .get(movieId, seasonNumber) as Season | undefined;
}

export function addSeason(movieId: number, seasonNumber: number, quality?: string): Season {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO seasons (movie_id, season_number, desired_quality)
    VALUES (?, ?, ?)
  `);
  stmt.run(movieId, seasonNumber, quality || '1080p');

  return getSeason(movieId, seasonNumber)!;
}

export function addSeasons(movieId: number, seasonNumbers: number[], quality?: string): Season[] {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO seasons (movie_id, season_number, desired_quality)
    VALUES (?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    for (const num of seasonNumbers) {
      stmt.run(movieId, num, quality || '1080p');
    }
  });
  insertMany();

  return getSeasonsByShowId(movieId);
}

export function updateSeasonStatus(id: number, status: Season['status'], sourceUrl?: string): void {
  if (sourceUrl) {
    db.prepare("UPDATE seasons SET status = ?, source_url = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, sourceUrl, id);
  } else {
    db.prepare("UPDATE seasons SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);
  }
}

export function updateSeasonLastChecked(id: number): void {
  db.prepare("UPDATE seasons SET last_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(id);
}

export function deleteSeason(id: number): void {
  db.prepare('DELETE FROM seasons WHERE id = ?').run(id);
}

export function updateSeasonEpisodeCount(id: number, episodeCount: number, airedEpisodes?: number): void {
  db.prepare("UPDATE seasons SET episode_count = ?, aired_episodes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(episodeCount, airedEpisodes ?? episodeCount, id);
}

