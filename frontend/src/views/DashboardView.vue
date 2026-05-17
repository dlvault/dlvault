<template>
  <div>
    <!-- Update banner -->
    <Transition name="slide-down">
      <div v-if="updateAvailable" class="update-banner">
        <span><Package :size="16" /> <strong>Neue Version verfügbar!</strong></span>
        <button class="btn update-btn" @click="showUpdateModal = true">Aktualisieren</button>
      </div>
    </Transition>

    <!-- Update modal -->
    <Transition name="wizard-fade">
      <div v-if="showUpdateModal" class="update-overlay" @click.self="closeUpdateModal">
        <div class="update-modal">
          <h3 v-if="updateState === 'idle'">Update verfuegbar</h3>
          <h3 v-else-if="updateState === 'running'">Update laeuft...</h3>
          <h3 v-else-if="updateState === 'done'">Update erfolgreich</h3>
          <h3 v-else>Update fehlgeschlagen</h3>

          <!-- IDLE: confirm + start (one-click path) -->
          <template v-if="updateState === 'idle' && canStartUpdate">
            <p class="update-steps">
              Der Updater holt den neuesten Code, baut ein neues Docker-Image und startet den Container automatisch neu.
              Konfiguration und Datenbank bleiben erhalten. Dauert ca. 2-5 Minuten.
            </p>
            <div class="update-modal-footer">
              <button class="btn btn-secondary" @click="closeUpdateModal">Abbrechen</button>
              <button class="btn btn-primary update-btn" @click="beginUpdate">
                Jetzt aktualisieren
              </button>
            </div>
          </template>

          <!-- IDLE: fallback to copy-command (updater not bootstrapped yet) -->
          <template v-else-if="updateState === 'idle'">
            <p v-if="updateBlockedReason" class="update-error">
              {{ updateBlockedReason }}
            </p>
            <p class="text-secondary">
              Fuehre einmalig folgenden Befehl aus, um den Updater zu installieren — danach klappt der One-Click-Button.
            </p>
            <div class="update-command-box">
              <code>{{ fallbackCommand }}</code>
              <button class="btn btn-sm update-copy-btn" @click="copyCommand(fallbackCommand)">
                {{ copied ? 'Kopiert!' : 'Kopieren' }}
              </button>
            </div>
            <div class="update-modal-footer">
              <button class="btn btn-secondary" @click="closeUpdateModal">Schliessen</button>
            </div>
          </template>

          <!-- RUNNING/DONE/ERROR: phase stepper + log -->
          <template v-else>
            <div class="phase-stepper">
              <div v-for="step in phaseSteps" :key="step.key"
                   class="phase-step"
                   :class="{
                     active: step.key === currentPhase,
                     done: phaseStepDone(step.key),
                     error: updateState === 'error' && step.key === currentPhase,
                   }">
                <span class="phase-dot"></span>
                <span class="phase-label">{{ step.label }}</span>
              </div>
            </div>

            <div class="update-log" ref="logBox">
              <div v-for="(line, i) in logLines" :key="i" class="log-line">{{ line }}</div>
              <div v-if="reconnecting" class="log-line reconnect">… Verbindung zum Container verloren — versuche erneut …</div>
            </div>

            <p v-if="updateState === 'error'" class="update-error">
              Fehler: {{ errorMessage }}. Der vorherige Container wurde wiederhergestellt.
            </p>

            <div class="update-modal-footer">
              <button v-if="updateState === 'running'" class="btn btn-secondary" disabled>
                Bitte warten...
              </button>
              <button v-else-if="updateState === 'done'" class="btn btn-primary" @click="reloadPage">
                Seite neu laden
              </button>
              <button v-else class="btn btn-secondary" @click="closeUpdateModal">Schliessen</button>
            </div>
          </template>
        </div>
      </div>
    </Transition>

    <div class="section-header">
      <h2>
        Dashboard
        <span v-if="commitHash" class="version-badge" :title="`Build ${commitHash}`">v {{ commitHash }}</span>
      </h2>
      <div class="flex-row">
        <button class="btn btn-primary" @click="triggerSync" :disabled="syncStore.syncing" aria-label="Jetzt synchronisieren">
          <LoadingSpinner v-if="syncStore.syncing" inline />
          {{ syncStore.syncing ? 'Sync läuft...' : 'Jetzt synchronisieren' }}
        </button>
      </div>
    </div>

    <!-- Setup hint for first-time users -->
    <div v-if="!syncStore.loading && syncStore.status.totalMovies === 0 && !syncStore.status.schedulerRunning" class="alert alert-info flex-row flex-gap-lg">
      <span class="welcome-icon" aria-hidden="true"><Sparkles :size="20" /></span>
      <div>
        <strong>Willkommen bei <em class="welcome-italic">dlvault</em></strong><br />
        Konfiguriere zuerst Trakt/Plex, JDownloader und Jellyfin in den
        <router-link to="/settings" class="link-accent" style="font-weight: 600;">Einstellungen</router-link>,
        dann starte den ersten Sync.
      </div>
    </div>

    <SkeletonLoader v-if="syncStore.loading" variant="stats" :count="6" />
    <div v-else class="stats-grid stagger-in">
      <div class="stat-card stat-tone-ok">
        <div class="label">Filme gesamt</div>
        <div class="value">{{ formatNumber(syncStore.status.totalMovies) }}</div>
        <div class="delta">
          <strong v-if="recentAddedDelta > 0">+{{ recentAddedDelta }}</strong>
          <span v-if="recentAddedDelta > 0">&nbsp;diese Woche</span>
          <span v-else>Watchlist · {{ syncStore.status.totalMovies }}</span>
        </div>
        <Sparkline class="sparkline" :data="sparklineAddedData" color="#4ade80" :w="64" :h="22" />
      </div>
      <div class="stat-card stat-tone-warn">
        <div class="label">Ausstehend</div>
        <div class="value">{{ syncStore.status.pending }}</div>
        <div class="delta delta-warn">
          <span v-if="oldestPendingAge">Älteste: {{ oldestPendingAge }}</span>
          <span v-else-if="syncStore.status.pending === 0">Alle aufgearbeitet</span>
          <span v-else>Warten auf Sync</span>
        </div>
      </div>
      <div class="stat-card stat-tone-busy">
        <div class="label">Wird geladen</div>
        <div class="value">{{ syncStore.status.downloading }}</div>
        <div class="delta">
          <span v-if="syncStore.status.downloading > 0">Aktiv im JDownloader</span>
          <span v-else>Keine aktiven Downloads</span>
        </div>
      </div>
      <div class="stat-card stat-tone-ok">
        <div class="label">Fertig</div>
        <div class="value">{{ formatNumber(syncStore.status.downloaded) }}</div>
        <div class="delta">
          <strong v-if="recentCompletedDelta > 0">+{{ recentCompletedDelta }}</strong>
          <span v-if="recentCompletedDelta > 0">&nbsp;diese Woche</span>
          <span v-else>In Mediathek</span>
        </div>
        <Sparkline class="sparkline" :data="sparklineCompletedData" color="#4ade80" :w="64" :h="22" />
      </div>
      <div class="stat-card stat-tone-err">
        <div class="label">Nicht gefunden</div>
        <div class="value">{{ syncStore.status.notFound }}</div>
        <div class="delta">
          <span v-if="syncStore.status.notFound > 0">Keine Quelle aktuell</span>
          <span v-else>Alles gefunden</span>
        </div>
      </div>
      <div class="stat-card" :class="syncStore.status.schedulerRunning ? 'stat-tone-ok' : 'stat-tone-err'">
        <div class="label">Scheduler</div>
        <div class="value">{{ syncStore.status.schedulerRunning ? 'Aktiv' : 'Aus' }}</div>
        <div class="delta">
          <span v-if="syncStore.status.schedulerRunning">Automatischer Sync</span>
          <span v-else>Manuell starten</span>
        </div>
      </div>
    </div>

    <!-- System Health -->
    <div v-if="health" class="health-section stagger-in">
      <div class="card">
        <h2>System Health</h2>
        <div class="health-grid">
          <div v-for="(info, key) in health.services" :key="key" class="health-item" :class="!info.configured ? 'health-na' : info.connected ? 'health-ok' : 'health-err'">
            <span class="health-dot"></span>
            <span class="health-label">{{ serviceLabels[key] || key }}</span>
            <span class="health-status">{{ !info.configured ? 'N/A' : info.connected ? 'OK' : 'Fehler' }}</span>
          </div>
        </div>

        <template v-if="health.plugins && health.plugins.length > 0">
          <h3 class="health-subtitle">Plugins</h3>
          <div class="health-grid">
            <div v-for="p in health.plugins" :key="p.id" class="health-item"
                 :class="p.ok ? 'health-ok' : p.critical ? 'health-err' : 'health-warn'">
              <span class="health-dot"></span>
              <span class="health-label">{{ p.name }}</span>
              <span class="health-status" :title="p.error || p.detail || ''">
                {{ p.ok ? 'OK' : (p.critical ? 'Fehler' : 'Warnung') }}
              </span>
            </div>
          </div>
        </template>

        <div class="disk-grid">
          <div v-for="(info, key) in health.disk" :key="key" class="disk-item">
            <div class="disk-label">{{ diskLabels[key] || key }}</div>
            <template v-if="info.totalGB">
              <div class="disk-bar">
                <div class="disk-fill" :style="{ width: info.usedPercent + '%' }" :class="(info.usedPercent ?? 0) > 90 ? 'disk-critical' : (info.usedPercent ?? 0) > 75 ? 'disk-warn' : 'disk-ok'"></div>
              </div>
              <div class="disk-meta">{{ info.freeGB }} GB frei von {{ info.totalGB }} GB ({{ info.usedPercent }}%)</div>
            </template>
            <div v-else class="disk-meta disk-error">{{ info.error || 'Nicht verfügbar' }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Blocklist -->
    <div class="card blocklist-section stagger-in">
      <div class="activity-header">
        <h2>Blocklist <span v-if="blocklist.length" class="badge badge-secondary">{{ blocklist.length }}</span></h2>
        <button v-if="blocklist.length" class="activity-link" style="cursor:pointer; background:none; border:none; font-size:var(--fs-sm); color:var(--accent); font-weight:500;" @click="showBlocklist = !showBlocklist">
          {{ showBlocklist ? 'Ausblenden' : 'Anzeigen' }}
        </button>
      </div>
      <Transition name="slide-down">
        <div v-if="showBlocklist && blocklist.length > 0">
          <div v-for="entry in blocklist" :key="entry.id" class="blocklist-item">
            <div class="blocklist-info">
              <span class="blocklist-release">{{ entry.release_name }}</span>
              <span v-if="entry.reason" class="blocklist-reason">{{ entry.reason }}</span>
            </div>
            <button class="btn btn-danger btn-sm" @click="removeBlocklistItem(entry.id)" title="Entfernen">&times;</button>
          </div>
        </div>
      </Transition>
      <p v-if="blocklist.length === 0" class="text-secondary" style="font-size:0.85rem;">Keine blockierten Releases.</p>
    </div>

    <SkeletonLoader v-if="syncStore.loading" variant="table" :count="5" />
    <div v-else class="card">
      <div class="activity-header">
        <h2>Letzte Aktivitäten</h2>
        <router-link v-if="syncStore.logs.length > 0" to="/logs" class="activity-link">Alle anzeigen</router-link>
      </div>

      <!-- Desktop: Compact table -->
      <table v-if="recentLogs.length > 0" class="activity-table">
        <thead>
          <tr>
            <th>Zeit</th>
            <th>Aktion</th>
            <th>Film</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in recentLogs" :key="log.id">
            <td class="activity-time" :title="log.created_at">{{ timeAgo(log.created_at) }}</td>
            <td>
              <span :class="'badge badge-' + actionColor(log.action)">
                {{ formatAction(log.action) }}
              </span>
            </td>
            <td class="activity-title">{{ log.movie_title || '-' }}</td>
            <td class="activity-details" :title="log.details">{{ log.details }}</td>
          </tr>
        </tbody>
      </table>

      <!-- Mobile: Compact card list -->
      <div v-if="recentLogs.length > 0" class="activity-cards">
        <div v-for="log in recentLogs" :key="'m-' + log.id" class="activity-card">
          <div class="activity-card-top">
            <span :class="'badge badge-' + actionColor(log.action)">{{ formatAction(log.action) }}</span>
            <span class="activity-card-time">{{ timeAgo(log.created_at) }}</span>
          </div>
          <div v-if="log.movie_title" class="activity-card-title">{{ log.movie_title }}</div>
          <div v-if="log.details" class="activity-card-details">{{ log.details }}</div>
        </div>
      </div>

      <EmptyState
        v-else
        icon="Inbox"
        title="Noch keine Aktivitäten"
        description="Konfiguriere zuerst deine Einstellungen und starte einen Sync."
        action-to="/settings"
        action-label="Einstellungen"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useSyncStore } from '../stores/sync';
