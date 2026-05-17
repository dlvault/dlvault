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
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export async function getMovieDetails(imdbId: string): Promise<OmdbMovieDetails | null> {
  if (!imdbId) return null;
  const data = await omdbGet({ i: imdbId, plot: 'short' });
  if (!data) return null;
  return {
    released: parseDate(data.Released),
    poster: data.Poster && data.Poster !== 'N/A' ? String(data.Poster) : null,
    plot: data.Plot && data.Plot !== 'N/A' ? String(data.Plot) : null,
    genre: data.Genre && data.Genre !== 'N/A' ? String(data.Genre) : null,
    type: data.Type as OmdbMovieDetails['type'],
    totalSeasons: data.totalSeasons ? parseInt(data.totalSeasons) : null,
  };
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

export const omdbService = { getMovieDetails, getSeasonEpisodes, isConfigured, testConnection };
