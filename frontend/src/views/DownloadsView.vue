<template>
  <div>
    <div class="section-header">
      <h2>Downloads</h2>
      <div class="flex-row-wrap">
        <button class="btn btn-primary" @click="startAll" :disabled="!connected" aria-label="Downloads starten">Start</button>
        <button class="btn btn-secondary" @click="pauseAll" :disabled="!connected" aria-label="Pause/Fortsetzen">
          {{ paused ? 'Fortsetzen' : 'Pause' }}
        </button>
        <button class="btn btn-secondary" @click="stopAll" :disabled="!connected" aria-label="Downloads stoppen">Stop</button>
      </div>
    </div>

    <div v-if="!connected && !loading" class="alert alert-error">
      JDownloader nicht verbunden. Prüfe die Einstellungen.
    </div>

    <!-- Speed Limit -->
    <div v-if="connected" class="speed-limit-bar">
      <div class="speed-limit-header">
        <svg class="speed-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0"/><path d="M12 7v5l3 3"/></svg>
        <span class="speed-limit-title">Geschwindigkeitsbegrenzung</span>
        <span class="toggle-switch toggle-sm" :class="{ active: speedLimitEnabled }" @click="toggleSpeedLimit" tabindex="0" @keydown.enter.prevent="toggleSpeedLimit" role="switch" :aria-checked="speedLimitEnabled">
          <span class="toggle-knob" />
        </span>
      </div>
      <div v-if="speedLimitEnabled" class="speed-limit-controls">
        <input
          type="range"
          min="0"
          max="50000"
          step="500"
          :value="speedLimitKbps"
          @input="onSpeedSlider"
          @change="debouncedApplySpeedLimit"
          class="speed-slider"
          aria-label="Geschwindigkeitslimit"
        />
        <div class="speed-limit-value">
          <input
            type="number"
            :value="speedLimitKbps"
            @change="onSpeedInput"
            min="0"
            step="500"
            class="speed-input"
            aria-label="Geschwindigkeitslimit in KB/s"
          />
          <span class="speed-unit">KB/s</span>
          <span v-if="speedLimitKbps > 0" class="speed-converted">
            = {{ (speedLimitKbps / 1024).toFixed(1) }} MB/s
          </span>
          <span v-else class="speed-converted">unbegrenzt</span>
        </div>
      </div>
    </div>

    <!-- Stats -->
    <SkeletonLoader v-if="loading" variant="stats" :count="4" />
    <div v-else-if="connected" class="stats-grid stagger-in" style="margin-bottom: 20px;">
      <div class="stat-card">
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        <div class="value">{{ packages.length }}</div>
        <div class="label">Pakete</div>
      </div>
      <div class="stat-card">
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20"/><path d="M17 7l-5 5-5-5"/></svg>
        <div class="value">{{ runningCount }}</div>
        <div class="label">Aktiv</div>
      </div>
      <div class="stat-card">
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        <div class="value">{{ totalSpeed }}</div>
        <div class="label">Geschwindigkeit</div>
      </div>
      <div v-if="extractingCount > 0" class="stat-card">
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3"/><path d="M4 12h16"/><path d="M12 8v8"/></svg>
        <div class="value">{{ extractingCount }}</div>
        <div class="label">Entpacken</div>
      </div>
      <div v-if="movedCount > 0" class="stat-card">
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
        <div class="value">{{ movedCount }}</div>
        <div class="label">Verschoben</div>
      </div>
      <div class="stat-card">
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
        <div class="value">{{ finishedCount }}</div>
        <div class="label">Fertig</div>
      </div>
    </div>

    <!-- Active Downloads -->
    <SkeletonLoader v-if="loading" variant="downloads" :count="3" />
    <div v-else-if="packages.length > 0" class="card">
      <h2>Aktive Downloads</h2>
      <div class="download-list">
        <div v-for="pkg in packages" :key="pkg.uuid" class="download-item">
          <div class="download-header">
            <strong>{{ pkg.name }}</strong>
            <span :class="['badge', statusBadge(pkg)]">{{ statusText(pkg) }}</span>
          </div>
          <div class="download-meta">
            <span>{{ formatBytes(pkg.bytesLoaded) }} / {{ formatBytes(pkg.bytesTotal) }}</span>
            <span v-if="pkg.speed > 0">{{ formatSpeed(pkg.speed) }}</span>
            <span v-if="pkg.eta > 0">ETA: {{ formatEta(pkg.eta) }}</span>
          </div>
          <div class="progress-bar" role="progressbar" :aria-valuenow="progress(pkg)" aria-valuemin="0" aria-valuemax="100" :aria-label="pkg.name + ' Fortschritt'">
            <div class="progress-fill" :style="{ width: progress(pkg) + '%' }"></div>
          </div>
          <div class="download-actions" style="margin-top: 6px;">
            <button class="btn-small" @click="removePkg(pkg)" aria-label="Paket entfernen">Entfernen</button>
          </div>
        </div>
      </div>
    </div>

    <!-- LinkGrabber Queue -->
    <div v-if="!loading && linkgrabber.length > 0" class="card">
      <div class="queue-header">
        <h2>Warteschlange (LinkGrabber)</h2>
        <span class="queue-count">{{ linkgrabber.length }}</span>
      </div>
      <div class="download-list">
        <div v-for="pkg in linkgrabber" :key="pkg.uuid" class="download-item queue-item">
          <div class="download-header">
            <div class="queue-item-left">
              <svg class="queue-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
              <strong>{{ pkg.name }}</strong>
            </div>
            <span class="badge badge-pending">Wartend</span>
          </div>
          <div class="download-meta">
            <span v-if="pkg.bytesTotal" class="queue-size">{{ formatBytes(pkg.bytesTotal) }}</span>
            <span v-if="pkg.status">{{ pkg.status }}</span>
          </div>
          <div class="download-actions" style="margin-top: 6px;">
            <button class="btn-small" @click="moveLgPkg(pkg)" aria-label="In Downloads verschieben">Starten</button>
            <button class="btn-small" @click="removeLgPkg(pkg)" aria-label="Aus Warteschlange entfernen">Entfernen</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="!loading && connected && packages.length === 0 && linkgrabber.length === 0" class="card">
      <EmptyState
        icon="Coffee"
        title="Keine Downloads aktiv"
        description="Starte einen Sync um neue Downloads zu finden."
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  startJDDownloads, stopJDDownloads, pauseJDDownloads, removeJDPackages,
  removeJDLinkGrabberPackages, moveJDLinkGrabberToDownloads,
  getJDSpeedLimit, setJDSpeedLimit,
} from '../api/index';
import type { DownloadPackage } from '../types/index';
import { useDownloadsStore } from '../stores/downloads';
import { useToast, useConfirm } from '../composables/useApp';
import { useDownloadPolling } from '../composables/useDownloadPolling';
import { formatBytes, formatSpeed, formatEta } from '../composables/useFormatters';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import EmptyState from '../components/EmptyState.vue';

