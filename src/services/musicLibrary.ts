/**
 * Music library reader — surfaces the album collection from the configured
 * media server (currently Jellyfin) for the Mediathek "Musik" tab.
 *
 * Kept SEPARATE from the movie/series LibraryProvider (which is video-shaped:
 * per-episode files, video quality, imdb ids). Music is a different model
 * (albums → tracks), so this is a parallel, lightweight reader that reuses the
 * same Jellyfin connection settings and the existing `/api/library/:id/poster`
 * image proxy for covers.
 */
import axios from 'axios';
import { getSetting } from '../database/index';
import { logger } from '../utils/logger';
import { getLibraryProviderType } from './libraryProvider';

export interface MusicAlbum {
  id: string;
  title: string;
  artist: string | null;
  year: number | null;
  /** Jellyfin Primary image hash — feeds the /api/library/:id/poster proxy. */
  imageTag: string | null;
  addedAt: string | null;
  trackCount: number | null;
}

export interface MusicAlbumTrack {
  id: string;
  title: string;
  /** 1-based track number within its disc. */
  track: number | null;
  disc: number | null;
  durationSec: number | null;
}

let cachedUserId: string | null = null;
let cache: { albums: MusicAlbum[]; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Drop the album cache. Called when a download finishes: otherwise the
 * Mediathek's Musik tab kept serving the pre-download snapshot for up to five
 * more minutes, with no refresh control in the UI to force it.
 */
export function invalidateMusicLibraryCache(): void {
  cache = null;
}

function jellyfinUrl(): string {
  return (getSetting('jellyfin.url') || '').replace(/\/+$/, '');
}
function jellyfinApiKey(): string {
  return getSetting('jellyfin.api_key') || '';
}

/** True when the current provider is Jellyfin and configured. Plex TODO. */
export function isMusicLibraryConfigured(): boolean {
  return getLibraryProviderType() === 'jellyfin' && !!jellyfinUrl() && !!jellyfinApiKey();
}

async function getUserId(): Promise<string | null> {
  if (cachedUserId) return cachedUserId;
  try {
    const res = await axios.get(`${jellyfinUrl()}/Users`, {
      headers: { 'X-Emby-Token': jellyfinApiKey() },
      timeout: 10000,
    });
    const users = res.data || [];
    if (users.length > 0) {
      cachedUserId = (users.find((u: any) => u.Policy?.IsAdministrator) || users[0]).Id;
    }
  } catch (err: any) {
    logger.debug(`musicLibrary: could not resolve Jellyfin user: ${err?.message || err}`);
  }
  return cachedUserId;
}

/**
 * Fetch the album collection from Jellyfin. Cached for 5 min; `force` bypasses.
 * Returns [] (never throws) when unconfigured.
 */
export async function getMusicAlbums(force = false): Promise<MusicAlbum[]> {
  if (!isMusicLibraryConfigured()) return [];
  if (!force && cache && Date.now() - cache.ts < CACHE_TTL) return cache.albums;

  const userId = await getUserId();
  const endpoint = userId
    ? `${jellyfinUrl()}/Users/${userId}/Items`
    : `${jellyfinUrl()}/Items`;

  const res = await axios.get(endpoint, {
    headers: { 'X-Emby-Token': jellyfinApiKey() },
    params: {
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      Fields: 'ProductionYear,DateCreated,ChildCount,AlbumArtist,AlbumArtists',
      SortBy: 'DateCreated,SortName',
      SortOrder: 'Descending',
    },
    timeout: 30000,
  });

  const albums: MusicAlbum[] = (res.data?.Items || []).map((it: any) => ({
    id: it.Id,
    title: it.Name,
    artist: it.AlbumArtist || it.AlbumArtists?.[0]?.Name || null,
    year: it.ProductionYear || null,
    imageTag: it.ImageTags?.Primary || null,
    addedAt: it.DateCreated || null,
    trackCount: typeof it.ChildCount === 'number' ? it.ChildCount : null,
  }));

  cache = { albums, ts: Date.now() };
  return albums;
}

/** Tracks of one album, in disc/track order. Returns [] when unconfigured. */
export async function getMusicAlbumTracks(albumId: string): Promise<MusicAlbumTrack[]> {
  if (!isMusicLibraryConfigured()) return [];
  const userId = await getUserId();
  const endpoint = userId
    ? `${jellyfinUrl()}/Users/${userId}/Items`
    : `${jellyfinUrl()}/Items`;

  const res = await axios.get(endpoint, {
    headers: { 'X-Emby-Token': jellyfinApiKey() },
    params: {
      ParentId: albumId,
      IncludeItemTypes: 'Audio',
      Recursive: true,
      Fields: 'RunTimeTicks',
      SortBy: 'ParentIndexNumber,IndexNumber,SortName',
      SortOrder: 'Ascending',
    },
    timeout: 15000,
  });

  return (res.data?.Items || []).map((it: any, i: number): MusicAlbumTrack => ({
    id: it.Id,
    title: it.Name || `Track ${i + 1}`,
    track: typeof it.IndexNumber === 'number' ? it.IndexNumber : null,
    disc: typeof it.ParentIndexNumber === 'number' ? it.ParentIndexNumber : null,
    durationSec: it.RunTimeTicks ? Math.round(it.RunTimeTicks / 10_000_000) : null,
  }));
}

/**
 * Delete an album (and its files) via Jellyfin's own delete — Jellyfin owns the
 * library, so it removes the files and updates its index; we just drop our cache.
 * Requires the configured API key to belong to a user with delete rights (admin).
 */
export async function deleteMusicAlbum(albumId: string): Promise<void> {
  if (!isMusicLibraryConfigured()) throw new Error('Musik-Bibliothek nicht konfiguriert');
  // encodeURIComponent, not raw interpolation: this id comes from a route param,
  // and Express decodes `%2F` inside a segment. `../Users/<id>` would resolve
  // against the base URL and issue the DELETE against a completely different
  // Jellyfin endpoint — with the configured admin token attached.
  await axios.delete(`${jellyfinUrl()}/Items/${encodeURIComponent(albumId)}`, {
    headers: { 'X-Emby-Token': jellyfinApiKey() },
    timeout: 15000,
  });
  cache = null; // force a fresh album list on next load
}
