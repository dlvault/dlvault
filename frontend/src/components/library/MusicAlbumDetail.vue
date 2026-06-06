<template>
  <div class="mad-overlay" @click.self="$emit('close')">
    <div class="mad-modal" role="dialog" aria-modal="true">
      <button class="mad-close" aria-label="Schließen" @click="$emit('close')"><X :size="18" /></button>

      <div class="mad-head">
        <div class="mad-cover">
          <img v-if="album.coverUrl" :src="album.coverUrl" :alt="album.title" />
          <Disc3 v-else :size="34" />
        </div>
        <div class="mad-meta">
          <div class="mad-eyebrow">Album</div>
          <h2 class="mad-title">{{ album.title }}</h2>
          <div class="mad-sub">
            <span class="artist">{{ album.artist || '—' }}</span><span v-if="album.year"> · {{ album.year }}</span>
          </div>
          <div class="mad-stats">
            <span v-if="album.trackCount">{{ album.trackCount }} Titel</span>
            <template v-if="totalDuration"><span class="pip">·</span><span>{{ totalDuration }}</span></template>
          </div>

          <div class="mad-actions">
            <template v-if="!confirming">
              <button class="mad-del" :disabled="deleting" @click="confirming = true">
                <Trash2 :size="14" /> Aus Bibliothek löschen
              </button>
            </template>
            <template v-else>
              <span class="mad-confirm-q">Dateien wirklich löschen?</span>
              <button class="mad-del danger" :disabled="deleting" @click="doDelete">
                {{ deleting ? 'Löscht…' : 'Ja, löschen' }}
              </button>
              <button class="mad-cancel" :disabled="deleting" @click="confirming = false">Abbrechen</button>
            </template>
          </div>
          <div v-if="error" class="mad-error">{{ error }}</div>
        </div>
      </div>

      <div class="mad-tracks">
        <div v-if="loading" class="mad-note">Lädt Titel…</div>
        <div v-else-if="tracks.length === 0" class="mad-note">Keine Titel gefunden (Jellyfin lieferte keine).</div>
        <div v-else class="mad-track-list">
          <div v-for="(t, i) in tracks" :key="t.id" class="mad-track">
            <span class="mad-tnum">{{ t.track ?? (i + 1) }}</span>
            <span class="mad-tname">{{ t.title }}</span>
            <span class="mad-tdur">{{ fmtDur(t.durationSec) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import axios from 'axios';
import { X, Trash2, Disc3 } from 'lucide-vue-next';

interface Album {
  id: string;
  title: string;
  artist: string | null;
  year: number | null;
  coverUrl: string | null;
  trackCount: number | null;
}
interface Track {
  id: string;
  title: string;
  track: number | null;
  disc: number | null;
  durationSec: number | null;
}

const props = defineProps<{ album: Album }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'deleted', id: string): void }>();

const tracks = ref<Track[]>([]);
const loading = ref(true);
const deleting = ref(false);
const confirming = ref(false);
const error = ref<string | null>(null);

