<template>
  <div class="dl">
    <!-- ───── Header ───── -->
    <header class="dl-header">
      <h1 class="dl-title">
        Downloads <span class="serif">{{ packages.length + linkgrabber.length }}</span>
      </h1>
      <div class="dl-header-tools">
        <span :class="['dl-conn-pill', { off: !connected && !loading }]">
          <span class="dot"></span>
          <span class="conn-full">{{ connected || loading ? 'JDownloader verbunden' : 'Nicht verbunden' }}</span>
          <span class="conn-short">{{ connected || loading ? 'Verbunden' : 'Getrennt' }}</span>
        </span>
        <span v-if="activeMusicCount > 0" class="dl-conn-pill music">
          <span class="dot"></span>
          <span class="conn-full">{{ activeMusicCount }} Musik aktiv</span>
          <span class="conn-short">{{ activeMusicCount }} ♪</span>
        </span>
        <div class="dl-transport" role="group" aria-label="Transport">
          <button
            :class="{ active: connected && !paused && !stopped }"
            :disabled="!connected"
            title="Alle starten"
            @click="startAll"
          ><Play :size="13" /> Start</button>
          <button
            :class="{ active: paused }"
            :disabled="!connected || stopped"
            title="Pausieren / Fortsetzen"
            @click="pauseAll"
          ><Pause :size="13" /> {{ paused ? 'Weiter' : 'Pause' }}</button>
          <button
            :class="['danger', { active: stopped }]"
            :disabled="!connected"
            title="Alle stoppen"
            @click="stopAll"
          ><Square :size="13" /> Stop</button>
        </div>
      </div>
    </header>

    <!-- ───── Disconnected ───── -->
    <template v-if="!connected && !loading">
      <div class="dl-alert">
        <AlertTriangle :size="16" />
        JDownloader ist nicht erreichbar. Verbindung in den Einstellungen prüfen.
      </div>
      <!-- Musik läuft unabhängig von JDownloader — auch bei JD-Ausfall zeigen. -->
      <MusicDownloadsSection />
    </template>

    <template v-else>
      <!-- ───── Pipeline-Überblick ───── -->
      <SkeletonLoader v-if="loading" variant="stats" :count="1" />
      <DownloadsHero
        v-else
        :packages="packages"
        :speed-limit-enabled="speedLimitEnabled"
        :speed-limit-kbps="speedLimitKbps"
        :queue-count="linkgrabber.length"
        :downloads-free-gb="downloadsFreeGb"
        @start="startAll"
      />

      <!-- Musik-Downloads — direkt unter dem Überblick, eigene Pipeline -->
      <MusicDownloadsSection v-if="!loading" />

      <!-- ───── Speed limit ───── -->
      <SpeedLimitCard
        :enabled="speedLimitEnabled"
        :kbps="speedLimitKbps"
        @select="selectPreset"
      />

      <!-- ───── Active packages ───── -->
      <SkeletonLoader v-if="loading" variant="downloads" :count="3" />
      <div v-else-if="packages.length > 0" class="dl-section">
        <div class="dl-section-head">
          <h2>Aktive Pakete <span class="serif">{{ packages.length }}</span></h2>
          <span class="dl-section-hint">{{ paused ? 'pausiert' : 'läuft' }}</span>
        </div>
        <PackageList :packages="packages" @open="openPkg" @remove="removePkg" />
      </div>

      <!-- ───── LinkGrabber ───── -->
      <div v-if="!loading && linkgrabber.length > 0" class="dl-section">
        <div class="dl-section-head">
          <h2>LinkGrabber <span class="serif">{{ linkgrabber.length }}</span></h2>
          <span class="dl-section-hint">wartet auf nächsten Start</span>
        </div>
        <LinkGrabberList :packages="linkgrabber" @start="moveLgPkg" @remove="removeLgPkg" />
      </div>

      <!-- ───── Disk usage ───── -->
      <div v-if="disks.length > 0" class="dl-section">
        <div class="dl-section-head">
          <h2>Speicher</h2>
          <span class="dl-section-hint">JDownloader + Library</span>
        </div>
        <DiskUsage :disks="disks" />
      </div>

      <!-- ───── Empty ───── -->
      <div v-if="!loading && packages.length === 0 && linkgrabber.length === 0 && musicStore.downloads.length === 0" class="card">
        <EmptyState
          icon="Coffee"
          title="Keine Downloads aktiv"
          description="Starte einen Sync um neue Downloads zu finden."
        />
      </div>
    </template>

    <DetailPanel
      :movie="panelMovie"
      :context="panelContext"
      @close="closePanel"
      @pause="onPanelPause"
      @change-source="onChangeSource"
      @delete="onPanelDelete"
    />

    <SwitchSourceModal
      v-if="switchOpen"
      :movie="panelMovie"
      :current-pkg-uuid="panelPkg?.uuid ?? null"
      :current-name="panelPkg?.name ?? null"
      @close="switchOpen = false"
      @switched="onSwitched"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import {
  startJDDownloads, stopJDDownloads, pauseJDDownloads, removeJDPackages,
  removeJDLinkGrabberPackages, moveJDLinkGrabberToDownloads,
  getJDSpeedLimit, setJDSpeedLimit, getHealthDetailed,
} from '../api/index';
import type { DownloadPackage, Movie, MovieStatus } from '../types/index';
import { useDownloadsStore } from '../stores/downloads';
import { useMoviesStore } from '../stores/movies';
import { useMusicStore } from '../stores/music';
import { useToast, useConfirm } from '../composables/useApp';
import { useDownloadPolling } from '../composables/useDownloadPolling';
import { useDetailPanel } from '../composables/useDetailPanel';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import MusicDownloadsSection from '../components/downloads/MusicDownloadsSection.vue';
import DownloadsHero from '../components/downloads/DownloadsHero.vue';
import SpeedLimitCard from '../components/downloads/SpeedLimitCard.vue';
import PackageList from '../components/downloads/PackageList.vue';
import LinkGrabberList from '../components/downloads/LinkGrabberList.vue';
import DiskUsage from '../components/downloads/DiskUsage.vue';
import EmptyState from '../components/EmptyState.vue';
import DetailPanel from '../components/DetailPanel.vue';
import SwitchSourceModal from '../components/SwitchSourceModal.vue';
import { stageOf, matchMovie as matchMovieIn, activeMusicDownloads } from '../components/downloads/downloadPackage';
import { Play, Pause, Square, AlertTriangle } from 'lucide-vue-next';

