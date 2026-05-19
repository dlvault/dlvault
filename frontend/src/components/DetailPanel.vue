<template>
  <Teleport to="body">
    <div v-if="movie">
      <div class="panel-backdrop" @click="emitClose" />
      <aside
        ref="panelRoot"
        class="panel"
        role="dialog"
        aria-modal="true"
        :aria-label="movie.title"
        :style="{ '--stage-color': stage.color }"
      >
        <!-- Context badge — where the panel was opened from -->
        <div class="panel-context">
          <component :is="ctx.icon" :size="10" /> {{ ctx.label }}
        </div>
        <button class="panel-close" @click="emitClose" aria-label="Schließen"><X :size="14" /></button>

        <!-- HERO — always -->
        <div class="panel-hero" :style="{ '--hero-bg': heroGradient }">
          <div class="panel-poster">
            <MoviePoster :imdb-id="movie.imdb_id" :title="movie.title" :year="movie.year" size="lg" />
          </div>
          <div class="panel-head-text">
            <div :class="['panel-eyebrow', { pulse: isActive }]">
              <span class="dot" />
              {{ stage.mono }}<template v-if="movie.added && context === 'library'"> · {{ movie.added }}</template>
            </div>
            <div class="panel-title">
              {{ movie.title }}<span v-if="movie.year" class="year">{{ movie.year }}</span>
            </div>
            <div class="panel-meta">
              <template v-if="movie.rating != null">
                <span class="rating">★ {{ movie.rating.toFixed(1) }}</span>
                <span class="pip">·</span>
              </template>
              <template v-if="movie.runtime">
                <span>{{ movie.runtime }}</span>
                <span class="pip">·</span>
              </template>
              <span v-if="movie.quality === '4K'" class="pill-4k">4K</span>
              <span v-else-if="movie.quality">{{ movie.quality }}</span>
            </div>
          </div>
        </div>

        <div class="panel-body">
          <!-- ACTIONS — primary varies by context -->
          <div class="panel-actions">
            <button class="btn btn-primary" @click="onPrimary">
              <component :is="ctx.primaryIcon" :size="14" /> {{ ctx.primaryAction }}
            </button>
            <button v-if="context === 'queue' && movie.status !== 'not_found'" class="btn btn-ghost" @click="$emit('research', movie)">
              <RefreshCw :size="14" />Neu suchen
            </button>
            <button v-else-if="context === 'downloads'" class="btn btn-ghost" @click="$emit('changeSource', movie)">
              <Cloud :size="14" />Quelle wechseln
            </button>
            <button class="btn btn-danger" @click="$emit('delete', movie)"><Trash2 :size="14" />Löschen</button>
          </div>

          <!-- GENRES + PLOT — when plot set -->
          <div v-if="movie.plot" class="panel-section">
            <div v-if="movie.genres && movie.genres.length" class="panel-genres">
              <span v-for="g in movie.genres" :key="g">{{ g }}</span>
            </div>
            <p class="panel-plot">{{ movie.plot }}</p>
          </div>

          <!-- LIVE PROGRESS — when downloading/extracting -->
          <div v-if="showLiveProgress && movie.progress" class="panel-section">
            <div class="panel-section-label">
              {{ movie.status === 'extracting' ? 'Entpacken' : 'Download' }}
              <span class="ctx">live</span>
            </div>
            <div class="live-progress">
              <div class="live-progress-head">
                <div class="live-progress-pct">{{ movie.progress.pct }}%</div>
                <div class="live-progress-meta">
                  <template v-if="movie.progress.speed && movie.progress.speed > 0">
                    <strong>{{ movie.progress.speed }} MB/s</strong><template v-if="movie.progress.eta"> · ETA {{ movie.progress.eta }}</template>
                  </template>
                  <strong v-else>{{ movie.progress.parts || 'läuft' }}</strong>
                </div>
              </div>
              <div class="live-progress-bar">
                <div class="fill" :style="{ width: movie.progress.pct + '%' }" />
              </div>
              <div class="live-progress-foot">
                <span>{{ movie.progress.loaded }} / {{ movie.progress.total }} GB</span>
                <span class="release">{{ movie.progress.release }}</span>
              </div>
            </div>
          </div>

          <!-- PIPELINE — when not finished -->
          <div v-if="showPipeline" class="panel-section">
            <div class="panel-section-label">
              Pipeline
              <span class="ctx">{{ stage.mono }}</span>
            </div>
            <div class="pipeline">
              <div v-for="(step, i) in pipelineSteps" :key="step.key" :class="['pipeline-step', step.state]">
                <div class="pipeline-dot">
                  <Check v-if="step.state === 'done'" :size="10" />
                  <span v-else-if="step.state === 'active'" class="active-dot" />
                </div>
                <div class="pipeline-text">
                  <div class="pipeline-name">{{ step.label }}</div>
                  <div v-if="step.detail" class="pipeline-detail">{{ step.detail }}</div>
                </div>
                <div class="pipeline-time">
                  <template v-if="step.state === 'done'">✓</template>
                  <template v-else-if="step.state === 'active'">jetzt</template>
                  <template v-else>—</template>
                </div>
              </div>
            </div>
          </div>

          <!-- SEARCH CANDIDATES — when searching with results -->
          <div v-if="showCandidates && movie.candidates" class="panel-section">
            <div class="panel-section-label">
              Suchergebnisse
              <span class="ctx">{{ movie.candidates.length }} Kandidaten</span>
            </div>
            <div class="candidates">
              <div v-for="(c, i) in movie.candidates" :key="i" :class="['candidate', { found: c.found }]">
                <span class="source-icon">
                  <Check v-if="c.found" :size="14" /><Cloud v-else :size="14" />
                </span>
                <span class="name">{{ c.name }}</span>
                <span class="when">{{ c.when }}</span>
              </div>
            </div>
          </div>

          <!-- FILE — when something exists on disk -->
          <div v-if="showFile && movie.file" class="panel-section">
            <div class="panel-section-label">Datei</div>
            <dl class="panel-kv">
              <template v-if="movie.file.path">
                <dt>Pfad</dt>
                <dd class="mono">{{ movie.file.path }}</dd>
              </template>
              <template v-if="movie.quality || movie.file.codec || movie.file.container">
                <dt>Qualität</dt>
                <dd>
                  <span v-if="movie.quality" :class="['pill', { 'is-4k': movie.quality === '4K' }]">{{ movie.quality }}</span>
                  <template v-if="movie.file.container"> {{ movie.file.container.toUpperCase() }}</template>
                  <template v-if="movie.file.codec"> · {{ movie.file.codec }}</template>
                </dd>
              </template>
              <template v-if="movie.file.size">
                <dt>Größe</dt>
                <dd>{{ movie.file.size }}</dd>
              </template>
              <dt>Quelle</dt>
              <dd>{{ movie.file.src }}</dd>
            </dl>
          </div>

          <!-- PRODUCTION — when set (typically library) -->
          <div v-if="movie.production" class="panel-section">
            <div class="panel-section-label">Produktion</div>
            <dl class="panel-kv">
              <dt>Regie</dt>
              <dd>{{ movie.production.director }}</dd>
              <dt>Studio</dt>
              <dd>{{ movie.production.studio }}</dd>
              <dt>Land</dt>
              <dd>{{ movie.production.country }}</dd>
            </dl>
          </div>

          <!-- ERROR NOTICE — when not_found -->
          <div v-if="movie.status === 'not_found'" class="panel-section">
            <div class="panel-error">
              <AlertTriangle :size="16" />
              <div>
                <strong>Keine passende Quelle gefunden</strong>
                <p>Die Suche lieferte kein nutzbares Release. Starte eine neue Suche oder passe die Qualitätsfilter an.</p>
              </div>
            </div>
          </div>

          <!-- ACTIVITY LOG — always, collapsible -->
          <div :class="['activity', { open: activityOpen }]">
            <div class="activity-head" @click="activityOpen = !activityOpen">
              <div class="lbl">Aktivität <strong>{{ movie.activity?.length || 0 }} Events</strong></div>
              <ChevronRight class="chevron" :size="14" />
            </div>
            <div class="activity-list">
              <div v-for="(a, i) in movie.activity" :key="i" class="activity-item">
                <span class="activity-time">{{ a.time }}</span>
                <span class="activity-text">{{ a.text }}</span>
                <span :class="['activity-action', a.tone]">{{ a.action }}</span>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import MoviePoster from './MoviePoster.vue';
