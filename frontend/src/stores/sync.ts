import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getSyncStatus, getLogs, runSync } from '../api/index';
import type { SyncStatus, LogEntry } from '../types/index';

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncStatus>({
    schedulerRunning: false,
    syncRunning: false,
    totalMovies: 0,
    pending: 0,
    searching: 0,
    found: 0,
    downloading: 0,
    downloaded: 0,
    notFound: 0,
  });

  const logs = ref<LogEntry[]>([]);
  const syncing = ref(false);
  const loading = ref(true);
  const error = ref<string | null>(null);
  let lastFetched = 0;

  async function fetchStatus() {
    try {
      const res = await getSyncStatus();
      status.value = res.data;
      error.value = null;
    } catch {
      error.value = 'Sync-Status konnte nicht geladen werden';
    }
  }

  async function fetchLogs(limit = 20) {
    try {
      const res = await getLogs(limit);
      logs.value = res.data;
    } catch {
      error.value = 'Logs konnten nicht geladen werden';
    }
  }

  async function fetchAll() {
    const now = Date.now();
    if (now - lastFetched < 2000) return;
    lastFetched = now;

    try {
      const [statusRes, logsRes] = await Promise.all([
        getSyncStatus(),
        getLogs(20),
      ]);
      status.value = statusRes.data;
      logs.value = logsRes.data;
      error.value = null;
    } catch {
      error.value = 'Sync-Daten konnten nicht geladen werden';
    } finally {
      loading.value = false;
    }
  }

  async function triggerSync(): Promise<{ ok: boolean; error?: string }> {
    if (syncing.value) return { ok: false, error: 'Sync laeuft bereits' };
    syncing.value = true;
    try {
      const res = await runSync();
      return { ok: true };
    } catch (e: unknown) {
      syncing.value = false;
      const axiosErr = e as { response?: { data?: { error?: string }; status?: number } };
      const msg = axiosErr.response?.data?.error
        || (axiosErr.response?.status === 429 ? 'Zu viele Anfragen - bitte kurz warten' : 'Sync fehlgeschlagen');
      return { ok: false, error: msg };
    }
  }

  // SSE handlers
  function onSyncStarted() {
    status.value.syncRunning = true;
    syncing.value = true;
  }

  function onSyncCompleted() {
    status.value.syncRunning = false;
    syncing.value = false;
    fetchAll();
  }

  function onSyncProgress() {
    fetchAll();
  }

  function onMovieUpdated() {
    fetchStatus();
  }

  function onLogCreated() {
    fetchLogs(20);
  }

  return {
    status, logs, syncing, loading, error,
    fetchAll, fetchStatus, fetchLogs, triggerSync,
    onSyncStarted, onSyncCompleted, onSyncProgress, onMovieUpdated, onLogCreated,
  };
});
