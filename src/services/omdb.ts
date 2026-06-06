import axios from 'axios';
import { getSetting } from '../database/index';
import { logger } from '../utils/logger';

const OMDB_BASE = 'https://www.omdbapi.com/';
const CACHE_TTL = 6 * 60 * 60 * 1000;

export interface OmdbMovieDetails {
  released: string | null;  // "YYYY-MM-DD"
  poster: string | null;    // full URL
  plot: string | null;
  genre: string | null;
  rating: number | null;    // imdbRating 0–10
  runtime: number | null;   // minutes
  director: string | null;
  studio: string | null;    // OMDb "Production" (often N/A on newer titles)
  country: string | null;
  type: 'movie' | 'series' | 'episode';
  totalSeasons: number | null;
}

export interface OmdbEpisode {
  number: number;
  title: string;
  air_date: string | null;  // "YYYY-MM-DD"
}

const cache = new Map<string, { data: any; ts: number }>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data as T;
  return null;
}

function setCache(key: string, data: any): void {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

async function omdbGet(params: Record<string, string>): Promise<any> {
  const apiKey = getSetting('omdb.api_key');
  if (!apiKey) return null;

  const cacheKey = JSON.stringify(params);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await axios.get(OMDB_BASE, {
      params: { apikey: apiKey, ...params },
      timeout: 10000,
    });
    if (res.data?.Response !== 'True') return null;
    setCache(cacheKey, res.data);
    return res.data;
  } catch (error: any) {
    logger.debug(`OMDb error: ${error.message}`);
    return null;
  }
}

function parseDate(value: string | undefined): string | null {
  if (!value || value === 'N/A') return null;
  // OMDb gives dates with no timezone — either ISO "1999-03-31" or "DD Mon YYYY"
  // (e.g. "31 Mar 1999"). new Date(...).toISOString() parsed the latter as LOCAL
  // midnight, so the UTC slice landed a day early east of UTC (Europe/Berlin:
  // "31 Mar 1999" → "1999-03-30"). Anchor every format to UTC.
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  let d = new Date(`${value} UTC`);
  if (isNaN(d.getTime())) d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseStr(value: string | undefined): string | null {
  return value && value !== 'N/A' ? String(value) : null;
}

function parseRuntime(value: string | undefined): number | null {
  // OMDb returns "136 min"
  const m = value && value !== 'N/A' ? value.match(/(\d+)/) : null;
  return m ? parseInt(m[1], 10) : null;
}

function parseRating(value: string | undefined): number | null {
  if (!value || value === 'N/A') return null;
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

export async function getMovieDetails(imdbId: string): Promise<OmdbMovieDetails | null> {
  if (!imdbId) return null;
  const data = await omdbGet({ i: imdbId, plot: 'short' });
  if (!data) return null;
  return {
    released: parseDate(data.Released),
    poster: data.Poster && data.Poster !== 'N/A' ? String(data.Poster) : null,
    plot: parseStr(data.Plot),
    genre: parseStr(data.Genre),
    rating: parseRating(data.imdbRating),
    runtime: parseRuntime(data.Runtime),
    director: parseStr(data.Director),
    studio: parseStr(data.Production),
    country: parseStr(data.Country),
    type: data.Type as OmdbMovieDetails['type'],
    totalSeasons: data.totalSeasons ? parseInt(data.totalSeasons) : null,
  };
}

/**
 * Resolve an imdb id from a title (+ optional year) via OMDb's exact-title
 * lookup. Returns the canonical "tt…" id, or null when OMDb is unconfigured, the
 * title doesn't resolve, or the response carries no usable id. Used to backfill
 * movies added without an imdb id (e.g. a Telegram pick that matched a plugin
 * candidate carrying none) so a poster and metadata can be fetched.
 */
export async function findImdbId(
  title: string,
  year?: number | null,
  type: 'movie' | 'series' = 'movie',
): Promise<string | null> {
  if (!title) return null;
  const data = await omdbGet({ t: title, type, ...(year ? { y: String(year) } : {}) });
  const id = data?.imdbID;
  return typeof id === 'string' && /^tt\d+$/i.test(id) ? id : null;
}

export async function getSeasonEpisodes(imdbId: string, season: number): Promise<OmdbEpisode[]> {
  if (!imdbId) return [];
  const data = await omdbGet({ i: imdbId, Season: String(season) });
  if (!data?.Episodes) return [];
  return (data.Episodes as any[]).map(ep => ({
    number: parseInt(ep.Episode),
    title: ep.Title && ep.Title !== 'N/A' ? String(ep.Title) : `Episode ${ep.Episode}`,
    air_date: parseDate(ep.Released),
  }));
}

export function isConfigured(): boolean {
  return !!getSetting('omdb.api_key');
}

export async function testConnection(): Promise<{ success: boolean; error?: string }> {
  const apiKey = getSetting('omdb.api_key');
  if (!apiKey) return { success: false, error: 'Kein API-Key konfiguriert' };

  try {
    const res = await axios.get(OMDB_BASE, {
      params: { apikey: apiKey, i: 'tt0133093' },
      timeout: 10000,
    });
    if (res.data?.Response === 'True') return { success: true };
    return { success: false, error: res.data?.Error || 'Ungültiger API-Key' };
  } catch (error: any) {
    return { success: false, error: error.response?.status === 401 ? 'Ungültiger API-Key' : error.message };
  }
}

export const omdbService = { getMovieDetails, findImdbId, getSeasonEpisodes, isConfigured, testConnection };
