<template>
  <div class="dl-pkg-list">
    <div
      v-for="pkg in packages"
      :key="pkg.uuid"
      :class="['dl-pkg', { 'has-error': stageOf(pkg).key === 'error' }]"
      :style="{ '--stage-color': stageOf(pkg).color }"
      role="button"
      tabindex="0"
      @click="$emit('open', pkg)"
      @keydown.enter="$emit('open', pkg)"
    >
      <MoviePoster :imdb-id="matchMovie(pkg)?.imdb_id" :title="parsed(pkg.name).title" :year="parsed(pkg.name).year" size="md" />
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
        <!-- WHY it failed (JD's own status text) + what happens next. The
             post-processor removes errored packages automatically, blocks
             the release and starts a fresh search — say so instead of
             leaving a mute red border. -->
        <div v-if="stageOf(pkg).key === 'error'" class="dl-pkg-error">
          <AlertTriangle :size="12" />
          <span class="msg">{{ pkg.status || 'Unbekannter Fehler' }}</span>
          <span class="hint">wird automatisch entfernt, Release geblockt &amp; neue Quelle gesucht</span>
        </div>
      </div>
      <span :class="['dl-pkg-stage', { active: stageOf(pkg).key === 'downloading' || stageOf(pkg).key === 'extracting' }]">
        <span class="dot"></span>
        {{ stageOf(pkg).label }}
      </span>
      <div class="dl-pkg-actions">
        <button class="icon-btn danger" title="Entfernen" @click.stop="$emit('remove', pkg)"><Trash2 :size="14" /></button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { DownloadPackage } from '../../types/index';
import { useMoviesStore } from '../../stores/movies';
import { formatBytes, formatSpeed, formatEta } from '../../composables/useFormatters';
import { stageOf, pct, parsed, matchMovie as matchMovieIn } from './downloadPackage';
import MoviePoster from '../MoviePoster.vue';
import { Trash2, AlertTriangle } from 'lucide-vue-next';

defineProps<{ packages: DownloadPackage[] }>();

defineEmits<{
  (e: 'open', pkg: DownloadPackage): void;
  (e: 'remove', pkg: DownloadPackage): void;
}>();

const moviesStore = useMoviesStore();

function matchMovie(pkg: DownloadPackage) {
  return matchMovieIn(pkg, moviesStore.movies);
}
</script>

<style scoped>
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

.dl-pkg-error {
  margin-top: 8px;
  display: flex;
  align-items: baseline;
  gap: 7px;
  flex-wrap: wrap;
  font-size: 12px;
  line-height: 1.4;
}
.dl-pkg-error svg { color: var(--err); flex-shrink: 0; align-self: center; }
.dl-pkg-error .msg { color: var(--err); font-weight: 500; }
.dl-pkg-error .hint { color: var(--text-3); }
.dl-pkg-error .hint::before { content: '— '; }

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

/* ───── Animations ───── */
@keyframes dlPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}
@keyframes dlShimmer {
  from { transform: translateX(-100%); }
  to { transform: translateX(100%); }
}
/* ───── Responsive ───── */
@media (max-width: 768px) {
  .dl-pkg { grid-template-columns: 48px 1fr; position: relative; }
  .dl-pkg-stage, .dl-pkg-actions { grid-column: 1 / -1; }
  /* Compact: lift the % out of the meta row into the card's top-right corner */
  .dl-pkg-meta .pct { position: absolute; top: 12px; right: 12px; font-size: 13px; font-weight: 600; }
  .dl-pkg-meta .pip:last-of-type { display: none; }
  .dl-pkg-actions { opacity: 1; }
}
</style>