import { useModalA11y } from '../composables/useModalA11y';
import type { DetailContext, MovieStatus, PanelMovie } from '../types/index';
import {
  X, Check, RefreshCw, Play, Pause, Trash2,
  ChevronRight, Cloud, AlertTriangle, ListOrdered, Library, Download,
} from 'lucide-vue-next';

const props = defineProps<{
  movie: PanelMovie | null;
  context: DetailContext;
}>();

const emit = defineEmits<{
  close: [];
  retry: [id: number | string];
  delete: [movie: PanelMovie];
  pause: [id: number | string];
  openInJellyfin: [movie: PanelMovie];
  research: [movie: PanelMovie];
  changeSource: [movie: PanelMovie];
}>();

const panelRoot = ref<HTMLElement>();
const activityOpen = ref(true);
const visible = computed(() => !!props.movie);
useModalA11y(visible, panelRoot);

// Reset the collapsible to its default each time a new movie opens.
watch(() => props.movie?.id, () => { activityOpen.value = true; });

function emitClose() { emit('close'); }

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.movie) emitClose();
}
watch(visible, (now) => {
  if (now) window.addEventListener('keydown', onKeydown);
  else window.removeEventListener('keydown', onKeydown);
}, { immediate: true });
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

// ───── Stage metadata ─────
const STAGE: Record<MovieStatus, { label: string; mono: string; color: string }> = {
  pending:     { label: 'Wartet',          mono: 'PENDING',     color: 'var(--stage-pending)' },
  searching:   { label: 'Suche läuft',     mono: 'SEARCHING',   color: 'var(--stage-searching)' },
  found:       { label: 'Quelle gefunden', mono: 'FOUND',       color: 'var(--stage-found)' },
  downloading: { label: 'Lädt',            mono: 'DOWNLOADING', color: 'var(--stage-downloading)' },
  extracting:  { label: 'Entpackt',        mono: 'EXTRACTING',  color: 'var(--stage-extracting)' },
  moved:       { label: 'Verschoben',      mono: 'MOVED',       color: 'var(--stage-moved)' },
  downloaded:  { label: 'In Library',      mono: 'IN LIBRARY',  color: 'var(--stage-library)' },
  not_found:   { label: 'Nicht gefunden',  mono: 'NOT FOUND',   color: 'var(--stage-not_found)' },
  not_available:    { label: 'Noch nicht verfügbar',  mono: 'NOT YET AVAILABLE', color: 'var(--stage-not_available)' },
  no_download:      { label: 'Kein Download verfügbar', mono: 'NO DOWNLOAD',     color: 'var(--stage-no_download)' },
  quality_mismatch: { label: 'Keine passende Qualität', mono: 'WRONG QUALITY',   color: 'var(--stage-quality_mismatch)' },
};
const stage = computed(() => STAGE[props.movie?.status ?? 'pending']);

