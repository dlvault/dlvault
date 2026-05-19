<template>
  <div class="lx-stats" role="group" aria-label="Bibliotheks-Statistik">
    <div class="lx-stat">
      <div class="lx-stat-label">Filme</div>
      <div class="lx-stat-value">{{ counts.movies }}<span class="unit">Titel</span></div>
      <div :class="['lx-stat-delta', !movieDelta && 'muted']">
        <template v-if="movieDelta">+{{ movieDelta }} diese Woche</template>
        <template v-else>keine Neuzugänge diese Woche</template>
      </div>
    </div>
    <div class="lx-stat">
      <div class="lx-stat-label">Serien</div>
      <div class="lx-stat-value">{{ counts.shows }}<span class="unit">Titel</span></div>
      <div :class="['lx-stat-delta', !showDelta && 'muted']">
        <template v-if="showDelta">+{{ showDelta }} diese Woche</template>
        <template v-else>keine Neuzugänge diese Woche</template>
      </div>
    </div>
    <div class="lx-stat">
      <div class="lx-stat-label">Kürzlich · 30 Tage</div>
      <div class="lx-stat-value">{{ recent }}<span class="unit">neu</span></div>
      <div :class="['lx-stat-delta', !recent && 'muted']">
        <template v-if="recent">in den letzten 30 Tagen</template>
        <template v-else>nichts seit 30 Tagen</template>
      </div>
    </div>
    <div class="lx-stat">
      <div class="lx-stat-label">Gesamt</div>
      <div class="lx-stat-value">{{ counts.total }}<span class="unit">Einträge</span></div>
      <div :class="['lx-stat-delta', !managed && 'muted']">
        <template v-if="managed">{{ managed }} mit Metadaten</template>
        <template v-else>noch keine verwalteten Einträge</template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { EnrichedLibraryItem } from './libraryItem';

const props = defineProps<{ items: EnrichedLibraryItem[] }>();

const counts = computed(() => {
  let movies = 0, shows = 0;
  for (const i of props.items) {
    if (i.mediaType === 'movie') movies++;
    else if (i.mediaType === 'show') shows++;
  }
  return { movies, shows, total: props.items.length };
});

// Recently added — only items where dlvault tracks an addedAt timestamp count.
// Items added directly via the media server (not through dlvault) have no
// timestamp and are intentionally excluded — the alternative is to lie.
const DAY = 86_400_000;
function withinDays(addedAt: string | undefined, days: number): boolean {
  if (!addedAt) return false;
  return Date.now() - new Date(addedAt + 'Z').getTime() < days * DAY;
}
const recent = computed(() => props.items.filter(i => withinDays(i.addedAt, 30)).length);
const movieDelta = computed(() => props.items.filter(i => i.mediaType === 'movie' && withinDays(i.addedAt, 7)).length);
const showDelta = computed(() => props.items.filter(i => i.mediaType === 'show' && withinDays(i.addedAt, 7)).length);

// "Mit Metadaten" — items matched to a dlvault movie row (have plot/rating/genres).
const managed = computed(() => props.items.filter(i => i.rating != null || (i.genres && i.genres.length) || i.plot).length);
</script>

<style scoped>
.lx-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.lx-stat {
  background: var(--surface);
  padding: 18px 22px;
  display: flex; flex-direction: column;
  gap: 8px;
  position: relative;
}
.lx-stat-label {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
}
.lx-stat-value {
  display: flex; align-items: baseline; gap: 6px;
  font-size: 30px; font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.lx-stat-value .unit {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 16px;
  color: var(--text-secondary);
}
.lx-stat-delta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ok);
  font-variant-numeric: tabular-nums;
}
.lx-stat-delta.muted { color: var(--text-3); }

@media (max-width: 900px) {
  .lx-stats { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 480px) {
  .lx-stat { padding: 14px 16px; }
  .lx-stat-value { font-size: 24px; }
  .lx-stat-value .unit { font-size: 13px; }
}
</style>
