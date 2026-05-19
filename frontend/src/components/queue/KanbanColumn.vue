<template>
  <div class="qx-kan-col">
    <div class="qx-kan-head" :style="{ '--stage-color': stageColor }">
      <span class="dot"></span>
      <span class="lbl">{{ label }}</span>
      <span class="count">{{ items.length }}</span>
    </div>
    <div class="qx-kan-body">
      <div v-if="items.length === 0" class="qx-kan-empty">leer</div>
      <div
        v-for="m in visibleItems"
        :key="m.id"
        :class="['qx-kan-card', { active: isActive(m) }]"
        :style="{ '--stage-color': cardColor(m) }"
        @click="$emit('open', m)"
      >
        <MoviePoster
          :imdb-id="m.imdb_id"
          :title="m.title"
          :year="m.year"
          size="sm"
        />
        <div class="qx-kan-text">
          <div class="title">{{ m.title }}</div>
          <div class="meta">
            <span>{{ m.year }}</span>
            <span v-if="m.desired_quality">· {{ m.desired_quality }}</span>
          </div>
          <div v-if="progressFor(m) > 0" class="bar">
            <div class="fill" :style="{ width: progressFor(m) + '%' }"></div>
          </div>
        </div>
      </div>
      <div v-if="items.length > maxVisible" class="qx-kan-more">
        +{{ items.length - maxVisible }} weitere
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Movie } from '../../types/index';
import MoviePoster from '../MoviePoster.vue';

const props = defineProps<{
  label: string;
  stageColor: string;
  items: Movie[];
  progressMap: Map<string, number>;
  maxVisible?: number;
}>();

defineEmits<{ (e: 'open', m: Movie): void }>();

const maxVisible = computed(() => props.maxVisible ?? 6);
const visibleItems = computed(() => props.items.slice(0, maxVisible.value));

function isActive(m: Movie): boolean {
  return ['downloading', 'extracting', 'searching'].includes(m.status);
}

function cardColor(m: Movie): string {
  return `var(--stage-${m.status === 'not_found' ? 'not_found' : m.status})`;
}

function progressFor(m: Movie): number {
  const key = `${m.title} (${m.year})`;
  const frac = props.progressMap.get(key);
  if (typeof frac !== 'number') return 0;
  return Math.round(frac * 100);
}
</script>

<style scoped>
.qx-kan-col {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  display: flex;
  flex-direction: column;
  min-height: 200px;
}

.qx-kan-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}
.qx-kan-head .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--stage-color);
  box-shadow: 0 0 4px var(--stage-color);
  flex-shrink: 0;
}
.qx-kan-head .lbl {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
  font-weight: 500;
}
.qx-kan-head .count {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-primary);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.qx-kan-body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
}

.qx-kan-card {
  display: grid;
  grid-template-columns: 40px 1fr;
  gap: 10px;
  padding: 8px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, transform 0.15s;
  align-items: center;
}
.qx-kan-card:hover { background: var(--surface-3); transform: translateY(-1px); }
.qx-kan-card.active {
  border-color: var(--stage-color);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--stage-color) 30%, transparent);
}

.qx-kan-text { min-width: 0; }
.qx-kan-text .title {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.qx-kan-text .meta {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}
.qx-kan-text .bar {
  height: 3px;
  background: var(--surface-3);
  border-radius: 999px;
  overflow: hidden;
  margin-top: 6px;
  width: 100%;
}
.qx-kan-text .bar .fill {
  height: 100%;
  background: var(--stage-color);
  transition: width 0.4s ease;
}

.qx-kan-empty {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-3);
  text-align: center;
  padding: 12px;
}
.qx-kan-more {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-3);
  text-align: center;
  padding: 4px;
  letter-spacing: 0.05em;
}
</style>
