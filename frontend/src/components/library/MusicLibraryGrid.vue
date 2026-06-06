<template>
  <div class="mlib">
    <div v-if="loading" class="mlib-loading">Lädt Musik…</div>
    <div v-else-if="albums.length === 0" class="lx-empty">
      <div class="icon-circle"><Music :size="22" /></div>
      <div class="title">Noch keine Musik in der Bibliothek</div>
      <div class="sub">Über „Musik suchen“ Alben oder Songs herunterladen — sie erscheinen hier nach dem Media-Server-Scan.</div>
    </div>
    <div v-else class="mlib-grid">
      <div
        v-for="a in albums"
        :key="a.id"
        class="mlib-card"
        role="button"
        tabindex="0"
        @click="selected = a"
        @keydown.enter="selected = a"
      >
        <div class="mlib-cover">
          <img v-if="a.coverUrl" :src="a.coverUrl" :alt="a.title" loading="lazy" />
          <Music v-else :size="22" />
          <span v-if="a.trackCount" class="mlib-tracks">{{ a.trackCount }}</span>
        </div>
        <div class="mlib-title" :title="a.title">{{ a.title }}</div>
        <div class="mlib-sub">{{ a.artist || '—' }}<span v-if="a.year"> · {{ a.year }}</span></div>
      </div>
    </div>

    <MusicAlbumDetail
      v-if="selected"
      :album="selected"
      @close="selected = null"
      @deleted="onDeleted"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import axios from 'axios';
import { Music } from 'lucide-vue-next';
import MusicAlbumDetail from './MusicAlbumDetail.vue';

interface Album {
  id: string;
  title: string;
  artist: string | null;
  year: number | null;
  coverUrl: string | null;
  trackCount: number | null;
}

const emit = defineEmits<{ (e: 'loaded', count: number): void }>();
const albums = ref<Album[]>([]);
const loading = ref(true);
const selected = ref<Album | null>(null);

function onDeleted(id: string) {
  albums.value = albums.value.filter(a => a.id !== id);
  selected.value = null;
  emit('loaded', albums.value.length);
}

onMounted(async () => {
  try {
    const res = await axios.get('/api/library/music');
    albums.value = res.data.items || [];
    emit('loaded', albums.value.length);
  } catch {
    albums.value = [];
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.mlib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 20px;
}
.mlib-card { display: flex; flex-direction: column; gap: 6px; min-width: 0; cursor: pointer; outline: none; }
.mlib-card .mlib-cover { transition: border-color 0.15s, transform 0.15s; border: 1px solid transparent; }
.mlib-card:hover .mlib-cover, .mlib-card:focus-visible .mlib-cover { border-color: var(--accent, #b794f4); transform: translateY(-2px); }
.mlib-cover {
  position: relative;
  aspect-ratio: 1;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-2, #21262d);
  display: flex; align-items: center; justify-content: center;
  color: var(--text-tertiary, #6e7681);
}
.mlib-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mlib-tracks {
  position: absolute; bottom: 6px; right: 6px;
  padding: 1px 7px; border-radius: 999px;
  background: rgba(0,0,0,.62); color: #fff; font-size: 11px; font-weight: 600;
}
.mlib-title {
  font-size: 13px; font-weight: 600; color: var(--text-primary, #e1e4e8);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mlib-sub {
  font-size: 12px; color: var(--text-secondary, #8b949e);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mlib-loading { padding: 48px; text-align: center; color: var(--text-secondary, #8b949e); }
</style>