const dlStore = useDownloadsStore();
const toast = useToast();
const confirmModal = useConfirm();
useDownloadPolling();

const paused = ref(false);
const speedLimitEnabled = ref(false);
const speedLimitKbps = ref(0);
let speedLimitTimer: ReturnType<typeof setTimeout> | null = null;

// Store aliases for template
const connected = computed(() => dlStore.connected);
const packages = computed(() => dlStore.packages);
const linkgrabber = computed(() => dlStore.linkgrabber);
const loading = computed(() => dlStore.loading);
const runningCount = computed(() => dlStore.runningCount);
const extractingCount = computed(() => dlStore.extractingCount);
const movedCount = computed(() => dlStore.movedCount);
const finishedCount = computed(() => dlStore.finishedCount);
const totalSpeed = computed(() => dlStore.totalSpeed);

function progress(pkg: DownloadPackage): number {
  if (!pkg.bytesTotal) return 0;
  return Math.round((pkg.bytesLoaded / pkg.bytesTotal) * 100);
}

function statusText(pkg: DownloadPackage): string {
  if (dlStore.isExtracting(pkg)) {
    const p = pkg.extractionProgress;
    if (typeof p === 'number' && p > 0 && p <= 100) return `Entpacken ${Math.round(p)}%`;
    return 'Entpacken...';
  }
  if (dlStore.isMoved(pkg)) return 'Verschoben';
  if (dlStore.isError(pkg)) return pkg.status || 'Fehler';
  if (pkg.finished) return 'Fertig';
  if (!pkg.enabled) return 'Deaktiviert';
  if (pkg.running) return `${progress(pkg)}%`;
  return pkg.status || 'Wartend';
}