import { useToast } from '../composables/useApp';
import { useMoviesStore } from '../stores/movies';
import { timeAgo, formatAction, actionColor } from '../composables/useFormatters';
import { checkForUpdate, getHealthDetailed, getBlocklist, removeFromBlocklist, getUpdateState, startUpdate, updateStreamUrl } from '../api';
import { nextTick, onBeforeUnmount, watch } from 'vue';
import LoadingSpinner from '../components/LoadingSpinner.vue';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import EmptyState from '../components/EmptyState.vue';
import Sparkline from '../components/Sparkline.vue';
import { Package, Sparkles } from 'lucide-vue-next';

const syncStore = useSyncStore();
const moviesStore = useMoviesStore();
const toast = useToast();
const recentLogs = computed(() => syncStore.logs.slice(0, 10));

function formatNumber(n: number | undefined): string {
  if (!n) return '0';
  return n.toLocaleString('de-DE');
}

// Buckets logs into 7 daily counts for the supplied action set, returning a sparkline path on a 64×22 viewport.
function bucketLast7Days(actions: string[]): number[] {
  const buckets = new Array(7).fill(0);
  const now = Date.now();
  const dayMs = 86_400_000;
  for (const log of syncStore.logs) {
    if (!actions.includes(log.action)) continue;
    const t = new Date(log.created_at + 'Z').getTime();
    const dayDiff = Math.floor((now - t) / dayMs);
    if (dayDiff >= 0 && dayDiff < 7) {
      buckets[6 - dayDiff]++;
    }
  }
  return buckets;
}

