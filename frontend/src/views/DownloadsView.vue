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
          {{ connected || loading ? 'JDownloader verbunden' : 'Nicht verbunden' }}
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
    <div v-if="!connected && !loading" class="dl-alert">
      <AlertTriangle :size="16" />
      JDownloader ist nicht erreichbar. Verbindung in den Einstellungen prüfen.
    </div>

    <template v-else>
      <!-- ───── Hero ───── -->
      <SkeletonLoader v-if="loading" variant="stats" :count="1" />

      <!-- Active hero -->
      <div v-else-if="packages.length > 0" class="dl-hero fade-in">
        <div class="dl-hero-main">
          <div class="dl-hero-eyebrow">
            <span class="dot"></span>
            {{ downloadingPkgs.length > 0 ? 'Downloads laufen' : extractingPkgs.length > 0 ? 'Entpacken' : 'Aktiv' }}
            · {{ packages.length }} Paket{{ packages.length !== 1 ? 'e' : '' }}
          </div>
          <div class="dl-hero-title-row">
            <div class="dl-hero-speed">
              {{ totalMbps > 0 ? totalMbps.toFixed(1) : '—' }}<span class="unit">{{ totalMbps > 0 ? 'MB/s' : 'idle' }}</span>
            </div>
            <div v-if="speedLimitEnabled && speedLimitKbps > 0" class="dl-hero-limit-mark">
              Limit <span class="bar"></span> <strong>{{ (speedLimitKbps / 1024).toFixed(0) }} MB/s</strong>
            </div>
          </div>
          <div class="dl-hero-subline">
            <span><strong>{{ downloadingPkgs.length }}</strong> aktiv</span>
            <template v-if="extractingPkgs.length > 0">
              <span class="pip">·</span><span><strong>{{ extractingPkgs.length }}</strong> entpackt</span>
            </template>
            <span class="pip">·</span>
            <span><strong>{{ formatBytes(totalLoaded) }}</strong> / {{ formatBytes(totalSize) }}</span>
            <span class="pip">·</span>
            <span>Gesamt-ETA <strong>{{ formatEta(totalEta) }}</strong></span>
          </div>

          <div v-if="featured" class="dl-hero-current" :style="{ '--stage-color': stageOf(featured).color }">
            <MoviePoster :title="parsed(featured.name).title" :year="parsed(featured.name).year" size="md" />
            <div class="dl-hero-current-text">
              <div class="dl-hero-current-eyebrow">
                {{ stageOf(featured).label }}
              </div>
              <div class="dl-hero-current-title">
                {{ parsed(featured.name).title }}<span v-if="parsed(featured.name).year" class="year">{{ parsed(featured.name).year }}</span>
              </div>
              <div class="dl-hero-current-meta">
                <template v-if="quality(featured.name)">{{ quality(featured.name) }} · </template>{{ truncate(featured.name, 60) }}
              </div>
            </div>
            <div class="dl-hero-current-pct">{{ pct(featured) }}%</div>
          </div>
        </div>

        <div class="dl-hero-side">
          <div class="dl-sparkline-card">
            <div class="dl-sparkline-head">
              <div class="dl-sparkline-label">Durchsatz · letzte {{ speedHistory.length }} s</div>
              <div class="dl-sparkline-stats">
                <span>jetzt <strong>{{ formatSpeed(totalSpeedBytes) }}</strong></span>
                <span>peak <strong>{{ formatSpeed(peakBytes) }}</strong></span>
              </div>
            </div>
            <div class="dl-sparkline-wrap">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="dlSparkGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--stage-downloading)" stop-opacity="0.4" />
                    <stop offset="100%" stop-color="var(--stage-downloading)" stop-opacity="0" />
                  </linearGradient>
                </defs>
                <line class="dl-sparkline-grid" x1="0" y1="25" x2="100" y2="25" />
                <line class="dl-sparkline-grid" x1="0" y1="50" x2="100" y2="50" />
                <line class="dl-sparkline-grid" x1="0" y1="75" x2="100" y2="75" />
                <path :d="sparkArea" class="dl-sparkline-area" />
                <path :d="sparkLine" class="dl-sparkline-line" vector-effect="non-scaling-stroke" />
                <circle :cx="sparkLast[0]" :cy="sparkLast[1]" r="2.5" class="dl-sparkline-dot" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      <!-- Idle hero -->
      <div v-else class="dl-hero idle fade-in">
        <div class="dl-hero-idle-body">
          <div>
            <div class="dl-hero-eyebrow ok">
              <span class="dot"></span>
              Bereit · keine aktiven Downloads
            </div>
            <div class="dl-hero-idle-num">
              0<small>aktive Pakete</small>
            </div>
            <div class="dl-hero-subline" style="margin-top: 14px;">
              <span>JDownloader verbunden</span>
              <span class="pip">·</span>
              <span>{{ linkgrabber.length }} Paket{{ linkgrabber.length !== 1 ? 'e' : '' }} in der Warteschlange</span>
              <template v-if="downloadsFreeGB !== null">
                <span class="pip">·</span>
                <span><strong>{{ fmtDiskGB(downloadsFreeGB) }}</strong> frei in /downloads</span>
              </template>
            </div>
          </div>
          <div class="dl-hero-idle-cta">
            <button class="btn btn-primary" @click="startAll"><Play :size="14" /> Downloads starten</button>
          </div>
        </div>
      </div>

      <!-- ───── Stat strip ───── -->
      <SkeletonLoader v-if="loading" variant="stats" :count="4" />
      <div v-else class="dl-stats">
        <div class="dl-stat">
          <div class="dl-stat-label">Aktiv</div>
          <div :class="['dl-stat-value', 'colored', { downloading: runningCount > 0 }]">
            {{ runningCount }}<span class="unit">{{ runningCount === 1 ? 'paket' : 'pakete' }}</span>
          </div>
          <div class="dl-stat-foot">in der Pipeline</div>
        </div>
        <div class="dl-stat">
          <div class="dl-stat-label">Entpacken</div>
          <div :class="['dl-stat-value', 'colored', { extracting: extractingCount > 0 }]">
            {{ extractingCount }}<span class="unit">{{ extractingCount === 1 ? 'paket' : 'pakete' }}</span>
          </div>
          <div class="dl-stat-foot">RAR / 7z Volumes</div>
        </div>
        <div class="dl-stat">
          <div class="dl-stat-label">Verschoben</div>
          <div :class="['dl-stat-value', 'colored', { ok: movedCount > 0 }]">{{ movedCount }}<span class="unit">→ library</span></div>
          <div class="dl-stat-foot">aktuelle Pakete</div>
        </div>
        <div class="dl-stat">
          <div class="dl-stat-label">Warteschlange</div>
          <div class="dl-stat-value">{{ linkgrabber.length }}<span class="unit">link­grabber</span></div>
          <div class="dl-stat-foot">{{ formatBytes(linkgrabberSize) }} zum laden</div>
        </div>
      </div>

      <!-- ───── Speed limit ───── -->
      <div class="dl-speedlimit">
        <div class="dl-speedlimit-text">
          <div class="dl-speedlimit-eyebrow">Bandbreitenlimit · JDownloader</div>
          <div class="dl-speedlimit-title">
            <template v-if="speedLimitEnabled && speedLimitKbps > 0">
              Begrenzt auf <strong>{{ (speedLimitKbps / 1024).toFixed(0) }} MB/s</strong>
              <span class="serif">ungefähr {{ Math.round((speedLimitKbps / 1024) * 8) }} Mbit</span>
            </template>
            <template v-else>
              <strong>Unbegrenzt</strong> <span class="serif">volle Pipe</span>
            </template>
          </div>
          <div class="dl-speedlimit-sub">
            Gilt global für alle aktiven und kommenden Downloads — wird sofort übernommen.
          </div>
        </div>
        <div class="dl-speedlimit-presets" role="radiogroup" aria-label="Geschwindigkeitslimit">
          <button
            v-for="p in speedPresets"
            :key="p.label"
            :class="{ active: activePreset === p.kbps }"
            :aria-label="p.kbps ? `${p.label} MB/s` : 'Unbegrenzt'"
            @click="selectPreset(p.kbps)"
          >{{ p.label }}</button>
        </div>
      </div>

      <!-- ───── Active packages ───── -->
      <SkeletonLoader v-if="loading" variant="downloads" :count="3" />
      <div v-else-if="packages.length > 0" class="dl-section">
        <div class="dl-section-head">
          <h2>Aktive Pakete <span class="serif">{{ packages.length }}</span></h2>
          <span class="dl-section-hint">{{ paused ? 'pausiert' : 'läuft' }}</span>
        </div>
        <div class="dl-pkg-list">
          <div
            v-for="pkg in packages"
            :key="pkg.uuid"
            :class="['dl-pkg', { 'has-error': stageOf(pkg).key === 'error' }]"
            :style="{ '--stage-color': stageOf(pkg).color }"
            role="button"
            tabindex="0"
            @click="openPkg(pkg)"
            @keydown.enter="openPkg(pkg)"
          >
            <MoviePoster :title="parsed(pkg.name).title" :year="parsed(pkg.name).year" size="md" />
            <div class="dl-pkg-body">
              <div class="dl-pkg-title">
                <span class="name">{{ parsed(pkg.name).title }}</span>
                <span v-if="parsed(pkg.name).year" class="year">{{ parsed(pkg.name).year }}</span>
              </div>
              <div class="dl-pkg-filename">{{ pkg.name }}</div>
              <div class="dl-pkg-meta">
                <span><strong>{{ formatBytes(pkg.bytesLoaded) }}</strong> / {{ formatBytes(pkg.bytesTotal) }}</span>
                <template v-if="pkg.speed > 0"><span class="pip">·</span><span><strong>{{ formatSpeed(pkg.speed) }}</strong></span></template>
                <template v-if="pkg.eta > 0"><span class="pip">·</span><span>ETA <strong>{{ formatEta(pkg.eta) }}</strong></span></template>
                <span class="pip">·</span>
                <span :class="['pct', stageOf(pkg).key]">{{ pct(pkg) }}%</span>
              </div>
              <div :class="['dl-pkg-progress', { error: stageOf(pkg).key === 'error' }]">
                <div class="fill" :style="{ width: pct(pkg) + '%' }"></div>
              </div>
            </div>
            <span :class="['dl-pkg-stage', { active: stageOf(pkg).key === 'downloading' || stageOf(pkg).key === 'extracting' }]">
              <span class="dot"></span>
              {{ stageOf(pkg).label }}
            </span>
            <div class="dl-pkg-actions">
              <button class="icon-btn danger" title="Entfernen" @click.stop="removePkg(pkg)"><Trash2 :size="14" /></button>
            </div>
          </div>
        </div>
      </div>

      <!-- ───── LinkGrabber ───── -->
      <div v-if="!loading && linkgrabber.length > 0" class="dl-section">
        <div class="dl-section-head">
          <h2>LinkGrabber <span class="serif">{{ linkgrabber.length }}</span></h2>
          <span class="dl-section-hint">wartet auf nächsten Start</span>
        </div>
        <div class="dl-lg-list">
          <div v-for="(pkg, i) in linkgrabber" :key="pkg.uuid" class="dl-lg-row">
            <div class="dl-lg-pos">{{ String(i + 1).padStart(2, '0') }}</div>
            <div class="dl-lg-name">
              <span class="title">{{ parsed(pkg.name).title }}</span>
              <span v-if="parsed(pkg.name).year" class="year">{{ parsed(pkg.name).year }}</span>
              <span v-if="quality(pkg.name)" class="dl-lg-quality">{{ quality(pkg.name) }}</span>
            </div>
            <div class="dl-lg-size">{{ pkg.bytesTotal ? formatBytes(pkg.bytesTotal) : '—' }}</div>
            <div class="dl-lg-actions">
              <button class="icon-btn" title="Starten" @click="moveLgPkg(pkg)"><Play :size="14" /></button>
              <button class="icon-btn danger" title="Entfernen" @click="removeLgPkg(pkg)"><Trash2 :size="14" /></button>
            </div>
          </div>
        </div>
      </div>

      <!-- ───── Disk usage ───── -->
      <div v-if="disks.length > 0" class="dl-section">
        <div class="dl-section-head">
          <h2>Speicher</h2>
          <span class="dl-section-hint">JDownloader + Library</span>
        </div>
        <div class="dl-disks">
          <div v-for="d in disks" :key="d.key" class="dl-disk">
            <div class="dl-disk-head">
              <div class="dl-disk-path">{{ d.path }}</div>
              <div class="dl-disk-free"><strong>{{ fmtDiskGB(d.freeGB) }}</strong> frei</div>
            </div>
            <div class="dl-disk-bar">
              <div :class="['fill', d.tone]" :style="{ width: d.usedPercent + '%' }"></div>
            </div>
            <div class="dl-disk-foot">
              <span>{{ d.label }}</span>
              <span><strong>{{ fmtDiskGB(d.usedGB) }}</strong> / {{ fmtDiskGB(d.totalGB) }} · {{ Math.round(d.usedPercent) }}%</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ───── Empty ───── -->
      <div v-if="!loading && packages.length === 0 && linkgrabber.length === 0" class="card">
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  startJDDownloads, stopJDDownloads, pauseJDDownloads, removeJDPackages,
  removeJDLinkGrabberPackages, moveJDLinkGrabberToDownloads,
  getJDSpeedLimit, setJDSpeedLimit, getHealthDetailed,
} from '../api/index';
import type { DownloadPackage, Movie, MovieStatus } from '../types/index';
import { useDownloadsStore } from '../stores/downloads';
import { useMoviesStore } from '../stores/movies';
import { useToast, useConfirm } from '../composables/useApp';
import { useDownloadPolling } from '../composables/useDownloadPolling';
import { useDetailPanel } from '../composables/useDetailPanel';
import { formatBytes, formatSpeed, formatEta } from '../composables/useFormatters';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import EmptyState from '../components/EmptyState.vue';
import MoviePoster from '../components/MoviePoster.vue';
import DetailPanel from '../components/DetailPanel.vue';
import { Play, Pause, Square, Trash2, AlertTriangle } from 'lucide-vue-next';

