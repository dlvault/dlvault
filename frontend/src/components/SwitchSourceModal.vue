<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="onClose" role="dialog" aria-modal="true" aria-label="Quelle wechseln">
      <div class="modal-box modal-box-wide">
        <h3 class="modal-title">Quelle wechseln</h3>
        <p class="modal-sub">
          {{ movie?.title }}<span v-if="movie?.year"> ({{ movie.year }})</span>
        </p>

        <div v-if="loading" class="state-row">
          <LoadingSpinner inline /> Suche verfügbare Releases…
        </div>
        <div v-else-if="error" class="state-row state-error">{{ error }}</div>
        <div v-else-if="releases.length === 0" class="state-row">
          Keine alternativen Releases gefunden.
        </div>

        <ul v-else class="release-list">
          <li
            v-for="r in releases"
            :key="r.index"
            class="release-row"
            :class="{ selected: selected === r.index }"
            @click="selected = r.index"
          >
            <span class="radio" :class="{ on: selected === r.index }"></span>
            <span class="rel-q">{{ r.quality || '—' }}</span>
            <span class="rel-title">
              {{ r.title }}
              <span v-if="r.isCurrent" class="badge-current">aktuell</span>
            </span>
            <span class="rel-meta">
              <template v-if="r.size">{{ r.size }}</template>
              <template v-if="r.hosters"> · {{ r.hosters }}</template>
            </span>
          </li>
        </ul>

        <div class="modal-actions">
          <button class="btn btn-secondary" @click="onClose" :disabled="switching">Abbrechen</button>
          <button
            class="btn btn-primary"
            @click="confirm"
            :disabled="selected === null || switching || loading"
          >
            <LoadingSpinner v-if="switching" inline />
            {{ switching ? 'Wechsle…' : 'Wechseln' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { searchReleases, downloadRelease, removeJDPackages, removeJDLinkGrabberPackages } from '../api/index';
import { useToast } from '../composables/useApp';
import type { PanelMovie } from '../types';
import LoadingSpinner from './LoadingSpinner.vue';

interface ReleaseRow {
  index: number;
  title: string;
  quality: string;
  size: string;
  hosters: string;
  isCurrent: boolean;
  links: { hoster: string; url: string }[];
}

const props = defineProps<{
  movie: PanelMovie | null;
  /** uuid of the JD package currently downloading this title — removed on switch. */
  currentPkgUuid?: number | null;
  /** name of the current JD package — used to flag the matching release as "aktuell". */
  currentName?: string | null;
}>();

const emit = defineEmits<{ close: []; switched: [] }>();

const toast = useToast();
const loading = ref(true);
const switching = ref(false);
const error = ref<string | null>(null);
const releases = ref<ReleaseRow[]>([]);
const selected = ref<number | null>(null);

// Collapse a release/package name to a comparable core so we can flag which
// listed release is the one already downloading. Best-effort only.
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

onMounted(async () => {
  if (!props.movie) { loading.value = false; return; }
  try {
    const res = await searchReleases({
      query: props.movie.title,
      year: props.movie.year,
      mediaType: props.movie.media_type || 'movie',
    });
    const currentNorm = props.currentName ? normalize(props.currentName) : '';
    releases.value = (res.data.releases || []).map((r: any) => {
      const hosters = [...new Set((r.links || []).map((l: any) => l.hoster))].join(', ');
      const relNorm = normalize(r.title || '');
      const isCurrent = !!currentNorm && relNorm.length > 0 &&
        (currentNorm.includes(relNorm) || relNorm.includes(currentNorm));
      return {
        index: r.index,
        title: r.title || 'Unbenannt',
        quality: r.quality || '',
        size: r.size || '',
        hosters,
        isCurrent,
        links: r.links || [],
      };
    });
  } catch (err: any) {
    error.value = err.response?.data?.error || 'Suche fehlgeschlagen';
  } finally {
    loading.value = false;
  }
});

function onClose() {
  if (switching.value) return;
  emit('close');
}

async function confirm() {
  if (selected.value === null || !props.movie) return;
  const rel = releases.value.find(r => r.index === selected.value);
  if (!rel || rel.links.length === 0) {
    toast.value?.add('Dieses Release hat keine Links', 'warning');
    return;
  }
  switching.value = true;
  try {
    // Abandon the current package first so JD doesn't keep the dead/old one.
    // It may sit in either the download list or the linkgrabber — try both;
    // a uuid that isn't in one list is simply a no-op there.
    if (props.currentPkgUuid != null) {
      const uuid = props.currentPkgUuid;
      await Promise.allSettled([
        removeJDPackages([uuid]),
        removeJDLinkGrabberPackages([uuid]),
      ]);
    }
    await downloadRelease({
      title: props.movie.title,
      year: props.movie.year,
      mediaType: props.movie.media_type || 'movie',
      imdbId: props.movie.imdb_id || undefined,
      links: rel.links,
    });
    toast.value?.add('Quelle gewechselt — neues Release wird geladen', 'success');
    emit('switched');
  } catch (err: any) {
    toast.value?.add(err.response?.data?.error || 'Quellenwechsel fehlgeschlagen', 'error');
    switching.value = false;
  }
}
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9998;
  backdrop-filter: blur(2px);
  padding: 20px;
}
.modal-box {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  max-width: 420px;
  width: 100%;
}
.modal-box-wide {
  max-width: 580px;
  max-height: 90vh;
  overflow-y: auto;
}
.modal-title {
  font-size: 1.1rem;
  margin-bottom: 2px;
}
.modal-sub {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin-bottom: 16px;
}
.state-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 0.9rem;
  padding: 18px 4px;
}
.state-error { color: var(--color-danger, #e05260); }

.release-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 52vh;
  overflow-y: auto;
}
.release-row {
  display: grid;
  grid-template-columns: 18px 60px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.release-row:hover { border-color: var(--text-secondary); }
.release-row.selected {
  border-color: var(--color-accent, #d4a017);
  background: rgba(212, 160, 23, 0.08);
}
.radio {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 2px solid var(--text-secondary);
}
.radio.on {
  border-color: var(--color-accent, #d4a017);
  background:
    radial-gradient(circle, var(--color-accent, #d4a017) 0 4px, transparent 5px);
}
.rel-q {
  font-size: 0.78rem;
  font-weight: 700;
  text-align: center;
  padding: 2px 0;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.07);
}
.rel-title {
  font-size: 0.85rem;
  word-break: break-word;
  display: flex;
  align-items: center;
  gap: 8px;
}
.badge-current {
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--color-accent, #d4a017);
  border: 1px solid var(--color-accent, #d4a017);
  border-radius: 4px;
  padding: 1px 5px;
  flex-shrink: 0;
}
.rel-meta {
  font-size: 0.78rem;
  color: var(--text-secondary);
  white-space: nowrap;
}
.modal-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 18px;
}
@media (max-width: 768px) {
  .release-row {
    grid-template-columns: 16px 50px 1fr;
  }
  .rel-meta { grid-column: 2 / -1; }
  .modal-actions { flex-direction: column-reverse; }
  .modal-actions .btn { width: 100%; }
}
</style>