const sparklineAddedData = computed(() => bucketLast7Days(['movie_added', 'watchlist_sync']));
const sparklineCompletedData = computed(() => bucketLast7Days(['sent_to_jdownloader', 'release_found']));

const recentAddedDelta = computed(() => sparklineAddedData.value.reduce((a, b) => a + b, 0));
const recentCompletedDelta = computed(() => sparklineCompletedData.value.reduce((a, b) => a + b, 0));

const oldestPendingAge = computed(() => {
  const items = moviesStore.movies.filter(m => m.status === 'pending');
  if (items.length === 0) return '';
  let oldest = items[0];
  for (const m of items) {
    const a = m.created_at || m.last_checked_at || '';
    const b = oldest.created_at || oldest.last_checked_at || '';
    if (a && (!b || a < b)) oldest = m;
  }
  const ts = oldest.created_at || oldest.last_checked_at;
  return ts ? timeAgo(ts) : '';
});

const updateAvailable = ref(false);
const updatePlatform = ref('docker');
const showUpdateModal = ref(false);
const copied = ref(false);
const commitHash = ref<string>('');

const fallbackCommand = computed(() => {
  if (updatePlatform.value === 'docker') return 'bash /mnt/user/appdata/dlvault/scripts/update-unraid.sh';
  if (updatePlatform.value === 'windows') return 'update-windows.bat';
  return 'bash scripts/update-unraid.sh';
});