const dlStore = useDownloadsStore();
const moviesStore = useMoviesStore();
const toast = useToast();
const confirmModal = useConfirm();
useDownloadPolling();

const { movie: panelMovie, context: panelContext, close: closePanel, openFromPackage } = useDetailPanel();

const paused = ref(false);
const stopped = ref(false);
const speedLimitEnabled = ref(false);
const speedLimitKbps = ref(0);

// ── Store aliases ───────────────────────────────────────────
const connected = computed(() => dlStore.connected);
const packages = computed(() => dlStore.packages);
const linkgrabber = computed(() => dlStore.linkgrabber);
const loading = computed(() => dlStore.loading);
const runningCount = computed(() => dlStore.runningCount);
const extractingCount = computed(() => dlStore.extractingCount);
const movedCount = computed(() => dlStore.movedCount);

const downloadingPkgs = computed(() => packages.value.filter(p => stageOf(p).key === 'downloading'));
const extractingPkgs = computed(() => packages.value.filter(p => stageOf(p).key === 'extracting'));

// ── Hero aggregates ─────────────────────────────────────────
const totalSpeedBytes = computed(() => packages.value.reduce((s, p) => s + (p.speed || 0), 0));
const totalMbps = computed(() => totalSpeedBytes.value / (1024 * 1024));
const totalLoaded = computed(() => packages.value.reduce((s, p) => s + (p.bytesLoaded || 0), 0));
const totalSize = computed(() => packages.value.reduce((s, p) => s + (p.bytesTotal || 0), 0));
const totalEta = computed(() => {
  const etas = downloadingPkgs.value.map(p => p.eta).filter(e => e > 0);
  return etas.length ? Math.max(...etas) : 0;
});
const linkgrabberSize = computed(() => linkgrabber.value.reduce((s, p) => s + (p.bytesTotal || 0), 0));

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

