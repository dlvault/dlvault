import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getSyncStatus, getLogs, runSync } from '../api/index';
import type { SyncStatus, LogEntry } from '../types/index';

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncStatus>({
    schedulerRunning: false,
    syncRunning: false,
    totalMovies: 0,
    libraryTotal: 0,
    pending: 0,
    searching: 0,
    found: 0,
    downloading: 0,
    downloaded: 0,
    notFound: 0,
    weekDelta: { added: 0, completed: 0 },
  });

  const logs = ref<LogEntry[]>([]);
  const syncing = ref(false);
  const loading = ref(true);
  const error = ref<string | null>(null);
  let lastFetched = 0;
  // When we last optimistically set `syncing` — see fetchAll's reconciliation.
  let lastTriggeredAt = 0;
  const TRIGGER_GRACE_MS = 10_000;

  // Newest request wins — an in-flight progress fetch answering after the
  // completion fetch put "syncRunning: true" back.
  // Separate counters: a status-only refresh (every movie:updated) must not
  // discard an in-flight fetchAll's logs.
  let statusSeq = 0;
  let allSeq = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let logTimer: ReturnType<typeof setTimeout> | null = null;

  async function fetchStatus() {
    const my = ++statusSeq;
    try {
      const res = await getSyncStatus();
      if (my !== statusSeq) return;
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
    if (now - lastFetched < 2000) {
      // Throttled — but never drop the LAST call of a burst (sync:completed
      // right after sync:progress): run it once the window has passed.
      if (!trailingTimer) {
        trailingTimer = setTimeout(() => { trailingTimer = null; fetchAll(); }, 2000 - (now - lastFetched));
      }
      return;
    }
    lastFetched = now;
    const my = ++allSeq;
    const statusAtStart = ++statusSeq;

    try {
      const [statusRes, logsRes] = await Promise.all([
        getSyncStatus(),
        getLogs(20),
      ]);
      if (my !== allSeq) return;
      // A status-only refresh started meanwhile is newer — keep its status.
      if (statusAtStart === statusSeq) status.value = statusRes.data;
      logs.value = logsRes.data;
      error.value = null;
      // Reconcile the local flag with the server's truth. `syncing` was only
      // ever cleared by the SSE `sync:completed` event, so if the stream dropped
      // mid-sync (a routine proxy recycle) the event was lost and the button
      // stayed disabled on "Sync läuft..." until a full page reload.
      //
      // The grace window covers the gap between our optimistic `syncing = true`
      // and the server actually reporting the run, so a poll landing in between
      // doesn't clear the flag we just set.
      if (Date.now() - lastTriggeredAt > TRIGGER_GRACE_MS) {
        syncing.value = !!status.value.syncRunning;
      }
    } catch {
      error.value = 'Sync-Daten konnten nicht geladen werden';
    } finally {
      loading.value = false;
    }
  }

  async function triggerSync(): Promise<{ ok: boolean; error?: string }> {
    if (syncing.value) return { ok: false, error: 'Sync läuft bereits' };
    syncing.value = true;
    lastTriggeredAt = Date.now();
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

  // One refetch per burst — an import writes several log lines at once.
  function onLogCreated() {
    if (logTimer) return;
    logTimer = setTimeout(() => { logTimer = null; fetchLogs(20); }, 1000);
  }

  return {
    status, logs, syncing, loading, error,
    fetchAll, fetchStatus, fetchLogs, triggerSync,
    onSyncStarted, onSyncCompleted, onSyncProgress, onMovieUpdated, onLogCreated,
  };
});