function copyCommand(cmd: string) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(cmd);
  } else {
    const ta = document.createElement('textarea');
    ta.value = cmd;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}

// One-click update state machine
type UpdateState = 'idle' | 'running' | 'done' | 'error';
const updateState = ref<UpdateState>('idle');
const currentPhase = ref<string>('');
const logLines = ref<string[]>([]);
const errorMessage = ref<string>('');
const reconnecting = ref(false);
const canStartUpdate = ref(false);
const updateBlockedReason = ref<string>('');
const logBox = ref<HTMLElement | null>(null);

let eventSource: EventSource | null = null;
let reconnectTimer: number | null = null;

const phaseSteps = [
  { key: 'pulling',         label: 'Code holen' },
  { key: 'building',        label: 'Image bauen' },
  { key: 'restarting',      label: 'Container neu starten' },
  { key: 'health',          label: 'Health-Check' },
  { key: 'done',            label: 'Fertig' },
] as const;

const phaseOrder = phaseSteps.map(s => s.key);

function phaseStepDone(key: string): boolean {
  const cur = phaseOrder.indexOf(currentPhase.value as typeof phaseOrder[number]);
  const idx = phaseOrder.indexOf(key as typeof phaseOrder[number]);
  if (cur < 0 || idx < 0) return false;
  if (updateState.value === 'done') return true;
  return idx < cur;
}

