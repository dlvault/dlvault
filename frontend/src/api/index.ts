import axios from 'axios';
import { ref } from 'vue';
import type { MovieDetail } from '../types/index';

export const serverReachable = ref(true);
let unreachableSince = 0;

const api = axios.create({
  baseURL: '/api',
  timeout: 300000, // 5 min — plugin-driven search (link resolution, captcha solving) can take a while
});

// Global response interceptor — detect server unreachable
api.interceptors.response.use(
  (response) => {
    if (!serverReachable.value) {
      serverReachable.value = true;
      unreachableSince = 0;
    }
    return response;
  },
  (error) => {
    if (!error.response) {
      // Network error — server unreachable
      if (serverReachable.value) unreachableSince = Date.now();
      serverReachable.value = false;
    }
    return Promise.reject(error);
  },
);

// Settings
export const getSettings = () => api.get('/settings');
export const updateSettings = (data: Record<string, string>) => api.put('/settings', data);
export const validatePaths = () => api.post('/settings/validate-paths');
export const getTraktAuthUrl = () => api.get('/settings/trakt/auth-url');
export const exchangeTraktCode = (code: string) => api.post('/settings/trakt/exchange', { code });
export const getTraktStatus = () => api.get('/settings/trakt/status');
export const getJDownloaderStatus = () => api.get('/settings/jdownloader/status');
export const testJDownloader = () => api.post('/settings/jdownloader/test');
export const getPlexStatus = () => api.get('/settings/plex/status');
export const testPlex = () => api.post('/settings/plex/test');
export const getPlexAuthPin = () => api.post('/settings/plex/auth-pin');
export const checkPlexAuthPin = (pinId: number) => api.post('/settings/plex/auth-check', { pinId });
export const getJellyfinStatus = () => api.get('/settings/jellyfin/status');
export const testJellyfin = () => api.post('/settings/jellyfin/test');
export const getPlexLibraryStatus = () => api.get('/settings/plex-library/status');
export const testPlexLibrary = () => api.post('/settings/plex-library/test');

// Movies
export const getMovies = () => api.get('/movies');
export const getMovie = (id: number) => api.get<MovieDetail>(`/movies/${id}`);
export const deleteMovie = (id: number) => api.delete(`/movies/${id}`);
export const retryMovie = (id: number) => api.post(`/movies/${id}/retry`);

// Sync
export const runSync = () => api.post('/sync/run');
export const getSyncStatus = () => api.get('/sync/status');
export const getLogs = (limit?: number) => api.get('/sync/logs', { params: { limit } });

// JDownloader Downloads
export const getJDPackages = () => api.get('/downloads/packages');
export const getJDLinks = () => api.get('/downloads/links');
export const getJDLinkGrabber = () => api.get('/downloads/linkgrabber');
export const startJDDownloads = () => api.post('/downloads/start');
export const stopJDDownloads = () => api.post('/downloads/stop');
export const pauseJDDownloads = (pause: boolean) => api.post('/downloads/pause', { pause });
export const removeJDPackages = (ids: number[]) => api.delete(`/downloads/packages/${ids.join(',')}`);
export const removeJDLinkGrabberPackages = (ids: number[]) => api.delete(`/downloads/linkgrabber/${ids.join(',')}`);
export const moveJDLinkGrabberToDownloads = (ids: number[]) => api.post('/downloads/linkgrabber/move', { ids });
export const getJDSpeedLimit = () => api.get('/downloads/speed-limit');
export const setJDSpeedLimit = (data: { enabled?: boolean; limitKbps?: number }) => api.post('/downloads/speed-limit', data);

// Search
export const searchReleases = (data: { query: string; year?: number; mediaType?: string }) => api.post('/search', data);
export const downloadRelease = (data: { title: string; year?: number; mediaType?: string; tmdbId?: number; imdbId?: string; releaseIndex?: number; links: { hoster: string; url: string }[] }) => api.post('/search/download', data);

// Library
export const getLibrary = (type?: string) => api.get('/library', { params: { type } });
export const deleteLibraryItem = (id: string) => api.delete(`/library/${id}`);