const dlStore = useDownloadsStore();
const moviesStore = useMoviesStore();
const musicStore = useMusicStore();
const toast = useToast();

// Aktive (nicht-fertige, nicht-fehlerhafte) Musik-Downloads für die Header-Pille.
const activeMusicCount = computed(() => activeMusicDownloads(musicStore.downloads).length);
const confirmModal = useConfirm();
useDownloadPolling();

const { movie: panelMovie, context: panelContext, close: closePanel, openFromPackage } = useDetailPanel();

// The JD package the detail panel was opened from — needed so "Quelle wechseln"
// can remove exactly that package before sending the chosen replacement.
const panelPkg = ref<DownloadPackage | null>(null);
const switchOpen = ref(false);

const paused = ref(false);
const stopped = ref(false);
const speedLimitEnabled = ref(false);
const speedLimitKbps = ref(0);

// ── Store aliases ───────────────────────────────────────────
const connected = computed(() => dlStore.connected);
const packages = computed(() => dlStore.packages);
const linkgrabber = computed(() => dlStore.linkgrabber);
const loading = computed(() => dlStore.loading);

// ── Disk usage (real, from /health/detailed) ────────────────
interface DiskInfo { path: string; totalGB?: number; freeGB?: number; usedPercent?: number; error?: string }
const disk = ref<Record<string, DiskInfo>>({});

const DISK_META: Record<string, { path: string; label: string }> = {
  'paths.downloads': { path: '/downloads', label: 'JDownloader · Working' },
  'paths.movies':    { path: '/movies',    label: 'Filme · Library' },
  'paths.series':    { path: '/series',    label: 'Serien · Library' },
};

const disks = computed(() =>
  Object.entries(disk.value)
    .filter(([, info]) => typeof info.totalGB === 'number')
    .map(([key, info]) => {
      const meta = DISK_META[key];
      const usedPercent = info.usedPercent || 0;
      return {
        key,
        path: meta?.path || info.path || key,
        label: meta?.label || '',
        totalGB: info.totalGB || 0,
        freeGB: info.freeGB || 0,
        usedGB: Math.max(0, (info.totalGB || 0) - (info.freeGB || 0)),
        usedPercent,
        tone: usedPercent > 90 ? 'err' : usedPercent > 75 ? 'warn' : '',
      };
    })
);

const downloadsFreeGb = computed(() => {
  const d = disk.value['paths.downloads'];
  return typeof d?.freeGB === 'number' ? d.freeGB : null;
});

async function loadHealth() {
  try {
    const res = await getHealthDetailed();
    disk.value = res.data?.disk || {};
  } catch { /* disk strip stays hidden */ }
}

// ── Detail panel (downloads context) ────────────────────────
function panelStatusOf(pkg: DownloadPackage): MovieStatus {
  const key = stageOf(pkg).key;
  if (key === 'extracting') return 'extracting';
  if (key === 'moved') return 'moved';
  if (key === 'finished') return 'downloaded';
  if (key === 'pending') return 'pending';
  return 'downloading'; // downloading + error both keep the live progress view
}

function matchMovie(pkg: DownloadPackage): Movie | null {
  return matchMovieIn(pkg, moviesStore.movies);
}

function openPkg(pkg: DownloadPackage) {
  panelPkg.value = pkg;
  openFromPackage(pkg, panelStatusOf(pkg), dlStore.isExtracting(pkg), matchMovie(pkg));
}

async function onPanelPause() {
  if (!paused.value) await pauseAll();
  closePanel();
}

