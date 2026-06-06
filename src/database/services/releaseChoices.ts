import db from '../index';

export type ReleaseChoiceStatus = 'pending' | 'chosen' | 'later' | 'auto';

export interface ReleaseChoiceOption {
  title: string;
  quality: string;
  hosters: string[];
  size: string;
}

/** One operator question about which release to take for a title. */
export interface ReleaseChoice {
  /** Which release group the question is about: 'film' or 's<season>' (season pack). */
  key: string;
  label: string;
  status: ReleaseChoiceStatus;
  /** ms epoch of the last status change. */
  at: number;
  options: ReleaseChoiceOption[];
  chosenTitle?: string;
}

export function getReleaseChoice(movieId: number): ReleaseChoice | null {
  const row = db.prepare('SELECT data FROM release_choices WHERE movie_id = ?').get(movieId) as { data: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.data) as ReleaseChoice; } catch { return null; }
}

export function setReleaseChoice(movieId: number, choice: ReleaseChoice): void {
  db.prepare(`INSERT INTO release_choices (movie_id, data, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(movie_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .run(movieId, JSON.stringify(choice));
}
