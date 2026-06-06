import { defineStore } from 'pinia';
import { ref } from 'vue';
import axios from 'axios';

const api = axios.create({ baseURL: '/api', timeout: 60000 });

export interface MusicTrack {
  title: string;
  artist: string;
  album?: string;
  url: string;
  cover?: string;
  kind?: 'album' | 'track' | string;
  trackCount?: number;
}

export interface MusicDownload {
  /** Server-side job id — needed to cancel a stuck download. */
  id: string;
  title: string;
  status: string;
  detail?: string;
  /** Why it failed. Without this the UI showed the last progress line instead. */
  error?: string;
  progress?: number;
  /** Live download rate in bytes/sec, when the plugin measures it. */
  speedBps?: number;
  artist?: string;
  cover?: string;
  tracksTotal?: number;
  tracksDone?: number;
  currentTrack?: string;
  finishedAt?: number;
}

const SEARCH_CACHE_KEY = 'dlvault.search.v1';
function readSearchCache(): { lastQuery: string; groups: SearchGroup[] } | null {
  try { return JSON.parse(sessionStorage.getItem(SEARCH_CACHE_KEY) || 'null'); } catch { return null; }
}

export interface SearchCandidate {
  title: string;
  year?: number;
  poster?: string | null;
  url?: string;
  pluginId?: string;
  mediaType: 'movie' | 'show' | 'music';
  kind?: string;
  count?: number;
  imdbId?: string | null;
  /**
   * Short provenance badge from the plugin — for a source that queries several
   * back-ends, which one produced this hit. Purely decorative.
   */
  label?: string;
}

export interface SearchGroup {
  mediaType: 'movie' | 'show' | 'music';
  results: SearchCandidate[];
}

/**
 * Music store. Talks to whichever installed plugin handles the `music` media
 * type via the neutral plugin API (/api/plugins/:id/search + /:id/fetch) — the
 * source id is discovered at runtime, never hardcoded here.
 */
