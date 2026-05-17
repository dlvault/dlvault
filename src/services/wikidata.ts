import axios from 'axios';
import { logger } from '../utils/logger';

const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';

// Cache to avoid repeated lookups for the same IMDB ID. Bounded with FIFO
// eviction so a long-running process can't grow the map without limit (Map
// preserves insertion order, so deleting `keys().next().value` drops the
// oldest entry).
const CACHE_MAX = 5000;
const cache = new Map<string, string | null>();

function cacheSet(imdbId: string, title: string | null): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(imdbId, title);
}

/**
 * Fetches the German title for a movie from Wikidata by IMDb ID.
 * Free, no API key required. Returns null if not found or on error.
 */
export async function getGermanTitleFromWikidata(imdbId: string): Promise<string | null> {
  if (cache.has(imdbId)) return cache.get(imdbId) ?? null;

  const query = `
    SELECT ?label WHERE {
      ?film wdt:P345 "${imdbId}" .
      ?film rdfs:label ?label .
      FILTER(LANG(?label) = "de")
    } LIMIT 1
  `;

  try {
    const res = await axios.get(WIKIDATA_SPARQL, {
      params: { query, format: 'json' },
      headers: { 'User-Agent': 'dlvault/1.0 (https://github.com/dlvault)' },
      timeout: 8000,
    });

    const bindings = res.data?.results?.bindings;
    const title = bindings?.[0]?.label?.value ?? null;
    cacheSet(imdbId, title);
    return title;
  } catch (error: any) {
    logger.debug(`Wikidata lookup failed for ${imdbId}: ${error.message}`);
    cacheSet(imdbId, null);
    return null;
  }
}