async function refreshUpdateBlockState() {
  try {
    const { data } = await getUpdateState();
    canStartUpdate.value = !!data.canStart;
    if (!data.hostPathsConfigured) {
      updateBlockedReason.value = 'HOST_DATA_DIR-Umgebungsvariable fehlt — bitte beim Container-Start setzen (siehe README).';
    } else if (data.running) {
      updateBlockedReason.value = 'Ein Update läuft bereits.';
      // Auto-attach to the running stream
      updateState.value = 'running';
      attachStream();
    } else if (!data.updaterAvailable) {
      // First-time use: the updater image will be pulled from the registry
      // on click. Inform the user but don't block.
      updateBlockedReason.value = '';
    } else {
      updateBlockedReason.value = '';
    }
  } catch {
    updateBlockedReason.value = 'Status nicht abrufbar.';
    canStartUpdate.value = false;
  }
}

function closeUpdateStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function attachStream() {
  closeUpdateStream();
  reconnecting.value = false;
  const src = new EventSource(updateStreamUrl());

  src.addEventListener('connected', () => {
    reconnecting.value = false;
  });

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
    // Server is likely restarting (Phase "restarting"). EventSource auto-reconnects,
    // but we surface it in the UI and add a fallback reconnect.
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

function appendLog(line: string) {
  logLines.value.push(line);
  // Keep last 200 lines to avoid unbounded growth
  if (logLines.value.length > 200) {
    logLines.value.splice(0, logLines.value.length - 200);
  }
  nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  });
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

function closeUpdateModal() {
  if (updateState.value === 'running') {
    // Keep stream alive in the background — user can reopen modal to see progress.
    showUpdateModal.value = false;
    return;
  }
  closeUpdateStream();
  showUpdateModal.value = false;
  // Reset for next open (after the fade-out finishes)
  setTimeout(() => {
    if (!showUpdateModal.value) {
      updateState.value = 'idle';
      currentPhase.value = '';
      logLines.value = [];
      errorMessage.value = '';
    }
  }, 300);
}

function reloadPage() {
  window.location.reload();
}

watch(showUpdateModal, (open) => {
  if (open && updateState.value === 'idle') refreshUpdateBlockState();
});

onBeforeUnmount(closeUpdateStream);

// Health data
interface ServiceHealth { configured: boolean; connected: boolean; error?: string }
interface DiskInfo { path: string; totalGB?: number; freeGB?: number; usedPercent?: number; error?: string }
interface PluginHealth { id: string; name: string; ok: boolean; critical: boolean; detail?: string; error?: string }
const health = ref<{
  services: Record<string, ServiceHealth>;
  plugins?: PluginHealth[];
  disk: Record<string, DiskInfo>;
  database: { movies: number; downloads: number; blocklist: number };
} | null>(null);

// Blocklist
const blocklist = ref<{ id: number; release_name: string; title: string | null; reason: string | null; created_at: string }[]>([]);
const showBlocklist = ref(false);

async function triggerSync() {
  const result = await syncStore.triggerSync();
  if (result.ok) {
    toast.value?.add('Sync gestartet!', 'success');
  } else {
    toast.value?.add(result.error || 'Sync fehlgeschlagen', 'error');
  }
}

