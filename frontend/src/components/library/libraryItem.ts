import type { LibraryItem, Movie } from '../../types/index';
import { qualityLabel } from '../../composables/useDetailPanel';
import { timeAgo } from '../../composables/useFormatters';

/**
 * A LibraryItem joined with whatever metadata the dlvault DB happens to know
 * about the same title — rating, genres, runtime, quality, addedAt. Items that
 * were placed in Plex/Jellyfin directly (without going through dlvault) have
 * no match and stay sparse; the rest of the redesign degrades around that.
 */
export interface EnrichedLibraryItem extends LibraryItem {
  sortName: string;          // articles stripped, leading punctuation removed
  bucket: string;            // first letter ('A'..'Z') or '#'
  rating?: number;
  runtimeMinutes?: number;
  runtimeLabel?: string;     // e.g. "2h 32m"
  genres?: string[];
  quality?: string;          // canonical '4K' | '1080p' | '720p' | raw
  addedAt?: string | null;   // naive-UTC string (no trailing Z); provider library-add time, else movies.added_at
  addedRelative?: string;    // pre-formatted "vor 3 Tagen"
  plot?: string;
  director?: string;
  studio?: string;
  country?: string;
}

const ARTICLE_RE = /^(the|a|an|der|die|das|den|le|la|les|el|los|las)\s+/i;

export function sortNameFor(name: string | null | undefined): string {
  return (name || '').trim().replace(ARTICLE_RE, '');
}

export function bucketOf(name: string | null | undefined): string {
  const trimmed = sortNameFor(name);
  if (!trimmed) return '#';
  // Strip combining diacritics so 'Über' → 'U', 'Éclat' → 'E'.
  const first = trimmed.normalize('NFD').replace(/\p{Mn}/gu, '').charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : '#';
}

function runtimeLabelOf(minutes: number | null | undefined): string | undefined {
  if (!minutes || minutes <= 0) return undefined;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Build a lookup once per render — by imdb_id first (high confidence), then by
// (title, year) as a fallback for items that lost their imdb id during import.
function indexMovies(movies: Movie[]) {
  const byImdb = new Map<string, Movie>();
  const byTitleYear = new Map<string, Movie>();
  for (const m of movies) {
    if (m.imdb_id) byImdb.set(m.imdb_id, m);
    if (m.title && m.year) byTitleYear.set(`${m.title.toLowerCase()}|${m.year}`, m);
  }
  return { byImdb, byTitleYear };
}

function matchMovie(item: LibraryItem, idx: ReturnType<typeof indexMovies>): Movie | undefined {
  if (item.imdbId) {
    const hit = idx.byImdb.get(item.imdbId);
    if (hit) return hit;
  }
  if (item.name && item.year) {
    const hit = idx.byTitleYear.get(`${item.name.toLowerCase()}|${item.year}`);
    if (hit) return hit;
  }
  return undefined;
}

export function enrichItems(items: LibraryItem[], movies: Movie[]): EnrichedLibraryItem[] {
  const idx = indexMovies(movies);
  return items.map(item => {
    const m = matchMovie(item, idx);
    const sortName = sortNameFor(item.name);
    const enriched: EnrichedLibraryItem = {
      ...item,
      sortName,
      bucket: bucketOf(item.name),
    };
    // addedAt: prefer the media server's REAL library-add time (item.addedAt,
    // from Plex/Jellyfin) over dlvault's own import time (m.added_at). Falling
    // back to import time only keeps a sensible value for items dlvault tracks
    // but the provider gave no timestamp for.
    const addedAt = item.addedAt || m?.added_at;
    if (addedAt) {
      enriched.addedAt = addedAt;
      enriched.addedRelative = timeAgo(addedAt);
    }
    if (m) {
      if (m.rating != null) enriched.rating = m.rating;
      if (m.runtime != null) {
        enriched.runtimeMinutes = m.runtime;
        enriched.runtimeLabel = runtimeLabelOf(m.runtime);
      }
      if (m.genres) {
        enriched.genres = m.genres.split(',').map(g => g.trim()).filter(Boolean);
      }
      if (m.desired_quality) enriched.quality = qualityLabel(m.desired_quality);
      if (m.plot) enriched.plot = m.plot;
      if (m.director) enriched.director = m.director;
      if (m.studio) enriched.studio = m.studio;
      if (m.country) enriched.country = m.country;
    }
    return enriched;
  });
}