const downloadsFreeGB = computed(() => {
  const d = disk.value['paths.downloads'];
  return typeof d?.freeGB === 'number' ? d.freeGB : null;
});

function fmtDiskGB(gb: number): string {
  if (gb >= 1024) return (gb / 1024).toFixed(2) + ' TB';
  return Math.round(gb) + ' GB';
}

async function loadHealth() {
  try {
    const res = await getHealthDetailed();
    disk.value = res.data?.disk || {};
  } catch { /* disk strip stays hidden */ }
}

// Featured package for the hero card
const featured = computed(() =>
  downloadingPkgs.value[0] || extractingPkgs.value[0] || packages.value[0] || null
);

// ── Stage / progress helpers ────────────────────────────────
type Stage = { key: string; label: string; color: string };
function stageOf(p: DownloadPackage): Stage {
  if (dlStore.isError(p)) return { key: 'error', label: 'Fehler', color: 'var(--err)' };
  if (dlStore.isExtracting(p)) return { key: 'extracting', label: 'Entpackt', color: 'var(--stage-extracting)' };
  if (dlStore.isMoved(p)) return { key: 'moved', label: 'Verschoben', color: 'var(--stage-moved)' };
  if (p.finished) return { key: 'finished', label: 'Fertig', color: 'var(--stage-library)' };
  if (p.running) return { key: 'downloading', label: 'Lädt', color: 'var(--stage-downloading)' };
  return { key: 'pending', label: 'Wartet', color: 'var(--stage-pending)' };
}