const totalDuration = computed(() => {
  const sec = tracks.value.reduce((s, t) => s + (t.durationSec || 0), 0);
  if (!sec) return null;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} Min`;
  return `${Math.floor(m / 60)} Std ${m % 60} Min`;
});

function fmtDur(sec: number | null): string {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function doDelete() {
  deleting.value = true;
  error.value = null;
  try {
    await axios.delete(`/api/library/music/${props.album.id}`);
    emit('deleted', props.album.id);
  } catch (e: any) {
    error.value = e?.response?.data?.error || 'Löschen fehlgeschlagen';
    deleting.value = false;
    confirming.value = false;
  }
}

onMounted(async () => {
  try {
    const res = await axios.get(`/api/library/music/${props.album.id}/tracks`);
    tracks.value = res.data.tracks || [];
  } catch {
    tracks.value = [];
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.mad-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.mad-modal {
  position: relative;
  width: 100%; max-width: 560px; max-height: 86vh;
  display: flex; flex-direction: column;
  background: var(--surface, #161b22);
  border: 1px solid var(--line, #30363d);
  border-radius: var(--r-lg, 16px);
  overflow: hidden;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
}
.mad-close {
  position: absolute; top: 14px; right: 14px; z-index: 2;
  width: 32px; height: 32px; display: grid; place-items: center;
  border-radius: 8px; border: 1px solid var(--line, #30363d);
  background: var(--surface-2, #21262d); color: var(--text-secondary, #8b949e);
  cursor: pointer; transition: color 0.15s, border-color 0.15s;
}
.mad-close:hover { color: var(--text-primary, #e1e4e8); border-color: var(--line-2, #444c56); }
.mad-head {
  display: flex; gap: 18px; padding: 24px;
  border-bottom: 1px solid var(--line, #30363d);
}
.mad-cover {
  width: 128px; height: 128px; flex-shrink: 0;
  border-radius: 10px; overflow: hidden;
  border: 1px solid var(--line, #30363d);
  background: linear-gradient(160deg, #2c2136 0%, #141019 70%, #1a2c2a 100%);
  display: grid; place-items: center; color: rgba(255, 255, 255, 0.85);
}
.mad-cover img { width: 100%; height: 100%; object-fit: cover; }
.mad-meta { min-width: 0; display: flex; flex-direction: column; }
.mad-eyebrow {
  font-family: var(--font-mono, monospace); font-size: 10px; text-transform: uppercase;
  letter-spacing: 0.14em; color: var(--text-3, #6e7681);
}
.mad-title {
  font-size: 21px; font-weight: 600; letter-spacing: -0.01em; margin: 4px 0 0;
  color: var(--text-primary, #e1e4e8); line-height: 1.2;
}
.mad-sub { margin-top: 4px; color: var(--text-secondary, #8b949e); font-size: 14px; }
.mad-sub .artist { font-family: var(--font-serif, serif); font-style: italic; color: var(--accent-2, #b794f4); }
.mad-stats {
  margin-top: 8px; font-family: var(--font-mono, monospace); font-size: 11.5px;
  color: var(--text-3, #6e7681); display: flex; gap: 8px; align-items: center;
}
.mad-actions { margin-top: auto; padding-top: 14px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mad-del {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 7px 13px; border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--err, #f07b6e) 34%, transparent);
  background: color-mix(in srgb, var(--err, #f07b6e) 8%, transparent);
  color: var(--err, #f07b6e); font-size: 12.5px; font-weight: 600; cursor: pointer;
  transition: background 0.15s;
}
.mad-del:hover { background: color-mix(in srgb, var(--err, #f07b6e) 16%, transparent); }
.mad-del.danger { background: var(--err, #f07b6e); color: #fff; border-color: transparent; }
.mad-del:disabled { opacity: 0.6; cursor: default; }
.mad-cancel {
  padding: 7px 12px; border-radius: 8px; border: 1px solid var(--line, #30363d);
  background: transparent; color: var(--text-secondary, #8b949e); font-size: 12.5px; cursor: pointer;
}
.mad-confirm-q { font-size: 12.5px; color: var(--text-secondary, #8b949e); }
.mad-error { margin-top: 8px; font-size: 12px; color: var(--err, #f07b6e); }
.mad-tracks { overflow-y: auto; padding: 8px 12px 14px; }
.mad-note { padding: 28px; text-align: center; color: var(--text-3, #6e7681); font-size: 13px; }
.mad-track-list { display: flex; flex-direction: column; }
.mad-track {
  display: grid; grid-template-columns: 34px 1fr auto; align-items: center; gap: 12px;
  padding: 9px 12px; border-radius: 8px; transition: background 0.12s;
}
.mad-track:hover { background: var(--surface-2, #21262d); }
.mad-tnum { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--text-3, #6e7681); text-align: right; }
.mad-tname { font-size: 13.5px; color: var(--text-primary, #e1e4e8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mad-tdur { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--text-3, #6e7681); font-variant-numeric: tabular-nums; }
@media (max-width: 600px) {
  .mad-head { flex-direction: column; }
  .mad-cover { width: 96px; height: 96px; }
}
</style>
