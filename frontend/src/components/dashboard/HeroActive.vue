<template>
  <div class="hero fade-in">
    <div class="hero-glow"></div>
    <div class="hero-inner">
      <div class="hero-active">
        <MoviePoster
          :imdb-id="primary?.imdbId"
          :title="primary?.title || 'Download'"
          :year="primary?.year"
          :rating="primary?.quality"
          size="lg"
        />
        <div class="hero-meta">
          <div class="hero-eyebrow">
            <span class="dot"></span>
            Lädt{{ activeCount > 1 ? ' · ' + activeCount + ' aktiv' : '' }}
          </div>
          <h2 class="hero-title">
            {{ primary?.title || '—' }}<span v-if="primary?.year" class="year">{{ primary.year }}</span>
          </h2>
          <div v-if="primary" class="hero-progress">
            <div class="hero-bar"><div class="hero-bar-fill" :style="{ width: primary.progress + '%' }"></div></div>
            <div class="hero-stats">
              <span class="pct">{{ primary.progress }}%</span>
              <span v-if="primary.loadedGB"><strong>{{ primary.loadedGB.toFixed(1) }}</strong> / {{ primary.totalGB?.toFixed(1) }} GB</span>
              <span v-if="primary.speed"><strong>{{ primary.speed }}</strong></span>
              <span v-if="primary.eta">ETA <strong>{{ primary.eta }}</strong></span>
            </div>
          </div>
          <div class="hero-strip">
            <div v-if="upNext" class="hero-strip-item with-poster">
              <MoviePoster :imdb-id="upNext.imdbId" :title="upNext.title" :year="upNext.year" size="xs" />
              <div>
                <div class="lbl">Als Nächstes</div>
                <div class="val"><em>{{ upNext.title }}</em><span v-if="upNext.statusLabel"> · {{ upNext.statusLabel }}</span></div>
              </div>
            </div>
            <div v-if="lastFinished" class="hero-strip-item with-poster">
              <MoviePoster :imdb-id="lastFinished.imdbId" :title="lastFinished.title" :year="lastFinished.year" size="xs" />
              <div>
                <div class="lbl">Zuletzt fertig</div>
                <div class="val ok"><em>{{ lastFinished.title }}</em> · {{ lastFinished.when }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import MoviePoster from '../MoviePoster.vue';

interface ActiveItem {
  imdbId?: string | null;
  title: string;
  year?: number;
  quality?: string;
  progress: number;
  loadedGB?: number;
  totalGB?: number;
  speed?: string;
  eta?: string;
}
interface HeroStripItem {
  imdbId?: string | null;
  title: string;
  year?: number;
  statusLabel?: string;
}

defineProps<{
  primary: ActiveItem | null;
  upNext: HeroStripItem | null;
  lastFinished: (HeroStripItem & { when: string }) | null;
  activeCount: number;
}>();
</script>

<style scoped>
.hero {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.hero-glow {
  position: absolute;
  inset: 0;
  background: radial-gradient(600px 240px at 12% 20%, rgba(183, 148, 244, 0.10), transparent 70%);
  pointer-events: none;
}
.hero-inner {
  position: relative;
  padding: 26px 28px;
}
.hero-active {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 22px;
  align-items: center;
}
.hero-meta { min-width: 0; }
.hero-eyebrow {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--busy);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.hero-eyebrow .dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--busy);
  box-shadow: 0 0 8px var(--busy);
  animation: pulse 1.2s ease-in-out infinite;
}
.hero-title {
  margin-top: 6px;
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.15;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.hero-title .year {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 22px;
  color: var(--text-secondary);
}
.hero-progress {
  margin-top: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hero-bar {
  height: 6px;
  background: var(--surface-3);
  border-radius: 999px;
  overflow: hidden;
  position: relative;
}
.hero-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--busy), #d4b6ff);
  border-radius: 999px;
  position: relative;
  transition: width 0.5s ease;
}
.hero-bar-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.25), transparent);
  animation: shimmer 2s linear infinite;
}
.hero-stats {
  display: flex;
  gap: 22px;
  flex-wrap: wrap;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--text-secondary);
}
.hero-stats strong { color: var(--text-primary); font-weight: 600; }
.hero-stats .pct { color: var(--busy); font-weight: 600; font-size: 14px; }
.hero-strip {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px dashed var(--line);
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  font-size: 12px;
}
.hero-strip-item { display: flex; flex-direction: column; gap: 4px; }
.hero-strip-item.with-poster { flex-direction: row; align-items: center; gap: 10px; }
.hero-strip-item.with-poster > div {
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
.hero-strip-item .val em {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: var(--accent-2);
  font-size: 13px;
}
.hero-strip-item .lbl {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-3);
}
.hero-strip-item .val { color: var(--text-primary); font-weight: 500; }
.hero-strip-item .val.ok { color: var(--ok); }

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.85); }
}
@keyframes shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.fade-in { animation: fadeIn 0.3s ease; }

@media (max-width: 768px) {
  .hero-inner { padding: 20px; }
  .hero-active { grid-template-columns: 84px 1fr; gap: 14px; align-items: start; }
  .hero-active :deep(.size-lg) { width: 84px; height: 126px; }
  .hero-title { font-size: 22px; }
  .hero-stats { gap: 12px 16px; }
}
</style>
