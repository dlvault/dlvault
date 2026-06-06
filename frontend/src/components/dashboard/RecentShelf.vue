<template>
  <div v-if="items.length > 0" class="pipeline-card fade-in">
    <div class="card-header">
      <div class="card-title">
        Kürzlich hinzugefügt <span class="badge-mono">{{ subtitle }}</span>
      </div>
      <router-link to="/library" class="card-link">Mediathek →</router-link>
    </div>
    <div class="recent-shelf">
      <div
        v-for="m in items"
        :key="m.id"
        class="recent-item"
        role="button"
        tabindex="0"
        :aria-label="`${m.title} — Details öffnen`"
        @click="$emit('open', m.id)"
        @keydown.enter="$emit('open', m.id)"
      >
        <MoviePoster :imdb-id="m.imdbId" :title="m.title" :year="m.year" rating="1080p" size="lg" />
        <div class="recent-info">
          <div class="name">{{ m.title }}</div>
          <div class="when">{{ m.when }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MoviePoster from '../MoviePoster.vue';

interface RecentItem {
  id: number;
  imdbId?: string | null;
  title: string;
  year?: number;
  when: string;
}

const props = defineProps<{ items: RecentItem[] }>();
defineEmits<{ open: [id: number] }>();

const subtitle = computed(() => {
  const n = props.items.length;
  if (n === 0) return '';
  return n === 1 ? '1 Film' : `${n} Filme`;
});
</script>

<style scoped>
.pipeline-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 22px;
}
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
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 500;
}
.card-link {
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}
.card-link:hover { color: var(--accent-hover); }

.recent-shelf {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 120px;
  gap: 14px;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--line-2) transparent;
  padding-bottom: 4px;
  margin: 0 -4px;
  padding-left: 4px;
  padding-right: 4px;
}
.recent-shelf::-webkit-scrollbar { height: 6px; }
.recent-shelf::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 999px; }
.recent-shelf::-webkit-scrollbar-track { background: transparent; }
.recent-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  cursor: pointer;
}
.recent-item :deep(.mp) {
  transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
}
.recent-item:hover :deep(.mp) {
  transform: translateY(-3px);
  border-color: var(--line-2);
  box-shadow: 0 14px 30px -10px rgba(0, 0, 0, 0.7);
}
.recent-info { display: flex; flex-direction: column; gap: 1px; }
.recent-info .name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.recent-info .when {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-3);
}

@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.fade-in { animation: fadeIn 0.3s ease; }
</style>