function pct(p: DownloadPackage): number {
  const key = stageOf(p).key;
  if (key === 'extracting') {
    const ep = p.extractionProgress;
    return typeof ep === 'number' && ep > 0 ? Math.round(ep) : 0;
  }
  if (key === 'moved' || key === 'finished') return 100;
  if (!p.bytesTotal) return 0;
  return Math.round((p.bytesLoaded / p.bytesTotal) * 100);
}

// ── Name parsing (JD package names → title / year / quality) ─
function parsed(name: string): { title: string; year?: number } {
  // dlvault packages are named "Title (Year)"
  const m = name.match(/^(.+?) \((\d{4})\)/);
  if (m) return { title: m[1], year: Number(m[2]) };
  // scene-style "The.Title.2049.2160p..." → title up to the year
  const sm = name.match(/^(.*?)[. _](19|20)(\d{2})[. _]/);
  if (sm) return { title: sm[1].replace(/[._]/g, ' ').trim(), year: Number(sm[2] + sm[3]) };
  return { title: name.replace(/\.(mkv|mp4|rar|zip|avi)$/i, '').replace(/[._]/g, ' '), year: undefined };
}

function quality(name: string): string {
  if (/2160p|\buhd\b|\b4k\b/i.test(name)) return '4K';
  if (/1080p/i.test(name)) return '1080p';
  if (/720p/i.test(name)) return '720p';
  return '';
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
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
  const p = parsed(pkg.name);
  return moviesStore.movies.find(m => m.title === p.title && m.year === p.year)
    || moviesStore.movies.find(m => m.title === p.title)
    || null;
}