function onChangeSource() {
  if (!panelMovie.value) {
    toast.value?.add('Quelle wechseln ist für dieses Paket nicht verfügbar', 'info');
    return;
  }
  switchOpen.value = true;
}

async function onSwitched() {
  switchOpen.value = false;
  closePanel();
  await dlStore.fetch(true);
}

async function onPanelDelete(pm: { id: number | string; sourceId?: number | string }) {
  // Prefer the package uuid the panel was opened with — once the panel is
  // enriched from the DB, `pm.id` is the dlvault movie id, which never matches
  // a JD uuid, so the delete quietly left the download running.
  const uuid = Number(pm.sourceId ?? pm.id);
  const p = packages.value.find(x => x.uuid === uuid) ?? panelPkg.value;
  if (!p) { closePanel(); return; }
  await removePkg(p);
  closePanel();
}

// ── Speed limit ─────────────────────────────────────────────
async function loadSpeedLimit() {
  try {
    const res = await getJDSpeedLimit();
    speedLimitEnabled.value = res.data.enabled;
    speedLimitKbps.value = res.data.limitKbps || 0;
  } catch { /* leave defaults */ }
}

async function selectPreset(kbps: number) {
  const prevEnabled = speedLimitEnabled.value;
  const prevKbps = speedLimitKbps.value;
  if (kbps === 0) {
    speedLimitEnabled.value = false;
    speedLimitKbps.value = 0;
  } else {
    speedLimitEnabled.value = true;
    speedLimitKbps.value = kbps;
  }
  try {
    await setJDSpeedLimit({ enabled: speedLimitEnabled.value, limitKbps: speedLimitKbps.value });
  } catch {
    speedLimitEnabled.value = prevEnabled;
    speedLimitKbps.value = prevKbps;
    toast.value?.add('Geschwindigkeitslimit konnte nicht gesetzt werden', 'error');
  }
}

// ── Transport ───────────────────────────────────────────────
async function startAll() {
  try {
    await startJDDownloads();
    paused.value = false;
    stopped.value = false;
    await dlStore.fetch(true);
  } catch {
    toast.value?.add('Downloads konnten nicht gestartet werden', 'error');
  }
}

async function stopAll() {
  try {
    await stopJDDownloads();
    stopped.value = !stopped.value;
    paused.value = false;
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
  moviesStore.fetch();
  loadSpeedLimit();
  loadHealth();
});
</script>

<style scoped>
.dl {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

/* ───── Header ───── */
.dl-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 24px;
  flex-wrap: wrap;
}
.dl-title {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.02em;
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 0;
}
.dl-title .serif {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: var(--accent-2);
}
.dl-header-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* Connection pill */
.dl-conn-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px 5px 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent);
  background: color-mix(in srgb, var(--ok) 8%, transparent);
  color: var(--ok);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-weight: 600;
}
.dl-conn-pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}
.dl-conn-pill.off {
  border-color: rgba(240, 123, 110, 0.3);
  background: rgba(240, 123, 110, 0.06);
  color: var(--err);
}
.dl-conn-pill.music {
  border-color: color-mix(in srgb, var(--stage-downloading) 32%, transparent);
  background: color-mix(in srgb, var(--stage-downloading) 8%, transparent);
  color: var(--stage-downloading);
}
.dl-conn-pill.music .dot { animation: pillPulse 1.4s ease-in-out infinite; }
@keyframes pillPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.dl-conn-pill .conn-short { display: none; }

/* Transport control */
.dl-transport {
  display: inline-flex;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px;
  gap: 2px;
}
.dl-transport button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 999px;
  transition: background 0.15s, color 0.15s;
}
.dl-transport button:hover:not(:disabled) { color: var(--text-primary); }
.dl-transport button.active { background: var(--accent-soft); color: var(--accent); }
.dl-transport button.danger:hover:not(:disabled) { color: var(--err); background: rgba(240, 123, 110, 0.08); }
.dl-transport button:disabled { opacity: 0.4; cursor: not-allowed; }

/* ───── Alert ───── */
.dl-alert {
  padding: 14px 18px;
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--err) 8%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--err) 25%, transparent);
  color: var(--err);
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  font-weight: 500;
}

/* ───── Sections ───── */
.dl-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dl-section-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 0 4px;
}
.dl-section-head h2 {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0;
}
.dl-section-head h2 .serif {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: var(--accent-2);
}
.dl-section-hint {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 0.02em;
}

/* ───── Responsive ───── */
@media (max-width: 768px) {
  .dl-header { flex-direction: column; align-items: stretch; position: relative; }
  .dl-header-tools { flex-wrap: wrap; }
  /* Compact connection badge parked top-right next to the title (saves a row) */
  .dl-conn-pill { position: absolute; top: 2px; right: 0; padding: 4px 9px 4px 8px; font-size: 10px; gap: 6px; }
  .dl-conn-pill .conn-full { display: none; }
  .dl-conn-pill .conn-short { display: inline; }
}
</style>
