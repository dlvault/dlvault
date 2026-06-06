<template>
  <!-- Active hero — Pipeline-Überblick (JDownloader + Musik direkt) -->
  <div v-if="anyPipelineActive" class="dl-hero fade-in">
    <div class="dl-hero-main">
      <div class="dl-hero-eyebrow">
        <span class="dot"></span>
        {{ downloadingPkgs.length > 0 || hasMusicActive ? 'Downloads laufen' : extractingPkgs.length > 0 ? 'Entpacken' : 'Aktiv' }}
        · {{ pipelineCount }} Pipeline{{ pipelineCount !== 1 ? 's' : '' }}
      </div>
      <div class="dl-hero-title-row">
        <div class="dl-hero-speed">
          <template v-if="combinedMbps > 0">{{ combinedMbps.toFixed(1) }}<span class="unit">MB/s</span></template>
          <template v-else>—<span class="unit">{{ hasMusicActive ? 'Musik lädt' : 'idle' }}</span></template>
        </div>
        <div v-if="hasJdActive && speedLimitEnabled && speedLimitKbps > 0" class="dl-hero-limit-mark">
          Limit <span class="bar"></span> <strong>{{ (speedLimitKbps / 1024).toFixed(0) }} MB/s</strong>
        </div>
      </div>

      <!-- Pipeline-Aufschlüsselung — nur aktive Pipelines. -->
      <div class="dl-hero-pipes">
        <div v-if="hasJdActive" class="dl-pipe">
          <span class="dl-pipe-ico"><Boxes :size="15" /></span>
          <div class="dl-pipe-txt">
            <span class="dl-pipe-lbl">JDownloader</span>
            <span class="dl-pipe-val">
              <strong>{{ totalMbps > 0 ? totalMbps.toFixed(1) + ' MB/s' : 'wartet' }}</strong>
              · {{ packages.length }} Paket{{ packages.length !== 1 ? 'e' : '' }}
            </span>
          </div>
        </div>
        <div v-if="hasMusicActive" class="dl-pipe">
          <span class="dl-pipe-ico music"><Music :size="15" /></span>
          <div class="dl-pipe-txt">
            <span class="dl-pipe-lbl">Musik direkt</span>
            <span class="dl-pipe-val">
              <strong>{{ musicSpeedBytes > 0 ? formatSpeed(musicSpeedBytes) : 'lädt' }}</strong>
              · {{ activeMusicCount }} aktiv
            </span>
          </div>
        </div>
      </div>

      <div v-if="hasJdActive" class="dl-hero-subline">
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
        <MoviePoster :imdb-id="matchMovie(featured)?.imdb_id" :title="parsed(featured.name).title" :year="parsed(featured.name).year" size="md" />
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
          <span>{{ queueCount }} Paket{{ queueCount !== 1 ? 'e' : '' }} in der Warteschlange</span>
          <template v-if="downloadsFreeGb !== null">
            <span class="pip">·</span>
            <span><strong>{{ fmtDiskGB(downloadsFreeGb) }}</strong> frei in /downloads</span>
          </template>
        </div>
      </div>
      <div class="dl-hero-idle-cta">
        <button class="btn btn-primary" @click="$emit('start')"><Play :size="14" /> Downloads starten</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DownloadPackage } from '../../types/index';
import { useMoviesStore } from '../../stores/movies';
import { useMusicStore } from '../../stores/music';
import { formatBytes, formatSpeed, formatEta } from '../../composables/useFormatters';
import {
  stageOf, pct, parsed, quality, truncate, fmtDiskGB,
  matchMovie as matchMovieIn, activeMusicDownloads,
} from './downloadPackage';
import MoviePoster from '../MoviePoster.vue';
import { Play, Boxes, Music } from 'lucide-vue-next';

const props = defineProps<{
  packages: DownloadPackage[];
  speedLimitEnabled: boolean;
  speedLimitKbps: number;
  queueCount: number;
  downloadsFreeGb: number | null;
}>();

defineEmits<{ (e: 'start'): void }>();

const moviesStore = useMoviesStore();
const musicStore = useMusicStore();