async function loadHealth() {
  try {
    const res = await getHealthDetailed();
    health.value = res.data;
  } catch { /* ignore */ }
}

async function loadBlocklist() {
  try {
    const res = await getBlocklist();
    blocklist.value = res.data;
  } catch { /* ignore */ }
}

async function removeBlocklistItem(id: number) {
  try {
    await removeFromBlocklist(id);
    blocklist.value = blocklist.value.filter(b => b.id !== id);
    toast.value?.add('Eintrag entfernt', 'success');
  } catch {
    toast.value?.add('Fehler beim Entfernen', 'error');
  }
}

const serviceLabels: Record<string, string> = {
  jdownloader: 'JDownloader',
  trakt: 'Trakt',
  telegram: 'Telegram',
  jellyfin: 'Jellyfin',
  plex: 'Plex',
};

const diskLabels: Record<string, string> = {
  'paths.downloads': 'Downloads',
  'paths.movies': 'Filme',
  'paths.series': 'Serien',
};

onMounted(() => {
  syncStore.fetchAll();
  moviesStore.fetch();
  loadHealth();
  loadBlocklist();
  checkForUpdate().then(({ data }) => {
    if (data.updateAvailable) {
      updateAvailable.value = true;
    }
    if (data.platform) {
      updatePlatform.value = data.platform;
    }
    if (data.current && data.current !== 'dev') {
      commitHash.value = data.current;
    }
  }).catch(() => {});

  // If an update is already in progress (e.g. user reloaded), reopen the modal
  // and reattach to the stream so progress remains visible.
  getUpdateState().then(({ data }) => {
    if (data.running) {
      updateState.value = 'running';
      showUpdateModal.value = true;
      attachStream();
    }
  }).catch(() => {});
});
</script>