function openPkg(pkg: DownloadPackage) {
  openFromPackage(pkg, panelStatusOf(pkg), dlStore.isExtracting(pkg), matchMovie(pkg));
}

async function onPanelPause() {
  if (!paused.value) await pauseAll();
  closePanel();
}

function onChangeSource() {
  toast.value?.add('Quelle wechseln ist noch nicht verfügbar', 'info');
}

async function onPanelDelete(pm: { id: number | string }) {
  const p = packages.value.find(x => x.uuid === Number(pm.id));
  if (!p) { closePanel(); return; }
  await removePkg(p);
  closePanel();
}

// ── Live throughput sparkline (sampled client-side) ─────────
const SPARK_SAMPLES = 60;
const speedHistory = ref<number[]>(Array(SPARK_SAMPLES).fill(0));
const peakBytes = computed(() => Math.max(0, ...speedHistory.value));
let sparkTimer: ReturnType<typeof setInterval> | null = null;

const sparkPoints = computed<[number, number][]>(() => {
  const d = speedHistory.value;
  const n = d.length;
  const max = Math.max(1, ...d);
  const stepX = 100 / (n - 1);
  return d.map((v, i) => [i * stepX, 100 - (v / max) * 96 - 2]);
});
const sparkLine = computed(() =>
  'M ' + sparkPoints.value.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L ')
);
const sparkArea = computed(() => sparkLine.value + ' L 100 100 L 0 100 Z');
const sparkLast = computed<[number, number]>(() =>
  sparkPoints.value[sparkPoints.value.length - 1] || [100, 98]
);