function matchMovie(pkg: DownloadPackage) {
  return matchMovieIn(pkg, moviesStore.movies);
}

const downloadingPkgs = computed(() => props.packages.filter(p => stageOf(p).key === 'downloading'));
const extractingPkgs = computed(() => props.packages.filter(p => stageOf(p).key === 'extracting'));

// ── Pipeline-Überblick (JDownloader + Musik als getrennte Pipelines) ──
const activeMusic = computed(() => activeMusicDownloads(musicStore.downloads));
const activeMusicCount = computed(() => activeMusic.value.length);
const hasJdActive = computed(() => props.packages.length > 0);
const hasMusicActive = computed(() => activeMusicCount.value > 0);
const anyPipelineActive = computed(() => hasJdActive.value || hasMusicActive.value);
const pipelineCount = computed(() => (hasJdActive.value ? 1 : 0) + (hasMusicActive.value ? 1 : 0));

// ── Hero aggregates ─────────────────────────────────────────
const totalSpeedBytes = computed(() => props.packages.reduce((s, p) => s + (p.speed || 0), 0));
const totalMbps = computed(() => totalSpeedBytes.value / (1024 * 1024));
const totalLoaded = computed(() => props.packages.reduce((s, p) => s + (p.bytesLoaded || 0), 0));
const totalSize = computed(() => props.packages.reduce((s, p) => s + (p.bytesTotal || 0), 0));
// True "everything left in the download list" ETA, not just the one actively
// downloading package. The old Math.max(active etas) ignored every WAITING
// package, so with one active download it showed only that film's remaining time
// while labelled "Gesamt-ETA" — e.g. "11m" next to a 200 GB queue that really
// needs hours. Total remaining bytes (active + waiting) over the current
// aggregate throughput gives the honest figure.
const totalEta = computed(() => {
  const remaining = totalSize.value - totalLoaded.value;
  return totalSpeedBytes.value > 0 && remaining > 0
    ? Math.round(remaining / totalSpeedBytes.value)
    : 0;
});

// ── Musik-Pipeline-Durchsatz (nur aktive Downloads) ─────────
const musicSpeedBytes = computed(() =>
  activeMusic.value.reduce((s, d) => s + (d.speedBps || 0), 0),
);
// Combined headline throughput across both pipelines (JDownloader + Musik).
const combinedMbps = computed(() => totalMbps.value + musicSpeedBytes.value / (1024 * 1024));

// Featured package for the hero card
const featured = computed(() =>
  downloadingPkgs.value[0] || extractingPkgs.value[0] || props.packages[0] || null
);
</script>

<style scoped>
/* ───── Hero ───── */
.dl-hero {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 24px 26px;
  overflow: hidden;
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
.dl-hero-main { position: relative; z-index: 1; }

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

/* Pipeline-Aufschlüsselung (JDownloader / Musik direkt) */
.dl-hero-pipes {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 16px;
}
.dl-pipe {
  display: inline-flex;
  align-items: center;
  gap: 11px;
  padding: 10px 15px 10px 11px;
  border-radius: var(--r-md);
  border: 1px solid var(--line);
  background: var(--surface-2);
  min-width: 0;
}
.dl-pipe-ico {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent-2);
  flex-shrink: 0;
}
.dl-pipe-ico.music {
  background: color-mix(in srgb, var(--stage-downloading) 14%, transparent);
  color: var(--stage-downloading);
}
.dl-pipe-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dl-pipe-lbl {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-3);
}
.dl-pipe-val {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dl-pipe-val strong { color: var(--text-primary); font-weight: 600; }

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

/* ───── Animations ───── */
@keyframes dlPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}
@keyframes dlFadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.fade-in { animation: dlFadeIn 0.3s ease; }
/* ───── Responsive ───── */
@media (max-width: 1100px) {
  .dl-hero, .dl-hero-idle-body { grid-template-columns: 1fr; }
}
@media (max-width: 768px) {
  .dl-hero-current { grid-template-columns: 48px 1fr; position: relative; }
  .dl-hero-current-pct { position: absolute; top: 12px; right: 14px; font-size: 18px; }
  .dl-hero-idle-cta { align-items: stretch; }
}
</style>
