<template>
  <section class="lx-shelf" aria-label="Frisch hinzugefügt">
    <div class="lx-shelf-head">
      <div class="lx-shelf-title">
        Frisch hinzugefügt <span class="serif">{{ items.length }}</span>
      </div>
    </div>
    <div class="lx-shelf-rail">
      <article v-for="item in items" :key="item.id" class="lx-shelf-card">
        <LibraryPoster
          :title="item.name"
          :year="item.year"
          :media-type="item.mediaType"
          :poster-url="item.posterUrl"
          :quality="item.quality"
          :rating="item.rating"
          :runtime-label="item.runtimeLabel"
          :genres="item.genres"
          :selected="selectedId === item.id"
          @open="$emit('open', item)"
          @delete="$emit('delete', item)"
        />
        <div class="lx-shelf-info">
          <div v-if="item.addedRelative" class="when">{{ item.addedRelative }}</div>
          <div class="name">{{ item.name }}</div>
          <div class="meta">
            <template v-if="item.year">{{ item.year }}</template>
            <template v-if="item.year && item.quality"> · {{ item.quality }}</template>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import LibraryPoster from './LibraryPoster.vue';
import type { EnrichedLibraryItem } from './libraryItem';

defineProps<{
  items: EnrichedLibraryItem[];
  selectedId?: string | number | null;
}>();

defineEmits<{
  open: [item: EnrichedLibraryItem];
  delete: [item: EnrichedLibraryItem];
}>();
</script>

<style scoped>
.lx-shelf {
  display: flex; flex-direction: column;
  gap: 10px;
}
.lx-shelf-head {
  display: flex; align-items: baseline; justify-content: space-between;
}
.lx-shelf-title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  display: inline-flex; align-items: baseline; gap: 10px;
  color: var(--text-primary);
}
.lx-shelf-title .serif {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 15px;
  color: var(--text-secondary);
}

.lx-shelf-rail {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 168px;
  gap: 14px;
  overflow-x: auto;
  padding: 4px 0 14px;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  scrollbar-color: var(--line-2) transparent;
}
.lx-shelf-rail::-webkit-scrollbar { height: 8px; }
.lx-shelf-rail::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 999px; }
.lx-shelf-rail::-webkit-scrollbar-track { background: transparent; }

.lx-shelf-card {
  scroll-snap-align: start;
  display: flex; flex-direction: column;
  gap: 8px;
}
.lx-shelf-info {
  display: flex; flex-direction: column;
  gap: 2px;
  padding: 0 2px;
  min-width: 0;
}
.lx-shelf-info .when {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent-2);
}
.lx-shelf-info .name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lx-shelf-info .meta {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 480px) {
  .lx-shelf-rail { grid-auto-columns: 138px; }
}
</style>
