import axios, { AxiosInstance } from 'axios';
import { getSetting } from '../database/index';
import { logger } from '../utils/logger';
import type { CatalogItem } from './seerr';

/**
 * TMDb as dlvault's own metadata source for search and discovery.
 *
 * Until now the catalog came from Trakt (whose API closed), Plex Discover (needs
 * a Plex account) or Seerr (needs Seerr). None of those is something dlvault can
 * rely on by itself, so an instance without them had a half-dead search. Talking
 * to TMDb directly removes that: it is the same source Seerr proxies, one step
 * shorter.
 *
 * Fits the neutral-host rule: TMDb supplies *metadata*, never anything about
 * where a file might come from.
 *
 * Contract verified against TMDb's API reference rather than a live call — no
 * key was available while building this. Two things that verification settled:
 * the response is snake_case throughout, and v3 accepts EITHER an `api_key`
 * query parameter OR an access token as a Bearer header.
 */

const TMDB_API = 'https://api.themoviedb.org/3';

/**
 * TMDb shows users two different credentials side by side — a short "API Key"
 * and a long "API Read Access Token" (a JWT). They are not interchangeable in
 * how they travel, and pasting the wrong one is the obvious mistake. Rather than
 * insisting on one, detect which was given.
 */
function looksLikeAccessToken(value: string): boolean {
  return value.startsWith('eyJ') && value.split('.').length === 3;
}

/** dlvault's release-language setting, mapped onto TMDb's locale codes. */
const LOCALES: Record<string, string> = {
  german: 'de-DE',
  english: 'en-US',
  french: 'fr-FR',
  spanish: 'es-ES',
  italian: 'it-IT',
  dutch: 'nl-NL',
};

export class TmdbService {
  private client: AxiosInstance | null = null;
  private clientKey = '';

  private getKey(): string {
    return (getSetting('tmdb.api_key') || '').trim();
  }

  isConfigured(): boolean {
    return !!this.getKey();
  }

  /**
   * Titles are requested in the language the user actually wants releases in —
   * the sources index German titles, so searching for the English one finds
   * nothing. Falls back to English for anything unmapped.
   */
  private language(): string {
    const configured = (getSetting('quality.language') || 'german').toLowerCase().trim();
    return LOCALES[configured] || 'en-US';
  }

  private getClient(): AxiosInstance {
    const key = this.getKey();
    if (!this.client || this.clientKey !== key) {
      this.client = axios.create({
        baseURL: TMDB_API,
        timeout: 15000,
        ...(looksLikeAccessToken(key)
          ? { headers: { Authorization: `Bearer ${key}` } }
          : { params: { api_key: key } }),
      });
      this.clientKey = key;
    }
    return this.client;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    if (!this.isConfigured()) return { ok: false, error: 'Kein API-Schlüssel hinterlegt' };
    try {
      await this.getClient().get('/configuration');
      return { ok: true };
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 401) return { ok: false, error: 'Schlüssel wurde abgelehnt' };
      return { ok: false, error: error?.message || 'nicht erreichbar' };
    }
  }

  /**
   * Maps one TMDb row onto the shared catalog shape.
   *
   * `imdbId` stays null: the search and trending endpoints do not carry it, and
   * fetching it per row would mean one extra request per result. Posters ride on
   * `posterPath` instead, which every row does carry.
   */
  private toCatalogItem(r: any, want: ('movie' | 'show')[]): CatalogItem | null {
    const type: 'movie' | 'show' | null =
      r?.media_type === 'movie' ? 'movie' : r?.media_type === 'tv' ? 'show' : null;
    // `person` rows appear in both multi-search and trending; drop them.
    if (!type || !want.includes(type)) return null;
    const title = type === 'movie' ? r.title : r.name;
    if (!title) return null;
    const date: string = (type === 'movie' ? r.release_date : r.first_air_date) || '';
    return {
      type,
      title,
      year: Number(date.slice(0, 4)) || null,
      imdbId: null,
      tmdbId: typeof r.id === 'number' ? r.id : null,
      posterPath: typeof r.poster_path === 'string' ? r.poster_path : null,
    };
  }

  async searchCatalog(
    query: string,
    opts: { types: ('movie' | 'show')[]; limit?: number },
  ): Promise<CatalogItem[]> {
    if (!this.isConfigured() || opts.types.length === 0 || !query.trim()) return [];
    try {
      const res = await this.getClient().get('/search/multi', {
        params: {
          query: query.trim(),
          language: this.language(),
          page: 1,
          include_adult: false,
        },
      });
      const out: CatalogItem[] = [];
      for (const r of res.data?.results || []) {
        const item = this.toCatalogItem(r, opts.types);
        if (item) out.push(item);
        if (out.length >= (opts.limit ?? 30)) break;
      }
      return out;
    } catch (error: any) {
      logger.warn(`TMDb search failed for "${query}": ${error?.message || error}`);
      return [];
    }
  }

  async getTrending(opts: { types: ('movie' | 'show')[]; limit?: number }): Promise<CatalogItem[]> {
    if (!this.isConfigured() || opts.types.length === 0) return [];
    try {
      const res = await this.getClient().get('/trending/all/week', {
        params: { language: this.language() },
      });
      const out: CatalogItem[] = [];
      for (const r of res.data?.results || []) {
        const item = this.toCatalogItem(r, opts.types);
        if (item) out.push(item);
        if (out.length >= (opts.limit ?? 20)) break;
      }
      return out;
    } catch (error: any) {
      logger.warn(`TMDb trending failed: ${error?.message || error}`);
      return [];
    }
  }
}

export const tmdbService = new TmdbService();