// ───── Context configuration ─────
const CONTEXTS: Record<DetailContext, { label: string; icon: unknown; primaryAction: string; primaryIcon: unknown }> = {
  queue:     { label: 'Warteschlange', icon: ListOrdered, primaryAction: 'Wiederholen',     primaryIcon: RefreshCw },
  library:   { label: 'Mediathek',     icon: Library,     primaryAction: 'Im Mediaserver öffnen', primaryIcon: Play },
  downloads: { label: 'Downloads',     icon: Download,    primaryAction: 'Pausieren',        primaryIcon: Pause },
};
const ctx = computed(() => CONTEXTS[props.context]);

function onPrimary() {
  if (!props.movie) return;
  if (props.context === 'queue') emit('retry', props.movie.id);
  else if (props.context === 'library') emit('openInJellyfin', props.movie);
  else emit('pause', props.movie.id);
}

const isActive = computed(() => {
  const s = props.movie?.status;
  return s === 'downloading' || s === 'extracting' || s === 'searching';
});

// ───── Section visibility — driven purely by data ─────
const showPipeline = computed(() => props.movie && props.movie.status !== 'downloaded');
const showLiveProgress = computed(() => props.movie?.status === 'downloading' || props.movie?.status === 'extracting');
const showCandidates = computed(() => props.movie?.status === 'searching' && (props.movie?.candidates?.length || 0) > 0);
const showFile = computed(() => {
  const s = props.movie?.status;
  return !!props.movie?.file && (s === 'downloading' || s === 'extracting' || s === 'moved' || s === 'downloaded');
});