// ── Speed limit presets (MB/s → KB/s, ∞ = unlimited) ────────
const speedPresets = [
  { label: '1', kbps: 1024 },
  { label: '2', kbps: 2048 },
  { label: '5', kbps: 5120 },
  { label: '10', kbps: 10240 },
  { label: '20', kbps: 20480 },
  { label: '∞', kbps: 0 },
];
const activePreset = computed(() =>
  speedLimitEnabled.value && speedLimitKbps.value > 0 ? speedLimitKbps.value : 0
);

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
  // Sample real throughput once per second for the hero sparkline.
  sparkTimer = setInterval(() => {
    speedHistory.value = [...speedHistory.value.slice(1), totalSpeedBytes.value];
  }, 1000);
});

onUnmounted(() => {
  if (sparkTimer) clearInterval(sparkTimer);
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

/* ───── Hero ───── */
.dl-hero {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 24px 26px;
  overflow: hidden;
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 28px;
  align-items: stretch;
}
.dl-hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(620px 240px at 0% 0%, color-mix(in srgb, var(--stage-downloading) 8%, transparent), transparent 70%),
    radial-gradient(420px 200px at 100% 100%, color-mix(in srgb, var(--accent) 6%, transparent), transparent 70%);
  pointer-events: none;
}
.dl-hero-main, .dl-hero-side { position: relative; z-index: 1; }

.dl-hero-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--stage-downloading);
  margin-bottom: 12px;
}
.dl-hero-eyebrow .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--stage-downloading);
  box-shadow: 0 0 8px var(--stage-downloading);
  animation: dlPulse 1.4s ease-in-out infinite;
}
.dl-hero-eyebrow.ok { color: var(--ok); }
.dl-hero-eyebrow.ok .dot { background: var(--ok); box-shadow: 0 0 8px var(--ok); animation: none; }