export const useMusicStore = defineStore('music', () => {
  const searchResults = ref<MusicTrack[]>([]);
  const searching = ref(false);
  const searchError = ref<string | null>(null);
  const downloads = ref<MusicDownload[]>([]);
  const pluginId = ref<string | null>(null);
  const pluginChecked = ref(false);
  // Monotonic token so a slow search response can't overwrite a newer one.
  let searchSeq = 0;
  // Restore the last search from sessionStorage so it survives a full page
  // reload (F5), not just in-app navigation.
  const _cache = readSearchCache();
  const groups = ref<SearchGroup[]>(_cache?.groups || []);
  const searchQuery = ref(_cache?.lastQuery || '');
  const lastQuery = ref(_cache?.lastQuery || '');
  const trending = ref<SearchCandidate[]>([]);

  /**
   * Resolve the installed music plugin's id, once per page load.
   *
   * The `pluginChecked` flag matters as much as the cached id: caching only a
   * SUCCESSFUL lookup meant an instance with no music plugin — the default,
   * since dlvault ships none — re-requested /api/plugins on every poll tick,
   * i.e. every 4 seconds for as long as the Downloads page stayed open.
   */
  async function ensurePlugin(): Promise<string | null> {
    if (pluginChecked.value) return pluginId.value;
    try {
      const res = await api.get('/plugins');
      const music = (res.data.registered || []).find(
        (p: any) => Array.isArray(p.mediaTypes) && p.mediaTypes.includes('music'),
      );
      pluginId.value = music?.id ?? null;
      pluginChecked.value = true;
    } catch {
      // Leave `pluginChecked` false so a transient failure is retried, but don't
      // cache a null id as if we had an answer.
      pluginId.value = null;
    }
    return pluginId.value;
  }

  /** True once /api/plugins answered — including "no music plugin installed". */
  function hasMusicPlugin(): boolean {
    return pluginChecked.value && !!pluginId.value;
  }

  async function search(query: string) {
    // Same sequencing rule as unifiedSearch — a slow plugin response must not
    // land on top of a newer query's results.
    const seq = ++searchSeq;
    searching.value = true;
    searchError.value = null;
    try {
      const id = await ensurePlugin();
      if (!id) throw new Error('Kein Musik-Plugin installiert');
      const res = await api.get(`/plugins/${id}/search`, { params: { q: query } });
      if (seq !== searchSeq) return;
      searchResults.value = (res.data.results || []).map((r: any) => ({
        title: r.title,
        artist: '',
        url: r.url,
        cover: r.poster || r.cover || undefined,
        kind: r.kind,
        trackCount: r.count,
      }));
    } catch (e: any) {
      if (seq !== searchSeq) return;
      searchError.value = e?.response?.data?.error || e?.message || 'Suche fehlgeschlagen';
      searchResults.value = [];
    } finally {
      if (seq === searchSeq) searching.value = false;
    }
  }

  /** Load the active/recent download list from the server (survives reloads). */
  async function loadDownloads() {
    const id = await ensurePlugin();
    if (!id) return;
    try {
      const res = await api.get('/plugins/fetch-jobs', { params: { pluginId: id } });
      downloads.value = (res.data.jobs || []).map((j: any) => ({
        id: j.id,
        title: j.title,
        status: j.status === 'done' ? 'completed' : j.status,
        detail: j.detail,
        error: j.error,
        // Plugin reports 0..1 ratio; the UI thinks in percent.
        progress: typeof j.progress === 'number' ? j.progress * 100 : undefined,
        speedBps: j.speedBps,
        artist: j.artist,
        cover: j.cover,
        tracksTotal: j.tracksTotal,
        tracksDone: j.tracksDone,
        currentTrack: j.currentTrack,
        finishedAt: j.finishedAt,
      }));
    } catch { /* keep current list */ }
  }

  async function download(track: MusicTrack) {
    const id = await ensurePlugin();
    if (!id) return { error: 'Kein Musik-Plugin installiert' };
    try {
      const res = await api.post(`/plugins/${id}/fetch`, {
        url: track.url,
        title: track.title,
        background: true,
      });
      if (res.data?.started) await loadDownloads();
      return res.data;
    } catch (e: any) {
      return { error: e?.response?.data?.error || 'Download fehlgeschlagen' };
    }
  }

  /** Give up on a job the server can no longer finish. */
  async function cancelDownload(jobId: string) {
    try {
      await api.delete(`/plugins/fetch-jobs/${jobId}`);
    } catch { /* the reload below reflects whatever actually happened */ }
    await loadDownloads();
  }

  /**
   * Unified search across all media types/plugins (movies, shows, music).
   *
   * Sequenced: a music plugin's cold path can take tens of seconds (challenge
   * solve) while a second, faster search returns first. Without the token check
   * the slow response overwrote the newer results — and wrote the mismatched
   * pair into sessionStorage, so the wrong pairing even survived an F5.
   */
  async function unifiedSearch(query: string) {
    const seq = ++searchSeq;
    searching.value = true;
    searchError.value = null;
    lastQuery.value = query;
    try {
      const res = await api.get('/search/all', { params: { q: query } });
      if (seq !== searchSeq) return;
      groups.value = res.data.groups || [];
      try {
        sessionStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify({ lastQuery: query, groups: groups.value }));
      } catch { /* storage full / disabled — cache is best-effort */ }
    } catch (e: any) {
      if (seq !== searchSeq) return;
      searchError.value = e?.response?.data?.error || e?.message || 'Suche fehlgeschlagen';
      groups.value = [];
    } finally {
      if (seq === searchSeq) searching.value = false;
    }
  }

  /** Add a movie/show candidate to dlvault (triggers download + watchlist sync). */
  async function addMovie(c: SearchCandidate) {
    try {
      const res = await api.post('/movies/manual-add', {
        title: c.title,
        year: c.year,
        imdbId: c.imdbId || undefined,
        mediaType: c.mediaType,
      });
      return res.data;
    } catch (e: any) {
      return { error: e?.response?.data?.error || 'Hinzufügen fehlgeschlagen' };
    }
  }

  /** Download a music candidate (album = all tracks, track = single). */
  async function downloadCandidate(c: SearchCandidate) {
    return download({ title: c.title, artist: '', url: c.url || '' });
  }

  /**
   * Hand a pasted streaming link straight to the music plugin.
   *
   * The source resolves foreign links itself (a Spotify/Tidal album or playlist
   * URL is its normal input), so nothing needs to be searched first — the
   * server-side fetch endpoint already accepts a bare url. The title is unknown
   * until the source resolves it; send the link as the provisional label.
   */
  async function downloadLink(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return { error: 'Kein Link angegeben' };
    return download({ title: trimmed, artist: '', url: trimmed });
  }

  /** "Beliebt diese Woche" from Trakt trending — for the search page shelf. */
  async function loadTrending() {
    if (trending.value.length) return;
    try {
      const res = await api.get('/search/trending');
      trending.value = res.data.items || [];
    } catch {
      trending.value = [];
    }
  }

  function clearSearch() {
    searchResults.value = [];
    groups.value = [];
    searchQuery.value = '';
    lastQuery.value = '';
    searchError.value = null;
    try { sessionStorage.removeItem(SEARCH_CACHE_KEY); } catch { /* ignore */ }
  }

  return {
    searchResults, searching, searchError, downloads, pluginId, groups, searchQuery, lastQuery, trending,
    pluginChecked, hasMusicPlugin,
    search, download, downloadLink, loadDownloads, cancelDownload, unifiedSearch, addMovie, downloadCandidate, loadTrending, clearSearch,
  };
});