// ───── Pipeline timeline ─────
const PIPELINE_STAGES: { key: MovieStatus; label: string }[] = [
  { key: 'pending',     label: 'Wartet' },
  { key: 'searching',   label: 'Suche Quelle' },
  { key: 'downloading', label: 'Lädt' },
  { key: 'extracting',  label: 'Entpackt' },
  { key: 'moved',       label: 'Verschoben' },
  { key: 'downloaded',  label: 'In Library' },
];
// Map every status onto a timeline position. 'found'/'not_found' aren't their
// own rows, so they snap to the nearest meaningful stage.
const STAGE_RANK: Record<MovieStatus, number> = {
  pending: 0, searching: 1, found: 1, not_found: 1,
  not_available: 1, no_download: 1, quality_mismatch: 1,
  downloading: 2, extracting: 3, moved: 4, downloaded: 5,
};

const pipelineSteps = computed(() => {
  const m = props.movie;
  if (!m) return [];
  const currentIdx = STAGE_RANK[m.status];
  return PIPELINE_STAGES.map((s, i) => {
    const state = i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'future';
    let detail = '';
    if (state === 'active') {
      if (s.key === 'searching' && m.pipeline?.startedSearch) {
        detail = `läuft seit ${m.pipeline.startedSearch}${m.pipeline.attempt ? ` · Versuch ${m.pipeline.attempt}` : ''}`;
      } else if (s.key === 'pending' && m.pipeline?.stuck) {
        detail = `⚠ hängt · ${m.pipeline.attempts ?? 0} Versuche${m.pipeline.lastChecked ? ` · zuletzt ${m.pipeline.lastChecked}` : ''}`;
      } else if (s.key === 'downloading' && m.progress) {
        detail = `${m.progress.pct}% · ${m.progress.loaded}/${m.progress.total} GB${m.progress.speed ? ` · ${m.progress.speed} MB/s` : ''}`;
      } else if (s.key === 'extracting' && m.progress) {
        detail = `${m.progress.pct}% · ${m.progress.parts || 'läuft'}`;
      }
    }
    return { key: s.key, label: s.label, state, detail };
  });
});