function statusBadge(pkg: DownloadPackage): string {
  if (dlStore.isExtracting(pkg)) return 'badge-extracting';
  if (dlStore.isMoved(pkg)) return 'badge-downloaded';
  if (dlStore.isError(pkg)) return 'badge-not_found';
  if (pkg.finished) return 'badge-downloaded';
  if (!pkg.enabled) return 'badge-secondary';
  if (pkg.running) return 'badge-downloading';
  return 'badge-pending';
}

async function loadSpeedLimit() {
  try {
    const res = await getJDSpeedLimit();
    speedLimitEnabled.value = res.data.enabled;
    speedLimitKbps.value = res.data.limitKbps || 0;
  } catch {}
}

async function toggleSpeedLimit() {
  speedLimitEnabled.value = !speedLimitEnabled.value;
  try {
    await setJDSpeedLimit({ enabled: speedLimitEnabled.value });
  } catch {
    speedLimitEnabled.value = !speedLimitEnabled.value;
    toast.value?.add('Geschwindigkeitslimit konnte nicht gesetzt werden', 'error');
  }
}

function onSpeedSlider(e: Event) {
  speedLimitKbps.value = Number((e.target as HTMLInputElement).value);
}

async function applySpeedLimit() {
  try {
    await setJDSpeedLimit({ limitKbps: speedLimitKbps.value });
  } catch {
    toast.value?.add('Geschwindigkeitslimit konnte nicht gesetzt werden', 'error');
  }
}

function debouncedApplySpeedLimit() {
  if (speedLimitTimer) clearTimeout(speedLimitTimer);
  speedLimitTimer = setTimeout(applySpeedLimit, 500);
}

async function onSpeedInput(e: Event) {
  speedLimitKbps.value = Number((e.target as HTMLInputElement).value);
  debouncedApplySpeedLimit();
}

async function startAll() {
  try {
    await startJDDownloads();
    await dlStore.fetch(true);
  } catch {
    toast.value?.add('Downloads konnten nicht gestartet werden', 'error');
  }
}

async function stopAll() {
  try {
    await stopJDDownloads();
    await dlStore.fetch(true);
  } catch {
    toast.value?.add('Downloads konnten nicht gestoppt werden', 'error');
  }
}

async function pauseAll() {
  try {
    paused.value = !paused.value;
    await pauseJDDownloads(paused.value);
    await dlStore.fetch(true);
  } catch {
    paused.value = !paused.value;
    toast.value?.add('Pause/Fortsetzen fehlgeschlagen', 'error');
  }
}

async function removePkg(pkg: DownloadPackage) {
  const ok = await confirmModal.value?.show({
    title: 'Paket entfernen',
    message: `"${pkg.name}" wirklich entfernen?`,
    confirmText: 'Entfernen',
    danger: true,
  });
  if (!ok) return;
  try {
    await removeJDPackages([pkg.uuid]);
    await dlStore.fetch(true);
    toast.value?.add('Paket entfernt', 'success');
  } catch {
    toast.value?.add('Paket konnte nicht entfernt werden', 'error');
  }
}

async function removeLgPkg(pkg: DownloadPackage) {
  const ok = await confirmModal.value?.show({
    title: 'Paket aus Warteschlange entfernen',
    message: `"${pkg.name}" aus dem LinkGrabber entfernen?`,
    confirmText: 'Entfernen',
    danger: true,
  });
  if (!ok) return;
  try {
    await removeJDLinkGrabberPackages([pkg.uuid]);
    await dlStore.fetch(true);
    toast.value?.add('Aus Warteschlange entfernt', 'success');
  } catch {
    toast.value?.add('Paket konnte nicht entfernt werden', 'error');
  }
}

