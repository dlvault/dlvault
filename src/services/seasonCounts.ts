import type { Movie } from '../database/services/movies';
import { getSeasonsByShowId, addSeason, updateSeasonEpisodeCount, updateSeasonStatus } from '../database/services/seasons';
import { addEpisodes, getEpisodesBySeasonId } from '../database/services/episodes';
import { addLogEntry } from '../database/services/activityLog';

/** What a metadata source knows about one season. */
export interface SeasonCount {
  season: number;
  /** Episodes announced for the season (aired or not). */
  episodes: number;
  /** Episodes aired so far. */
  aired: number;
}

/**
 * Bring a show's season rows in line with a metadata source.
 *
 * - Unknown seasons are created (from the cutoff on, and never for a show
 *   whose season list is explicit — a closed set is not widened).
 * - Counts follow the source; the aired count only grows, so a lagging answer
 *   cannot shrink it.
 * - When more episodes have aired than are in the library, the new episodes
 *   get rows and a closed season opens again — a normal new episode, not a
 *   repair (no repair flag, no error message).
 *
 * Returns how many seasons were created.
 */
export function syncSeasonCounts(
  movie: Pick<Movie, 'id' | 'desired_quality' | 'season_cutoff' | 'seasons_explicit'>,
  counts: SeasonCount[],
): number {
  const existing = new Map(getSeasonsByShowId(movie.id).map(s => [s.season_number, s]));
  let created = 0;
  for (const c of counts) {
    if (c.season < 1 || c.episodes < 1) continue;
    const aired = Math.max(0, Math.min(c.aired, c.episodes));
    let row = existing.get(c.season);
    if (!row) {
      if (movie.seasons_explicit) continue;
      if (movie.season_cutoff != null && c.season < movie.season_cutoff) continue;
      row = addSeason(movie.id, c.season, movie.desired_quality || undefined);
      updateSeasonEpisodeCount(row.id, c.episodes, aired);
      if (aired > 0) addEpisodes(row.id, Array.from({ length: aired }, (_, i) => i + 1));
      created++;
      continue;
    }
    const before = row.aired_episodes ?? 0;
    if (row.episode_count !== c.episodes || before < aired) {
      updateSeasonEpisodeCount(row.id, c.episodes, Math.max(aired, before));
    }
    if (before > 0 && aired > before) {
      addEpisodes(row.id, Array.from({ length: aired }, (_, i) => i + 1));
      const have = getEpisodesBySeasonId(row.id).filter(e => e.status === 'downloaded').length;
      if (row.status === 'downloaded' && have < aired) {
        updateSeasonStatus(row.id, 'pending');
        addLogEntry(movie.id, 'seasons_synced',
          `S${String(c.season).padStart(2, '0')}: neue Folge(n) ausgestrahlt (${before} → ${aired}) — wird geladen`);
      }
    }
  }
  return created;
}