const POSTER_GRADIENTS = [
  'linear-gradient(160deg, #1a3a5c 0%, #0d1a2c 70%, #2a1a3a 100%)',
  'linear-gradient(150deg, #3a1a2c 0%, #1a0d1a 60%, #2a1f3a 100%)',
  'linear-gradient(160deg, #2c3a1a 0%, #1a2c0d 70%, #1f3a2a 100%)',
  'linear-gradient(140deg, #3a2c1a 0%, #1a1a0d 60%, #3a1a1f 100%)',
  'linear-gradient(170deg, #1a2c3a 0%, #0d1a2c 60%, #1a1f3a 100%)',
  'linear-gradient(155deg, #3a1a3a 0%, #1a0d2c 70%, #1a2c3a 100%)',
  'linear-gradient(145deg, #2c1a3a 0%, #0d1a1a 70%, #3a2c1a 100%)',
  'linear-gradient(165deg, #1a3a3a 0%, #0d1a1a 60%, #1a2c3a 100%)',
];
const heroGradient = computed(() => {
  const seed = props.movie?.title ?? '';
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return POSTER_GRADIENTS[h % POSTER_GRADIENTS.length];
});
</script>

<style scoped>
.panel-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(11, 12, 14, 0.55);
  backdrop-filter: blur(2px);
  z-index: 80;
  opacity: 0;
  animation: backdropIn 0.2s ease forwards;
}
.panel {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: 480px;
  max-width: 92vw;
  background: var(--surface);
  border-left: 1px solid var(--line);
  z-index: 90;
  display: flex; flex-direction: column;
  overflow: hidden;
  box-shadow: -16px 0 48px rgba(0, 0, 0, 0.45);
  transform: translateX(100%);
  animation: panelIn 0.28s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
}

/* Context badge */
.panel-context {
  position: absolute;
  top: 14px; left: 18px;
  z-index: 3;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--text-3);
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 9px 3px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgba(11, 12, 14, 0.55);
  backdrop-filter: blur(8px);
}

/* Hero */
.panel-hero {
  position: relative;
  padding: 48px 22px 18px;
  background:
    linear-gradient(180deg, transparent 0%, var(--surface) 92%),
    var(--hero-bg, linear-gradient(160deg, #1a3a5c, #2a1a3a));
  border-bottom: 1px solid var(--line);
  display: flex; gap: 18px;
  align-items: flex-start;
}
.panel-hero::before {
  content: '';
  position: absolute; inset: 0;
  background: radial-gradient(70% 100% at 80% 0%, rgba(0,0,0,0.55), transparent 70%);
  pointer-events: none;
}
.panel-poster {
  position: relative;
  z-index: 1;
  flex-shrink: 0;
  box-shadow: 0 6px 18px rgba(0,0,0,0.4);
  border-radius: var(--r-md);
}
.panel-poster :deep(.mp) { border-color: var(--line-2); }
.panel-head-text {
  flex: 1; min-width: 0;
  position: relative; z-index: 1;
  padding-top: 4px;
}
.panel-eyebrow {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--stage-color, var(--accent-2));
  display: inline-flex; align-items: center; gap: 7px;
}
.panel-eyebrow .dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}
.panel-eyebrow.pulse .dot { animation: pulse 1.4s ease-in-out infinite; }
.panel-title {
  margin-top: 6px;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.1;
  color: var(--text-primary);
}
.panel-title .year {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 19px;
  color: var(--text-secondary);
  margin-left: 8px;
}
.panel-meta {
  margin-top: 10px;
  display: flex; flex-wrap: wrap;
  gap: 6px 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  align-items: center;
}
.panel-meta .rating { color: var(--accent-2); font-weight: 600; }
.panel-meta .pip { color: var(--text-3); }
.panel-meta .pill-4k {
  padding: 1px 7px;
  border-radius: 3px;
  background: rgba(240, 107, 130, 0.85);
  color: #0b0c0e;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.panel-close {
  position: absolute;
  top: 12px; right: 12px;
  z-index: 3;
  width: 32px; height: 32px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: rgba(11, 12, 14, 0.55);
  backdrop-filter: blur(8px);
  color: var(--text-3);
  display: grid; place-items: center;
  cursor: pointer;
  transition: all 0.15s;
}
.panel-close:hover {
  background: var(--surface-3);
  color: var(--text-primary);
  border-color: var(--line-2);
}