async function moveLgPkg(pkg: DownloadPackage) {
  try {
    await moveJDLinkGrabberToDownloads([pkg.uuid]);
    await dlStore.fetch(true);
    toast.value?.add('In Downloads verschoben', 'success');
  } catch {
    toast.value?.add('Verschieben fehlgeschlagen', 'error');
  }
}

onMounted(() => {
  dlStore.fetch();
  loadSpeedLimit();
});

onUnmounted(() => {
  if (speedLimitTimer) clearTimeout(speedLimitTimer);
});
</script>

<style scoped>
.download-list {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

.download-item {
  background: var(--bg-secondary);
  border-radius: 12px;
  padding: 14px var(--gap-lg);
  transition: border-color var(--duration-fast);
  border: 1px solid transparent;
}

.download-item:hover {
  border-color: var(--border);
}

.download-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--gap-xs);
}

.download-meta {
  display: flex;
  gap: var(--gap-lg);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  margin-bottom: var(--gap-sm);
}

.progress-bar {
  height: 8px;
  background: var(--bg-primary);
  border-radius: 4px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-hover));
  border-radius: 4px;
  transition: width 0.5s ease;
  position: relative;
  overflow: hidden;
}

.progress-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    -45deg,
    transparent,
    transparent 6px,
    rgba(255,255,255,0.08) 6px,
    rgba(255,255,255,0.08) 12px
  );
  animation: stripes 0.8s linear infinite;
}

@keyframes stripes {
  from { background-position: 0 0; }
  to { background-position: 17px 0; }
}

.btn-small {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  padding: 2px 10px;
  border-radius: var(--gap-xs);
  cursor: pointer;
  font-size: var(--fs-sm);
  transition: all var(--duration-fast);
}

.btn-small:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}

.btn-small:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Speed limit bar — compact inline */
.speed-limit-bar {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: var(--gap-md) 18px;
  margin-bottom: var(--gap-lg);
}

.speed-limit-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.speed-icon {
  width: 18px;
  height: 18px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.speed-limit-title {
  font-weight: 600;
  font-size: var(--fs-sm);
  margin-right: auto;
}

.toggle-sm {
  transform: scale(0.85);
}

.speed-limit-controls {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.speed-slider {
  flex: 1;
  min-width: 100px;
  max-width: 250px;
  accent-color: var(--accent);
}

.speed-limit-value {
  display: flex;
  align-items: center;
  gap: 8px;
}

.speed-input {
  width: 80px;
  text-align: right;
  padding: 6px var(--gap-sm);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: var(--fs-sm);
}

.speed-unit {
  color: var(--text-secondary);
  font-size: var(--fs-sm);
}

.speed-converted {
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  opacity: 0.7;
}

/* Stat card icons */
.stat-icon {
  width: 20px;
  height: 20px;
  color: var(--accent);
  opacity: 0.6;
  margin-bottom: var(--gap-xs);
}

/* Queue header */
.queue-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.queue-header h2 {
  margin: 0;
}

.queue-count {
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  font-weight: 600;
  padding: 2px var(--gap-sm);
  border-radius: 10px;
}

.queue-item-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.queue-item-left strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-icon {
  width: 16px;
  height: 16px;
  color: var(--text-secondary);
  flex-shrink: 0;
  opacity: 0.5;
}

.queue-size {
  font-variant-numeric: tabular-nums;
}

@media (max-width: 768px) {
  .speed-limit-controls {
    flex-direction: column;
    align-items: stretch;
    gap: var(--gap-sm);
  }

  .speed-slider {
    width: 100%;
    max-width: none;
  }

  .speed-limit-value {
    flex-wrap: wrap;
    gap: var(--gap-sm);
  }

  .speed-input {
    flex: 1;
    min-width: 80px;
  }

  .toggle-sm {
    transform: none; /* full size on mobile for better touch */
  }

  .download-header strong {
    font-size: var(--fs-sm);
    word-break: break-word;
  }

  .download-meta {
    flex-wrap: wrap;
    gap: var(--gap-sm);
  }

  .btn-small {
    padding: 6px 12px;
    min-height: 36px;
    font-size: var(--fs-xs);
  }
}
</style>
