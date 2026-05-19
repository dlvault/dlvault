<template>
  <div class="card stream-card">
    <div class="card-header">
      <div class="card-title">
        Live-Aktivität
        <span v-if="sseConnected" class="badge-mono streaming">● live</span>
        <span v-else class="badge-mono offline">○ offline</span>
      </div>
      <router-link to="/logs" class="card-link">Logs →</router-link>
    </div>
    <div v-if="items.length === 0" class="stream-empty">
      Noch keine Aktivitäten — starte einen Sync um die Pipeline anzustoßen.
    </div>
    <div v-else class="stream">
      <div
        v-for="(e, i) in items"
        :key="e.id"
        class="stream-row"
        :class="{ 'is-new': i === 0 && wasUpdated }"
        :style="{ '--stage-color': stageColor(e.action) }"
      >
        <div class="stream-time">{{ e.timeAgo }}</div>
        <div class="stream-poster-wrap">
          <MoviePoster :imdb-id="e.imdbId" :title="e.movie || e.action" size="xs" />
        </div>
        <div class="stream-text">
          <div class="ttl">{{ e.label }} <em v-if="e.movie">{{ e.movie }}</em></div>
          <div v-if="e.detail" class="det">{{ e.detail }}</div>
        </div>
        <div class="stream-action">{{ e.verb }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import MoviePoster from '../MoviePoster.vue';
import { timeAgo, formatAction, activityVerb, activityText, actionColor } from '../../composables/useFormatters';
import type { LogEntry } from '../../types/index';

const props = defineProps<{
  logs: LogEntry[];
  sseConnected: boolean;
}>();

interface StreamItem {
  id: number;
  action: string;
  movie: string;
  imdbId?: string | null;
  label: string;
  verb: string;
  detail: string;
  timeAgo: string;
}

const items = computed<StreamItem[]>(() =>
  props.logs.slice(0, 9).map(l => {
    // German label + German detail fragment, derived from the shared formatter.
    const label = formatAction(l.action);
    const full = activityText(l.action, l.details);
    const detail = full.startsWith(label)
      ? full.slice(label.length).replace(/^\s*·\s*/, '')
      : full;
    return {
      id: l.id,
      action: l.action,
      movie: l.movie_title || '',
      imdbId: null, // logs don't carry imdb_id today; gradient placeholder is fine
      label,
      verb: activityVerb(l.action),
      detail,
      timeAgo: timeAgo(l.created_at),
    };
  })
);

// Track whether the top item changed so we can pulse it
const wasUpdated = ref(false);
const lastTopId = ref<number | null>(null);
watch(() => items.value[0]?.id, (newId) => {
  if (newId && lastTopId.value !== null && newId !== lastTopId.value) {
    wasUpdated.value = true;
    setTimeout(() => { wasUpdated.value = false; }, 800);
  }
  lastTopId.value = newId ?? null;
});

function stageColor(action: string): string {
  // Pipeline-color mapping — actionColor() returns the same stage tokens used
  // by status badges, we just translate them into CSS var refs.
  const c = actionColor(action);
  switch (c) {
    case 'found':     return 'var(--ok)';
    case 'not_found': return 'var(--err)';
    case 'searching': return 'var(--info)';
    case 'pending':   return 'var(--warn)';
    default:          return 'var(--text-secondary)';
  }
}
</script>

<style scoped>
.stream-card { padding: 22px; padding-bottom: 8px; }
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.badge-mono {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 500;
}
.badge-mono.streaming { color: var(--ok); }
.badge-mono.offline { color: var(--text-3); }
.card-link {
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}
.card-link:hover { color: var(--accent-hover); }

.stream-empty {
  padding: 24px 4px;
  font-size: 13px;
  color: var(--text-3);
  text-align: center;
}

.stream {
  display: flex;
  flex-direction: column;
  position: relative;
  max-height: 480px;
  overflow: hidden;
  mask-image: linear-gradient(180deg, #000 88%, transparent);
  -webkit-mask-image: linear-gradient(180deg, #000 88%, transparent);
}
.stream-row {
  display: grid;
  grid-template-columns: 70px 24px 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}
.stream-row:last-child { border-bottom: none; }
.stream-row.is-new .stream-poster-wrap :deep(.mp) {
  border-color: var(--stage-color);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--stage-color) 30%, transparent);
  animation: pop 0.4s ease;
}
.stream-time {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.stream-poster-wrap {
  position: relative;
  width: 24px;
  height: 36px;
}
.stream-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stream-text .ttl {
  color: var(--text-primary);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stream-text .ttl em {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: var(--accent-2);
}
.stream-text .det {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stream-action {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--stage-color, var(--text-secondary));
  font-weight: 500;
}

@keyframes pop {
  0% { transform: scale(1); }
  50% { transform: scale(1.08); }
  100% { transform: scale(1); }
}

@media (max-width: 768px) {
  .stream-row { grid-template-columns: 60px 24px 1fr; }
  .stream-action { display: none; }
}
</style>
