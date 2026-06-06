import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { checkForUpdate, getUpdateState, startUpdate, updateStreamUrl } from '../api';

export type UpdateState = 'idle' | 'running' | 'done' | 'error';

/** Keep the in-memory update log bounded — it is a live tail, not an archive. */
const MAX_LOG_LINES = 200;

/**
 * One-click GHCR self-update: version badge data, the "new version" banner flag,
 * and the whole run (start → SSE phase/log stream → done/error/rollback).
 *
 * Registers its own onMounted/onBeforeUnmount, so call it from setup() and just
 * bind the returned state. State is per-instance on purpose: only the dashboard
 * hosts the updater, and a second instance would open a second EventSource.
 */
export function useAppUpdate() {
  // ── Version badge + banner ──────────────────────────────────
  const updateAvailable = ref(false);
  const showUpdateModal = ref(false);
  const commitHash = ref<string>('');
  const appVersion = ref<string>('');

  const shortCommit = computed(() => {
    const hash = commitHash.value;
    if (!hash) return '';
    if (/^v\d/.test(hash)) return hash;
    return hash.slice(0, 7);
  });

  // Prefer the human-facing version ("v0.3.0") in the badge, with the exact build
  // commit kept in the tooltip. Falls back to the short commit until the version
  // arrives (or in dev where there's no published version).
  const versionLabel = computed(() => (appVersion.value ? `v${appVersion.value}` : shortCommit.value));

  // ── Run state ───────────────────────────────────────────────
  const updateState = ref<UpdateState>('idle');
  const currentPhase = ref<string>('');
  const logLines = ref<string[]>([]);
  const errorMessage = ref<string>('');
  const reconnecting = ref(false);
  const canStartUpdate = ref(false);
  const updateBlockedReason = ref<string>('');

  // ── SSE stream ──────────────────────────────────────────────
  let eventSource: EventSource | null = null;
  let reconnectTimer: number | null = null;

  function closeUpdateStream() {
    if (eventSource) { eventSource.close(); eventSource = null; }
    if (reconnectTimer) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function appendLog(line: string) {
    // Replace the array instead of mutating it so consumers can autoscroll on a
    // plain identity watch — a push+trim at the cap leaves .length unchanged.
    const next = logLines.value.concat(line);
    logLines.value = next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
  }

  function attachStream() {
    closeUpdateStream();
    reconnecting.value = false;
    const src = new EventSource(updateStreamUrl());
    src.addEventListener('connected', () => { reconnecting.value = false; });
    src.addEventListener('phase', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { phase: string; line?: string };
        const ph = data.phase || '';
        if (ph.startsWith('error:')) {
          errorMessage.value = ph.slice('error:'.length).replace(/_/g, ' ');
          updateState.value = 'error';
          closeUpdateStream();
          return;
        }
        if (ph === 'done') {
          currentPhase.value = 'done';
          updateState.value = 'done';
          closeUpdateStream();
          return;
        }
        currentPhase.value = ph;
        if (data.line) appendLog(data.line);
      } catch { /* ignore */ }
    });
    src.addEventListener('log', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { line: string };
        if (data.line) appendLog(data.line);
      } catch { /* ignore */ }
    });
    src.onerror = () => {
      if (updateState.value === 'running' || updateState.value === 'idle') {
        reconnecting.value = true;
        if (!reconnectTimer) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            if (updateState.value === 'running') attachStream();
          }, 2000);
        }
      }
    };
    eventSource = src;
  }

  // ── Actions ─────────────────────────────────────────────────
  async function refreshUpdateBlockState() {
    try {
      const { data } = await getUpdateState();
      canStartUpdate.value = !!data.canStart;
      if (!data.hostPathsConfigured) {
        updateBlockedReason.value = 'HOST_DATA_DIR-Umgebungsvariable fehlt — bitte beim Container-Start setzen (siehe README).';
      } else if (data.socketReachable === false) {
        updateBlockedReason.value = '/var/run/docker.sock ist nicht in den Container gemountet — Bind-Mount im Container-Template hinzufügen.';
      } else if (data.running) {
        updateBlockedReason.value = 'Ein Update läuft bereits.';
        updateState.value = 'running';
        attachStream();
      } else {
        updateBlockedReason.value = '';
      }
    } catch {
      updateBlockedReason.value = 'Status nicht abrufbar.';
      canStartUpdate.value = false;
    }
  }

  async function beginUpdate() {
    logLines.value = [];
    errorMessage.value = '';
    currentPhase.value = 'pulling';
    updateState.value = 'running';
    try {
      await startUpdate();
      attachStream();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string; hint?: string } } };
      errorMessage.value = e.response?.data?.error || 'start_failed';
      if (e.response?.data?.hint) appendLog(e.response.data.hint);
      updateState.value = 'error';
    }
  }

  function openUpdateModal() {
    showUpdateModal.value = true;
  }

  function closeUpdateModal() {
    if (updateState.value === 'running') {
      showUpdateModal.value = false;
      return;
    }
    closeUpdateStream();
    showUpdateModal.value = false;
    setTimeout(() => {
      if (!showUpdateModal.value) {
        updateState.value = 'idle';
        currentPhase.value = '';
        logLines.value = [];
        errorMessage.value = '';
      }
    }, 300);
  }

  function reloadPage() { window.location.reload(); }

  watch(showUpdateModal, (open) => {
    if (open && updateState.value === 'idle') refreshUpdateBlockState();
  });

  onMounted(() => {
    checkForUpdate().then(({ data }) => {
      if (data.updateAvailable) updateAvailable.value = true;
      if (data.current && data.current !== 'dev') commitHash.value = data.current;
      if (data.version && data.version !== 'dev') appVersion.value = data.version;
    }).catch(() => {});

    getUpdateState().then(({ data }) => {
      if (data.running) {
        updateState.value = 'running';
        showUpdateModal.value = true;
        attachStream();
      }
    }).catch(() => {});
  });

  onBeforeUnmount(closeUpdateStream);

  return {
    // version badge
    commitHash, versionLabel,
    // banner
    updateAvailable,
    // modal
    showUpdateModal, openUpdateModal, closeUpdateModal,
    updateState, currentPhase, logLines, errorMessage, reconnecting,
    canStartUpdate, updateBlockedReason,
    beginUpdate, reloadPage,
  };
}
