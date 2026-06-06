<template>
  <div
    :class="['qx-row', { stuck: isStuck, checked: isChecked }]"
    :style="{ '--stage-color': stageColor }"
    role="button"
    tabindex="0"
    @click="$emit('open', movie)"
    @keydown.enter.prevent="$emit('open', movie)"
  >
    <div class="qx-row-check" @click.stop>
      <input
        type="checkbox"
        :checked="isChecked"
        @change="$emit('toggle-select', movie.id)"
        :aria-label="`Auswählen: ${movie.title}`"
      />
    </div>

    <MoviePoster
      :imdb-id="movie.imdb_id"
      :title="movie.title"
      :year="movie.year"
      class="poster"
    />

    <div class="qx-row-text">
      <div class="qx-row-title">
        <span class="name">
          <HighlightText :text="movie.title" :query="searchQuery" />
        </span>
        <span class="year">{{ movie.year }}</span>
        <span v-if="movie.media_type === 'show'" class="badge-type">Serie</span>
        <span
          v-if="movie.repair"
          class="badge-repair"
          title="Reparatur: eine unvollständige Datei wurde erkannt und wird neu geladen"
        >Reparatur</span>
      </div>
      <div class="qx-row-meta">
        <span v-if="movie.desired_quality" class="item">{{ movie.desired_quality }}</span>
        <span v-if="sourceHostName" class="item">· {{ sourceHostName }}</span>
        <span v-if="lastCheckedText" :class="['item', { attn: isStuck }]">
          · geprüft {{ lastCheckedText }}
        </span>
        <span v-if="isStuck" class="item attn">· hängt</span>
      </div>
      <div v-if="showInlineProgress" class="qx-row-progress">
        <div class="fill" :style="{ width: inlineProgressPct + '%' }"></div>
      </div>
    </div>

    <span :class="['qx-row-stage', { active: isActiveStage }]">
      <span class="dot"></span>
      {{ stageLabel }}
    </span>

    <div class="qx-row-actions" @click.stop>
      <button
        class="icon-btn"
        :disabled="movie.status === 'downloading'"
        :aria-label="`Retry: ${movie.title}`"
        title="Erneut versuchen"
        @click="$emit('retry', movie.id)"
      >
        <RefreshCw :size="14" />
      </button>
      <button
        class="icon-btn danger"
        :aria-label="`Löschen: ${movie.title}`"
        title="Löschen"
        @click="$emit('remove', movie)"
      >
        <Trash2 :size="14" />
      </button>
      <a
        v-if="movie.source_url"
        :href="movie.source_url"
        target="_blank"
        rel="noopener"
        class="icon-btn"
        :title="sourceHostName || 'Quelle öffnen'"
        @click.stop
      >
        <ExternalLink :size="14" />
      </a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Movie } from '../../types/index';
import { timeAgo, sourceHost, displayStatus, statusLabel } from '../../composables/useFormatters';
import MoviePoster from '../MoviePoster.vue';
import HighlightText from '../HighlightText.vue';
import { RefreshCw, Trash2, ExternalLink } from 'lucide-vue-next';

const props = defineProps<{
  movie: Movie;
  searchQuery: string;
  isChecked: boolean;
  /** 0..1 progress fraction from downloads polling */
  progressFraction?: number;
}>();

defineEmits<{
  (e: 'open', m: Movie): void;
  (e: 'retry', id: number): void;
  (e: 'remove', m: Movie): void;
  (e: 'toggle-select', id: number): void;
}>();

// Resolve 'not_found' into its reason bucket so the badge shows *why* (label +
// stage colour), instead of a generic "Nicht gefunden". Labels come from the
// shared statusLabel() vocabulary in useFormatters.
const displayStat = computed(() => displayStatus(props.movie));
const stageLabel = computed(() => statusLabel(displayStat.value));
const stageColor = computed(() => `var(--stage-${displayStat.value})`);

const isActiveStage = computed(() =>
  ['searching', 'downloading', 'extracting'].includes(props.movie.status)
);

const isStuck = computed(() => {
  if (props.movie.status !== 'pending') return false;
  const ts = props.movie.last_checked_at || props.movie.added_at;
  if (!ts) return false;
  const ageHours = (Date.now() - new Date(ts + 'Z').getTime()) / 3_600_000;
  return ageHours > 24;
});

const lastCheckedText = computed(() => {
  const ts = props.movie.last_checked_at;
  if (!ts) return '';
  return timeAgo(ts);
});

const sourceHostName = computed(() => sourceHost(props.movie.source_url));

const showInlineProgress = computed(() =>
  props.movie.status === 'downloading' && typeof props.progressFraction === 'number'
);
const inlineProgressPct = computed(() => Math.round((props.progressFraction || 0) * 100));
</script>

<style scoped>
.qx-row {
  position: relative;
  display: grid;
  grid-template-columns: 22px 56px 1fr auto auto;
  gap: 14px;
  align-items: center;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
  transition: background 0.15s;
}
.qx-row:hover { background: var(--surface-2); }
.qx-row.checked { background: var(--accent-soft); }
.qx-row.stuck::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 2px;
  background: var(--warn);
}

.qx-row-check {
  opacity: 0;
  transition: opacity 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
}
.qx-row:hover .qx-row-check,
.qx-row.checked .qx-row-check { opacity: 1; }
.qx-row-check input {
  accent-color: var(--accent);
  cursor: pointer;
  width: 16px;
  height: 16px;
}

.poster { flex-shrink: 0; }

.qx-row-text { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.qx-row-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.qx-row-title .name {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qx-row-title .year {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 14px;
  color: var(--text-secondary);
}
.qx-row-title .badge-type {
  font-family: var(--font-mono);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--text-3);
}

.qx-row-title .badge-repair {
  font-family: var(--font-mono);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--line));
  border-radius: 3px;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}

.qx-row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}
.qx-row-meta .item { white-space: nowrap; }
.qx-row-meta .item.attn { color: var(--warn); }

.qx-row-progress {
  height: 3px;
  max-width: 300px;
  margin-top: 4px;
  background: var(--surface-3);
  border-radius: 999px;
  overflow: hidden;
}
.qx-row-progress .fill {
  height: 100%;
  background: var(--stage-color);
  border-radius: 999px;
  transition: width 0.4s ease;
}

.qx-row-stage {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px 4px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  border: 1px solid color-mix(in srgb, var(--stage-color) 30%, transparent);
  background: color-mix(in srgb, var(--stage-color) 8%, transparent);
  color: var(--stage-color);
  white-space: nowrap;
}
.qx-row-stage .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.qx-row-stage.active .dot {
  box-shadow: 0 0 6px currentColor;
  animation: qxRowPulse 1.5s ease-in-out infinite;
}
@keyframes qxRowPulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}

.qx-row-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.qx-row:hover .qx-row-actions { opacity: 1; }

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  text-decoration: none;
}
.icon-btn:hover { background: var(--surface-3); color: var(--text-primary); border-color: var(--line); }
.icon-btn.danger:hover { color: var(--err); border-color: rgba(240, 123, 110, 0.3); }
.icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

@media (max-width: 768px) {
  .qx-row {
    grid-template-columns: 22px 48px 1fr auto;
    gap: 10px;
    padding: 10px 12px;
  }
  .qx-row-stage { display: none; }
  .qx-row-actions { opacity: 1; }
  .poster { width: 48px !important; height: 72px !important; }
}
</style>