// Blocklist
export const getBlocklist = () => api.get('/blocklist');
export const addToBlocklist = (data: { release_name: string; title?: string; reason?: string; movie_id?: number }) => api.post('/blocklist', data);
export const removeFromBlocklist = (id: number) => api.delete(`/blocklist/${id}`);
export const clearBlocklist = () => api.delete('/blocklist');

// Health (detailed)
export const getHealthDetailed = () => api.get('/health/detailed');

// Backups
export const getBackupSettings = () => api.get('/settings/backup-schedule');
export const updateBackupSettings = (data: { enabled: string; interval_hours: string; max_backups: string }) => api.put('/settings/backup-schedule', data);
export const triggerBackup = () => api.post('/settings/backup-now');
export const getBackupList = () => api.get('/settings/backups');
export const deleteBackup = (filename: string) => api.delete(`/settings/backups/${filename}`);

// OMDb
export const testOmdb = () => api.post('/settings/omdb/test');

// Update check
export const checkForUpdate = () => api.get('/update-check');

// One-click update
export const getUpdateState = () => api.get('/update/state');
export const startUpdate = () => api.post('/update/start', null, { headers: { 'X-Confirm-Update': 'yes' } });
export const updateStreamUrl = () => '/api/update/stream';

// SSE Events
// Plugins
export type PluginPermission = 'secrets' | 'filesystem';
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  mediaTypes: ('movie' | 'show')[];
  description?: string;
  author?: string;
  homepage?: string;
  cspDomains?: string[];
  minHostVersion?: string;
  permissions?: PluginPermission[];
  settingsSchema?: PluginSettingField[];
  requiredSecrets?: RequiredSecret[];
}
export interface PluginSettingField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'secret' | 'multi-select';
  options?: string[];
  default?: string;
  description?: string;
}
export interface RequiredSecret {
  key: string;
  label: string;
  description?: string;
}
export interface RegisteredPlugin {
  id: string;
  name: string;
  mediaTypes: ('movie' | 'show')[];
  cspDomains: string[];
  bundled: boolean;
  enabled: boolean;
  // Manifest fields (optional — plugins registered without a manifest omit these)
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  permissions?: PluginPermission[];
  settingsSchema?: PluginSettingField[];
  requiredSecrets?: RequiredSecret[];
}
export interface PendingPlugin extends PluginManifest {
  fileSha256: string;
  reason: 'no-disclaimer' | 'sha-mismatch';
}
export interface AggregatedSecret {
  key: string;
  label: string;
  description?: string;
  requestedBy: { id: string; name: string }[];
  configured: boolean;
}
export const listPlugins = () => api.get<{ registered: RegisteredPlugin[]; pending: PendingPlugin[] }>('/plugins');
export const listPluginSecrets = () => api.get<{ secrets: AggregatedSecret[] }>('/plugins/secrets');
export const previewPluginFromUrl = (url: string) =>
  api.post<{ manifest: PluginManifest; fileSha256: string }>('/plugins/preview', { url });
export const previewPluginFromUpload = (contentBase64: string) =>
  api.post<{ manifest: PluginManifest; fileSha256: string }>('/plugins/preview', { contentBase64 });
export const installPluginFromUrl = (url: string, disclaimerAccepted: boolean) =>
  api.post<{ success: boolean; manifest: PluginManifest; fileSha256: string }>('/plugins/install', { url, disclaimerAccepted });
export const installPluginFromUpload = (filename: string, contentBase64: string, disclaimerAccepted: boolean) =>
  api.post<{ success: boolean; manifest: PluginManifest; fileSha256: string }>('/plugins/upload', { filename, contentBase64, disclaimerAccepted });
export const acceptPendingPlugin = (id: string, disclaimerAccepted: boolean) =>
  api.post<{ success: boolean; manifest: PluginManifest }>(`/plugins/${id}/accept`, { disclaimerAccepted });
export const enablePlugin = (id: string) => api.post(`/plugins/${id}/enable`);
export const disablePlugin = (id: string) => api.post(`/plugins/${id}/disable`);
export const uninstallPlugin = (id: string) => api.delete(`/plugins/${id}`);

export function subscribeToEvents(onEvent: (event: string, data: unknown) => void): EventSource {
  const source = new EventSource('/api/events');
  source.onmessage = (e) => {
    const { event, data } = JSON.parse(e.data);
    onEvent(event, data);
  };
  return source;
}

export default api;
