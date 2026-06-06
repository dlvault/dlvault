import db from '../index';

export interface Episode {
  id: number;
  season_id: number;
  episode_number: number;
  status: 'pending' | 'downloading' | 'downloaded';
  release_name: string | null;
  created_at: string;
  updated_at: string;
}

export function getEpisodesBySeasonId(seasonId: number): Episode[] {
  return db.prepare('SELECT * FROM episodes WHERE season_id = ? ORDER BY episode_number ASC')
    .all(seasonId) as Episode[];
}

export function getEpisode(seasonId: number, episodeNumber: number): Episode | undefined {
  return db.prepare('SELECT * FROM episodes WHERE season_id = ? AND episode_number = ?')
    .get(seasonId, episodeNumber) as Episode | undefined;
}

export function addEpisode(seasonId: number, episodeNumber: number): Episode {
  db.prepare(`
    INSERT OR IGNORE INTO episodes (season_id, episode_number)
    VALUES (?, ?)
  `).run(seasonId, episodeNumber);

  return getEpisode(seasonId, episodeNumber)!;
}

export function addEpisodes(seasonId: number, episodeNumbers: number[]): Episode[] {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO episodes (season_id, episode_number)
    VALUES (?, ?)
  `);

  const insertMany = db.transaction(() => {
    for (const num of episodeNumbers) {
      stmt.run(seasonId, num);
    }
  });
  insertMany();

  return getEpisodesBySeasonId(seasonId);
}

export function updateEpisodeStatus(id: number, status: Episode['status'], releaseName?: string): void {
  if (releaseName) {
    db.prepare("UPDATE episodes SET status = ?, release_name = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, releaseName, id);
  } else {
    db.prepare("UPDATE episodes SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);
  }
}

export function markAllEpisodesDownloaded(seasonId: number, releaseName?: string): void {
  if (releaseName) {
    db.prepare("UPDATE episodes SET status = 'downloaded', release_name = ?, updated_at = datetime('now') WHERE season_id = ?")
      .run(releaseName, seasonId);
  } else {
    db.prepare("UPDATE episodes SET status = 'downloaded', updated_at = datetime('now') WHERE season_id = ?")
      .run(seasonId);
  }
}

/**
 * Mark ONLY the given episode numbers as downloaded (creating rows for any the
 * DB didn't know about — e.g. a season pack carried more files than Trakt's
 * aired_episodes count). Unlike markAllEpisodesDownloaded this never touches
 * episodes that weren't actually delivered, so a partial season (only some
 * episodes available) doesn't get falsely flagged complete.
 */
export function markEpisodesDownloaded(seasonId: number, episodeNumbers: number[], releaseName?: string): void {
  if (episodeNumbers.length === 0) return;
  const insert = db.prepare('INSERT OR IGNORE INTO episodes (season_id, episode_number) VALUES (?, ?)');
  const updateWithRelease = db.prepare(
    "UPDATE episodes SET status = 'downloaded', release_name = ?, updated_at = datetime('now') WHERE season_id = ? AND episode_number = ?",
  );
  const updateNoRelease = db.prepare(
    "UPDATE episodes SET status = 'downloaded', updated_at = datetime('now') WHERE season_id = ? AND episode_number = ?",
  );
  const tx = db.transaction(() => {
    for (const num of episodeNumbers) {
      insert.run(seasonId, num);
      if (releaseName) updateWithRelease.run(releaseName, seasonId, num);
      else updateNoRelease.run(seasonId, num);
    }
  });
  tx();
}

/**
 * Episodes that still need to be fetched — status === 'pending' only.
 *
 * Deliberately excludes 'downloading' (already sent to JDownloader): re-including
 * them caused the scheduler to re-resolve their links every sync (wasted captcha)
 * and create duplicate JD packages. Use getSeasonCompletionStatus for "is the
 * season done" — that counts 'downloaded' against the full episode set.
 */
export function getPendingEpisodes(seasonId: number): Episode[] {
  return db.prepare("SELECT * FROM episodes WHERE season_id = ? AND status = 'pending' ORDER BY episode_number ASC")
    .all(seasonId) as Episode[];
}

export function getSeasonCompletionStatus(seasonId: number): { total: number; downloaded: number; allDone: boolean } {
  const episodes = getEpisodesBySeasonId(seasonId);
  if (episodes.length === 0) return { total: 0, downloaded: 0, allDone: false };

  const downloaded = episodes.filter(e => e.status === 'downloaded').length;
  return {
    total: episodes.length,
    downloaded,
    allDone: downloaded === episodes.length,
  };
}
