<template>
  <div class="qx-active-card" :class="{ waiting: isWaiting }" :style="{ '--stage-color': stageColor }">
    <div class="qx-active-glow"></div>
    <MoviePoster
      :imdb-id="movie.imdb_id"
      :title="movie.title"
      :year="movie.year"
      class="poster"
    />
    <div class="qx-active-body">
      <div class="qx-active-eyebrow">
        <span class="dot"></span>
        {{ stageLabel }} · {{ subStatus }}
      </div>
      <div class="qx-active-title">
        {{ movie.title }}<span class="year">{{ movie.year }}</span>
      </div>
      <div class="qx-active-bar">
        <div class="fill" :style="{ width: progress + '%' }"></div>
      </div>
      <div class="qx-active-stats">
        <span class="pct">{{ progress }}%</span>
        <span v-if="loadedGB"><strong>{{ loadedGB }}</strong> / {{ totalGB }} GB</span>
        <span v-if="speedText"><strong>{{ speedText }}</strong></span>
        <span v-if="etaText">ETA <strong>{{ etaText }}</strong></span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Movie, DownloadPackage } from '../../types/index';
import { formatSpeed, formatEta } from '../../composables/useFormatters';
import MoviePoster from '../MoviePoster.vue';

const props = defineProps<{
  movie: Movie;
  /** Matching JDownloader package, if found by title-prefix lookup */
  pkg?: DownloadPackage | null;
  /** 0..1 progress fraction from useDownloadPolling map */
  progressFraction?: number;
  /** Whether the matching JD package is currently in extraction (post-download). */
  isExtracting?: boolean;
}>();

const isExtracting = computed(() => !!props.isExtracting);
// A movie's DB status is 'downloading' the moment it's handed to JDownloader —
// but JD may still have it queued, not actively pulling bytes. Only JD's live
// `running` flag means "läuft". Without it the package is waiting in JD's queue,
// so don't claim it's downloading (mirrors the Downloads page's Lädt/Wartet).
const isRunning = computed(() => !!props.pkg?.running);
const isWaiting = computed(() => !isExtracting.value && !isRunning.value && !props.pkg?.finished);

const stageLabel = computed(() => {
  if (isExtracting.value) return 'ENTPACKT';
  if (isWaiting.value) return 'WARTET';
  return 'LÄDT';
});
const stageColor = computed(() => {
  if (isExtracting.value) return 'var(--stage-extracting)';
  if (isWaiting.value) return 'var(--stage-pending)';
  return 'var(--stage-downloading)';
});
const subStatus = computed(() => {
  if (isExtracting.value) return 'finaler Schritt';
  if (isWaiting.value) return 'in JDownloader';
  return 'läuft';
});

const progress = computed(() => {
  if (typeof props.progressFraction === 'number') return Math.round(props.progressFraction * 100);
  if (props.pkg?.bytesTotal) return Math.round((props.pkg.bytesLoaded / props.pkg.bytesTotal) * 100);
  if (isExtracting.value && props.pkg?.extractionProgress != null) return props.pkg.extractionProgress;
  return 0;
});

const loadedGB = computed(() => {
  if (!props.pkg?.bytesLoaded) return '';
  return (props.pkg.bytesLoaded / (1024 ** 3)).toFixed(1);
});
const totalGB = computed(() => {
  if (!props.pkg?.bytesTotal) return '';
  return (props.pkg.bytesTotal / (1024 ** 3)).toFixed(1);
});
const speedText = computed(() => {
  if (!props.pkg?.speed) return '';
  return formatSpeed(props.pkg.speed);
});
const etaText = computed(() => {
  if (!props.pkg?.eta || props.pkg.eta <= 0) return '';
  return formatEta(props.pkg.eta);
});
</script>

<style scoped>
.qx-active-card {
  position: relative;
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 18px;
  align-items: center;
  padding: 18px 20px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.qx-active-glow {
  position: absolute;
  inset: 0;
  background: radial-gradient(420px 160px at 0% 30%, color-mix(in srgb, var(--stage-color) 10%, transparent), transparent 70%);
  pointer-events: none;
}

.poster {
  /* Override MoviePoster default size for this hero slot */
  width: 88px !important;
  height: 132px !important;
  position: relative;
  z-index: 1;
}

.qx-active-body {
  position: relative;
  z-index: 1;
  min-width: 0;
}

.qx-active-eyebrow {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--stage-color);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.qx-active-eyebrow .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--stage-color);
  box-shadow: 0 0 6px var(--stage-color);
  animation: qxPulse 1.2s ease-in-out infinite;
}
@keyframes qxPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.4; transform: scale(0.85); }
}
/* Waiting in JD's queue isn't active — hold the dot and progress shimmer still. */
.qx-active-card.waiting .qx-active-eyebrow .dot { animation: none; }
.qx-active-card.waiting .qx-active-bar .fill::after { animation: none; }

.qx-active-title {
  margin-top: 4px;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.qx-active-title .year {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 15px;
  color: var(--text-secondary);
}

.qx-active-bar {
  margin-top: 12px;
  height: 5px;
  background: var(--surface-3);
  border-radius: 999px;
  overflow: hidden;
  position: relative;
}
.qx-active-bar .fill {
  height: 100%;
  background: linear-gradient(90deg, var(--stage-color), color-mix(in srgb, var(--stage-color) 50%, #fff));
  border-radius: 999px;
  position: relative;
  transition: width 0.5s ease;
}
.qx-active-bar .fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.25), transparent);
  animation: qxShimmer 2s linear infinite;
}
@keyframes qxShimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }

.qx-active-stats {
  margin-top: 8px;
  display: flex;
  gap: 18px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
  color: var(--text-secondary);
  flex-wrap: wrap;
}
.qx-active-stats strong { color: var(--text-primary); font-weight: 600; }
.qx-active-stats .pct { color: var(--stage-color); font-weight: 600; font-size: 12.5px; }

@media (max-width: 768px) {
  .qx-active-card { grid-template-columns: 64px 1fr; gap: 12px; padding: 14px; }
  .poster { width: 64px !important; height: 96px !important; }
  .qx-active-title { font-size: 15px; }
}
</style>