<style scoped>
.update-banner {
  background: linear-gradient(135deg, rgba(240, 107, 130, 0.15), rgba(93, 173, 226, 0.1));
  border: 1px solid var(--accent);
  color: var(--text-primary);
  padding: 14px 18px;
  border-radius: var(--radius, 8px);
  margin-bottom: var(--gap-lg, 16px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  font-size: var(--fs-sm, 0.875rem);
}

.update-btn {
  background: var(--accent);
  color: white;
  font-weight: 600;
  padding: 6px 16px;
  white-space: nowrap;
}

.update-btn:hover {
  background: var(--accent-hover);
}

/* Update modal */
.update-overlay {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.update-modal {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 28px;
  max-width: 520px;
  width: calc(100% - 32px);
  animation: fadeSlideUp 0.2s ease;
}

.update-modal h3 {
  font-size: 1.15rem;
  margin-bottom: 8px;
}

.update-modal h3 code {
  background: rgba(255, 255, 255, 0.08);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.85em;
  color: var(--accent);
}

.update-command-box {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin: 14px 0;
  font-family: monospace;
  font-size: var(--fs-sm);
  word-break: break-all;
}

.update-command-box code {
  flex: 1;
  color: var(--accent);
}

.update-copy-btn {
  background: var(--accent);
  color: white;
  flex-shrink: 0;
  font-size: var(--fs-xs);
}

.update-steps {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: 16px;
}

.update-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}

.version-badge {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.65rem;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  padding: 2px 7px;
  border-radius: 999px;
  margin-left: 10px;
  vertical-align: middle;
  letter-spacing: 0.02em;
}

.update-error {
  background: rgba(231, 76, 60, 0.12);
  border: 1px solid rgba(231, 76, 60, 0.4);
  color: var(--text-primary);
  padding: 10px 12px;
  border-radius: 8px;
  font-size: var(--fs-sm);
  margin: 12px 0;
}

/* Phase stepper */
.phase-stepper {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 16px 0 12px;
  padding: 10px 0;
  font-size: var(--fs-xs);
}

.phase-step {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  opacity: 0.55;
  transition: opacity 0.2s ease, color 0.2s ease;
}

.phase-step.done {
  color: var(--success, #2ecc71);
  opacity: 1;
}

.phase-step.active {
  color: var(--accent);
  opacity: 1;
  font-weight: 600;
}

.phase-step.error {
  color: var(--danger, #e74c3c);
  opacity: 1;
}

.phase-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.phase-step.active .phase-dot {
  animation: phase-pulse 1.2s ease-in-out infinite;
}

@keyframes phase-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50%      { transform: scale(1.4); opacity: 0.6; }
}

.phase-label {
  white-space: nowrap;
}

/* Update log */
.update-log {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  height: 180px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.75rem;
  line-height: 1.45;
  color: var(--text-secondary);
  margin: 8px 0 4px;
}

.log-line {
  white-space: pre-wrap;
  word-break: break-all;
}

.log-line.reconnect {
  color: var(--warning, #f39c12);
  font-style: italic;
  margin-top: 4px;
}

.slide-down-enter-active,
.slide-down-leave-active {
  transition: all 0.3s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

.wizard-fade-enter-active { transition: opacity 0.2s ease; }
.wizard-fade-leave-active { transition: opacity 0.15s ease; }
.wizard-fade-enter-from, .wizard-fade-leave-to { opacity: 0; }

/* Welcome eyebrow with editorial italic accent */
.welcome-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(93, 173, 226, 0.12);
  color: var(--info);
  flex-shrink: 0;
}

.welcome-italic {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: var(--accent-2);
}

/* Activity header with link */
.activity-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.activity-header h2 {
  margin: 0;
}

.activity-link {
  font-size: var(--fs-sm);
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}

.activity-link:hover {
  text-decoration: underline;
}

/* Compact table rows */
.activity-table tbody tr {
  transition: background 0.1s;
}

.activity-table tbody tr:hover {
  background: var(--bg-secondary);
}

.activity-time {
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.activity-title {
  font-weight: 500;
  max-width: 250px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-details {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Mobile: card list */
.activity-cards { display: none; }

.activity-card {
  padding: var(--gap-sm) 0;
  border-bottom: 1px solid var(--border);
}

.activity-card:last-child {
  border-bottom: none;
}

.activity-card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 3px;
}

.activity-card-time {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.activity-card-title {
  font-weight: 600;
  font-size: var(--fs-sm);
  margin-bottom: 1px;
}

.activity-card-details {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Health section */
.health-section {
  margin-bottom: var(--gap-xl);
}

.health-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
}

.health-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: var(--radius);
  background: var(--bg-primary);
  font-size: 0.85rem;
}

.health-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.health-ok .health-dot { background: var(--success); box-shadow: 0 0 4px var(--success); }
.health-err .health-dot { background: var(--error); box-shadow: 0 0 4px var(--error); }
.health-warn .health-dot { background: var(--warning, #f39c12); box-shadow: 0 0 4px var(--warning, #f39c12); }
.health-na .health-dot { background: var(--text-secondary); opacity: 0.4; }

.health-subtitle {
  margin: 14px 0 8px;
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
}

.health-label { font-weight: 500; }
.health-status {
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.disk-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.disk-item {
  padding: 8px 0;
}

.disk-label {
  font-size: 0.8rem;
  font-weight: 500;
  margin-bottom: 4px;
}

.disk-bar {
  height: 6px;
  background: var(--bg-primary);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 4px;
}

.disk-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease;
}

.disk-ok { background: var(--success); }
.disk-warn { background: var(--warning); }
.disk-critical { background: var(--error); }

.disk-meta {
  font-size: 0.7rem;
  color: var(--text-secondary);
}

.disk-error {
  color: var(--warning);
}

/* Blocklist section */
.blocklist-section {
  margin-bottom: var(--gap-xl);
}

.blocklist-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.blocklist-item:last-child { border-bottom: none; }

.blocklist-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.blocklist-release {
  font-size: 0.8rem;
  font-weight: 500;
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.blocklist-reason {
  font-size: 0.7rem;
  color: var(--text-secondary);
}

.btn-sm {
  padding: 4px 8px;
  font-size: 0.8rem;
  min-width: auto;
}

@media (max-width: 768px) {
  .activity-table { display: none; }
  .activity-cards { display: block; }

  .activity-header {
    margin-bottom: var(--gap-sm);
  }

  .activity-card {
    padding: var(--gap-md) 0;
  }

  .activity-card-title {
    font-size: var(--fs-base);
  }
}
</style>