.panel-body {
  padding: 20px 22px 28px;
  overflow-y: auto;
  flex: 1;
  display: flex; flex-direction: column;
  gap: 22px;
}

.panel-section {
  display: flex; flex-direction: column;
  gap: 10px;
  position: relative;
  animation: fadeInUp 0.32s ease;
}
.panel-section-label {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--text-3);
  display: flex; align-items: baseline; gap: 8px;
}
.panel-section-label .ctx {
  font-family: var(--font-mono);
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

/* Actions */
.panel-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 9px 14px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  font-size: 13px; font-weight: 500;
  font-family: var(--font-sans);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.btn:active { transform: scale(0.97); }
.btn-primary { background: var(--accent); color: #0b0c0e; font-weight: 600; }
.btn-primary:hover { background: var(--accent-hover); }
.btn-ghost {
  background: transparent; color: var(--text-secondary);
  border: 1px solid var(--line);
}
.btn-ghost:hover { color: var(--text-primary); border-color: var(--line-2); background: var(--surface-2); }
.btn-danger {
  color: var(--err);
  background: transparent;
  border: 1px solid rgba(240, 123, 110, 0.3);
}
.btn-danger:hover {
  background: rgba(240, 123, 110, 0.08);
  border-color: var(--err);
}

/* Genres */
.panel-genres {
  display: flex; flex-wrap: wrap; gap: 5px;
}
.panel-genres span {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  color: var(--text-secondary);
}
.panel-plot {
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text-secondary);
  text-wrap: pretty;
}

/* Pipeline timeline */
.pipeline {
  position: relative;
  display: flex; flex-direction: column;
  gap: 0;
}
.pipeline-step {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  gap: 14px;
  align-items: flex-start;
  position: relative;
  padding-bottom: 16px;
}
.pipeline-step:last-child { padding-bottom: 0; }
.pipeline-step::before {
  content: '';
  position: absolute;
  left: 11px; top: 22px; bottom: -2px;
  width: 2px;
  background: var(--line);
}
.pipeline-step:last-child::before { display: none; }
.pipeline-dot {
  width: 22px; height: 22px;
  border-radius: 50%;
  background: var(--surface-2);
  border: 2px solid var(--line);
  display: grid; place-items: center;
  position: relative;
  z-index: 1;
  flex-shrink: 0;
  color: var(--text-3);
}
.pipeline-step.done .pipeline-dot {
  background: var(--ok);
  border-color: var(--ok);
  color: #0b0c0e;
}
.pipeline-step.done::before { background: var(--ok); }
.pipeline-step.active .pipeline-dot {
  background: var(--stage-color);
  border-color: var(--stage-color);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--stage-color) 20%, transparent);
  animation: pulseRing 1.6s ease-in-out infinite;
}
.pipeline-step.active .active-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #0b0c0e;
}
.pipeline-text { padding-top: 1px; }
.pipeline-name {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-primary);
}
.pipeline-step.future .pipeline-name { color: var(--text-3); }
.pipeline-detail {
  margin-top: 3px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.pipeline-time {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  padding-top: 3px;
}

/* Live progress */
.live-progress {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px;
}
.live-progress-head {
  display: flex; align-items: baseline; justify-content: space-between;
}
.live-progress-pct {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--stage-color);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.live-progress-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.live-progress-meta strong { color: var(--text-primary); font-weight: 600; }
.live-progress-bar {
  height: 5px;
  background: var(--surface-3);
  border-radius: 999px;
  overflow: hidden;
}
.live-progress-bar .fill {
  height: 100%;
  background: linear-gradient(90deg, var(--stage-color), color-mix(in srgb, var(--stage-color) 50%, #fff));
  border-radius: 999px;
  position: relative;
  transition: width 0.5s ease;
}
.live-progress-bar .fill::after {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
  animation: shimmer 2s linear infinite;
}
.live-progress-foot {
  display: flex; justify-content: space-between; gap: 12px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.live-progress-foot .release {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 60%;
}

/* KV list */
.panel-kv {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 6px 16px;
  font-size: 12.5px;
}
.panel-kv dt {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.panel-kv dd {
  color: var(--text-primary);
  font-size: 12.5px;
}
.panel-kv dd.mono { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-secondary); word-break: break-all; }
.panel-kv dd .pill {
  display: inline-flex; align-items: center;
  padding: 1px 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  border-radius: 3px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  color: var(--text-secondary);
}
.panel-kv dd .pill.is-4k {
  background: rgba(240, 107, 130, 0.18);
  border-color: rgba(240, 107, 130, 0.35);
  color: var(--accent);
  font-weight: 700;
}

/* Search candidates */
.candidates {
  display: flex; flex-direction: column;
  gap: 6px;
}
.candidate {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  gap: 10px;
  padding: 9px 12px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  align-items: center;
  font-size: 12.5px;
}
.candidate.found {
  border-color: rgba(74, 222, 128, 0.3);
  background: rgba(74, 222, 128, 0.06);
}
.candidate .source-icon { color: var(--text-3); display: inline-flex; }
.candidate.found .source-icon { color: var(--ok); }
.candidate .name {
  font-family: var(--font-mono);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.candidate.found .name { color: var(--ok); }
.candidate .when {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
}

/* Error notice */
.panel-error {
  display: flex; gap: 12px;
  padding: 14px 16px;
  border-radius: var(--r-md);
  background: rgba(240, 123, 110, 0.08);
  border: 1px solid rgba(240, 123, 110, 0.25);
  color: var(--err);
  align-items: flex-start;
}
.panel-error strong { font-size: 13px; font-weight: 600; color: var(--err); }
.panel-error p {
  margin-top: 4px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-secondary);
}

/* Activity log */
.activity {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  overflow: hidden;
}
.activity-head {
  padding: 12px 16px;
  display: flex; align-items: center; justify-content: space-between;
  cursor: pointer;
  user-select: none;
}
.activity-head:hover { background: var(--surface-3); }
.activity-head .lbl {
  display: flex; align-items: baseline; gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
}
.activity-head .lbl strong {
  font-family: var(--font-sans);
  text-transform: none;
  letter-spacing: -0.005em;
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
}
.activity-head .chevron {
  color: var(--text-3);
  transition: transform 0.2s;
  flex-shrink: 0;
}
.activity.open .activity-head .chevron { transform: rotate(90deg); }
.activity-list {
  display: none;
  padding: 0 16px 14px;
  flex-direction: column;
  gap: 9px;
}
.activity.open .activity-list { display: flex; }
.activity-item {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 10px;
  align-items: baseline;
  font-size: 12px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
}
.activity-item:first-child { border-top: none; padding-top: 4px; }
.activity-time {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.activity-text {
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.4;
}
.activity-action {
  font-family: var(--font-mono);
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 1px 7px;
  border-radius: 3px;
  background: var(--surface-3);
  color: var(--text-3);
  font-weight: 600;
  white-space: nowrap;
}
.activity-action.ok { background: rgba(74, 222, 128, 0.12); color: var(--ok); }
.activity-action.err { background: rgba(240, 123, 110, 0.12); color: var(--err); }
.activity-action.busy { background: rgba(183, 148, 244, 0.14); color: var(--stage-downloading); }

/* Animations */
@keyframes panelIn {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}
@keyframes backdropIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}
@keyframes pulseRing {
  0%, 100% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--stage-color) 20%, transparent); }
  50% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--stage-color) 5%, transparent); }
}
@keyframes shimmer {
  from { transform: translateX(-100%); }
  to { transform: translateX(100%); }
}

@media (max-width: 768px) {
  .panel { width: 100%; }
}
</style>