.dl-hero-title-row {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.dl-hero-speed {
  font-size: 56px;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}
.dl-hero-speed .unit {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 22px;
  color: var(--text-secondary);
  margin-left: 6px;
  letter-spacing: 0;
}
.dl-hero-limit-mark {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dl-hero-limit-mark .bar {
  display: inline-block;
  width: 1px;
  height: 9px;
  background: var(--text-3);
  margin: 0 4px;
}
.dl-hero-limit-mark strong { color: var(--accent-2); font-weight: 600; }

.dl-hero-subline {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 4px;
}
.dl-hero-subline .pip { color: var(--text-3); }
.dl-hero-subline strong { color: var(--text-primary); font-weight: 600; }

.dl-hero-current {
  margin-top: 18px;
  padding: 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--line);
  background: var(--surface-2);
  display: grid;
  grid-template-columns: 56px 1fr auto;
  gap: 14px;
  align-items: center;
}
.dl-hero-current-text { min-width: 0; }
.dl-hero-current-eyebrow {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--stage-color, var(--text-3));
}
.dl-hero-current-title {
  margin-top: 3px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dl-hero-current-title .year {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 13px;
  color: var(--text-secondary);
  margin-left: 6px;
}
.dl-hero-current-meta {
  margin-top: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dl-hero-current-pct {
  font-family: var(--font-mono);
  font-size: 22px;
  font-weight: 600;
  color: var(--stage-color, var(--stage-downloading));
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}

/* Sparkline panel */
.dl-hero-side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.dl-sparkline-card {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
}
.dl-sparkline-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.dl-sparkline-label {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
}
.dl-sparkline-stats {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  display: flex;
  gap: 12px;
}
.dl-sparkline-stats strong { color: var(--text-primary); font-weight: 600; }
.dl-sparkline-wrap {
  position: relative;
  width: 100%;
  height: 70px;
}
.dl-sparkline-wrap svg { width: 100%; height: 100%; display: block; }
.dl-sparkline-line {
  stroke: var(--stage-downloading);
  stroke-width: 1.8;
  fill: none;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.dl-sparkline-area { fill: url(#dlSparkGrad); stroke: none; }
.dl-sparkline-dot { fill: var(--stage-downloading); animation: dlDotPulse 1.2s ease-in-out infinite; }
.dl-sparkline-grid { stroke: var(--line); stroke-width: 0.5; stroke-dasharray: 2 4; }

/* Idle hero */
.dl-hero.idle { grid-template-columns: 1fr; }
.dl-hero-idle-body {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 28px;
  align-items: center;
}
.dl-hero-idle-num {
  font-size: 64px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: -0.03em;
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}
.dl-hero-idle-num small {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 22px;
  color: var(--text-secondary);
  margin-left: 8px;
}
.dl-hero-idle-cta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
}

/* ───── Stat strip ───── */
.dl-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.dl-stat {
  background: var(--surface);
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dl-stat-label {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
}
.dl-stat-value {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.dl-stat-value .unit {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 15px;
  color: var(--text-secondary);
}
.dl-stat-value.colored.downloading { color: var(--stage-downloading); }
.dl-stat-value.colored.extracting { color: var(--stage-extracting); }
.dl-stat-value.colored.ok { color: var(--ok); }
.dl-stat-foot {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

/* ───── Speed limit ───── */
.dl-speedlimit {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 18px 22px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 24px;
  align-items: center;
}
.dl-speedlimit-text { min-width: 0; }
.dl-speedlimit-eyebrow {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
  margin-bottom: 4px;
}
.dl-speedlimit-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.dl-speedlimit-title strong { font-weight: 600; color: var(--accent-2); }
.dl-speedlimit-title .serif {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 14px;
  color: var(--text-secondary);
}
.dl-speedlimit-sub {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  margin-top: 4px;
  letter-spacing: 0.02em;
}
.dl-speedlimit-presets {
  display: inline-flex;
  gap: 4px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px;
}
.dl-speedlimit-presets button {
  background: transparent;
  border: none;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  padding: 6px 12px;
  border-radius: 999px;
  cursor: pointer;
  font-weight: 600;
  letter-spacing: 0.04em;
  transition: background 0.15s, color 0.15s;
}
.dl-speedlimit-presets button:hover { color: var(--text-primary); }
.dl-speedlimit-presets button.active { background: var(--accent); color: #0b0c0e; }

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

/* ───── Package row ───── */
.dl-pkg-list {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.dl-pkg {
  position: relative;
  display: grid;
  grid-template-columns: 56px 1fr auto auto;
  gap: 16px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
  align-items: center;
  transition: background 0.15s;
}
.dl-pkg:last-child { border-bottom: none; }
.dl-pkg { cursor: pointer; }
.dl-pkg:hover { background: var(--surface-2); }
.dl-pkg:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.dl-pkg.has-error::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--err);
}

.dl-pkg-body { min-width: 0; }
.dl-pkg-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.dl-pkg-title .name {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.dl-pkg-title .year {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 14px;
  color: var(--text-secondary);
}
.dl-pkg-filename {
  margin-top: 3px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.dl-pkg-meta {
  margin-top: 7px;
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  align-items: center;
}
.dl-pkg-meta strong { color: var(--text-secondary); font-weight: 500; }
.dl-pkg-meta .pip { color: var(--text-3); opacity: 0.6; }
.dl-pkg-meta .pct { color: var(--stage-downloading); font-weight: 600; }
.dl-pkg-meta .pct.extracting { color: var(--stage-extracting); }
.dl-pkg-meta .pct.moved, .dl-pkg-meta .pct.finished { color: var(--stage-library); }
.dl-pkg-meta .pct.error { color: var(--err); }

.dl-pkg-progress {
  margin-top: 9px;
  height: 4px;
  background: var(--surface-3);
  border-radius: 999px;
  overflow: hidden;
  width: 100%;
  max-width: 480px;
  position: relative;
}
.dl-pkg-progress .fill {
  height: 100%;
  background: linear-gradient(90deg, var(--stage-color, var(--stage-downloading)), color-mix(in srgb, var(--stage-color, var(--stage-downloading)) 50%, #fff));
  border-radius: 999px;
  position: relative;
  transition: width 0.5s ease;
}
.dl-pkg-progress .fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.25), transparent);
  animation: dlShimmer 2.4s linear infinite;
}
.dl-pkg-progress.error .fill { background: var(--err); animation: none; }
.dl-pkg-progress.error .fill::after { display: none; }

.dl-pkg-stage {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 11px 4px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid color-mix(in srgb, var(--stage-color) 30%, transparent);
  background: color-mix(in srgb, var(--stage-color) 8%, transparent);
  color: var(--stage-color);
  white-space: nowrap;
}
.dl-pkg-stage .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.dl-pkg-stage.active .dot {
  box-shadow: 0 0 6px currentColor;
  animation: dlPulse 1.5s ease-in-out infinite;
}

.dl-pkg-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.dl-pkg:hover .dl-pkg-actions { opacity: 1; }

/* ───── LinkGrabber ───── */
.dl-lg-list {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.dl-lg-row {
  display: grid;
  grid-template-columns: 30px 1fr auto auto;
  gap: 14px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
  align-items: center;
}
.dl-lg-row:last-child { border-bottom: none; }
.dl-lg-row:hover { background: var(--surface-2); }
.dl-lg-pos {
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
  text-align: center;
}
.dl-lg-name {
  font-size: 13.5px;
  color: var(--text-primary);
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.dl-lg-name .title {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dl-lg-name .year {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 13px;
  color: var(--text-secondary);
}
.dl-lg-quality {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-3);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 5px;
  letter-spacing: 0.04em;
}
.dl-lg-size {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.dl-lg-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.dl-lg-row:hover .dl-lg-actions { opacity: 1; }

/* ───── Disk usage strip ───── */
.dl-disks {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.dl-disk {
  background: var(--surface);
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dl-disk-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.dl-disk-path {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  font-weight: 600;
  letter-spacing: 0.01em;
}
.dl-disk-free {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.dl-disk-free strong { color: var(--ok); font-weight: 600; }
.dl-disk-bar {
  height: 4px;
  background: var(--surface-3);
  border-radius: 999px;
  overflow: hidden;
}
.dl-disk-bar .fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  border-radius: 999px;
  transition: width 0.4s ease;
}
.dl-disk-bar .fill.warn { background: linear-gradient(90deg, var(--warn), #ffd068); }
.dl-disk-bar .fill.err { background: linear-gradient(90deg, var(--err), #ffb3a8); }
.dl-disk-foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.dl-disk-foot strong { color: var(--text-secondary); }

/* ───── Animations ───── */
@keyframes dlPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}
@keyframes dlDotPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@keyframes dlShimmer {
  from { transform: translateX(-100%); }
  to { transform: translateX(100%); }
}
@keyframes dlFadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.fade-in { animation: dlFadeIn 0.3s ease; }

/* ───── Responsive ───── */
@media (max-width: 1100px) {
  .dl-hero, .dl-hero-idle-body { grid-template-columns: 1fr; }
  .dl-stats { grid-template-columns: repeat(2, 1fr); }
  .dl-disks { grid-template-columns: 1fr; }
}
@media (max-width: 768px) {
  .dl-header { flex-direction: column; align-items: stretch; }
  .dl-header-tools { flex-wrap: wrap; }
  .dl-stats { grid-template-columns: 1fr 1fr; }
  .dl-pkg { grid-template-columns: 48px 1fr; }
  .dl-pkg-stage, .dl-pkg-actions { grid-column: 1 / -1; }
  .dl-pkg-actions { opacity: 1; }
  .dl-lg-actions { opacity: 1; }
  .dl-speedlimit { grid-template-columns: 1fr; gap: 14px; }
  .dl-hero-current { grid-template-columns: 48px 1fr; }
  .dl-hero-current-pct { grid-column: 1 / -1; text-align: right; }
  .dl-hero-idle-cta { align-items: stretch; }
}
</style>
