<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible" ref="modalRoot" class="modal-backdrop" @click.self="close" @keydown.escape="close" role="dialog" aria-modal="true" aria-label="Film-Details">
        <div class="modal-box">
          <div class="modal-header">
            <h3>{{ movie?.title }} <span v-if="movie?.year" class="modal-year">({{ movie.year }})</span></h3>
            <button class="modal-close-btn" @click="close" aria-label="Schließen">&times;</button>
          </div>

          <div v-if="loading" class="text-center" style="padding: 30px;">
            <LoadingSpinner text="Lade Details..." />
          </div>

          <div v-else-if="detail" class="modal-content">
            <div class="detail-hero">
              <div class="detail-hero-poster">
                <Poster :imdb-id="detail.imdb_id" :title="detail.title" />
              </div>
              <div class="detail-grid">
              <div class="detail-item">
                <span class="detail-label">Status</span>
                <span :class="'badge badge-' + detail.status">{{ statusLabel(detail.status) }}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Qualität</span>
                <span>
                  <template v-if="actualQuality">{{ actualQuality }}</template>
                  <template v-else>{{ detail.desired_quality }}</template>
                  <span v-if="actualQuality && actualQuality !== detail.desired_quality" class="text-secondary text-sm"> (gewünscht: {{ detail.desired_quality }})</span>
                </span>
              </div>
              <div class="detail-item" v-if="detail.imdb_id">
                <span class="detail-label">IMDb</span>
                <a :href="'https://www.imdb.com/title/' + detail.imdb_id" target="_blank" rel="noopener" class="link-accent">{{ detail.imdb_id }}</a>
              </div>
              <div class="detail-item" v-if="detail.source_url">
                <span class="detail-label">Quelle</span>
                <a :href="detail.source_url" target="_blank" rel="noopener" class="link-accent">{{ sourceHost(detail.source_url) }}</a>
              </div>
              <div class="detail-item" v-if="detail.last_checked_at">
                <span class="detail-label">Zuletzt geprüft</span>
                <span>{{ formatDateFull(detail.last_checked_at) }}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Hinzugefügt</span>
                <span>{{ formatDateFull(detail.added_at) }}</span>
              </div>
              </div>
            </div>

            <!-- Download history -->
            <div v-if="detail.downloads && detail.downloads.length > 0" class="mt-lg">
              <h4 class="mb-md">Downloads</h4>
              <div v-for="dl in detail.downloads" :key="dl.id" class="download-entry">
                <span class="badge badge-info">{{ dl.quality }}</span>
                <span>{{ dl.release_name || 'Unbekannt' }}</span>
                <span class="text-secondary text-sm">{{ dl.hoster }}</span>
              </div>
            </div>

            <!-- Activity logs -->
            <div v-if="detail.logs && detail.logs.length > 0" class="mt-lg">
              <h4 class="mb-md">Aktivitäts-Log</h4>
              <div class="log-list">
                <div v-for="log in detail.logs" :key="log.id" class="log-entry">
                  <span class="log-time">{{ formatDateFull(log.created_at) }}</span>
                  <span :class="'badge badge-' + actionColor(log.action)" style="font-size: 0.75em;">{{ formatAction(log.action) }}</span>
                  <span class="log-details">{{ log.details || '' }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn btn-secondary" @click="close">Schließen</button>
            <button class="btn btn-primary" @click="$emit('retry', movie?.id)" :disabled="movie?.status === 'downloading'">Retry</button>
            <button class="btn btn-danger" @click="$emit('delete', movie)">Löschen</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { getMovie } from '../api/index';
import type { Movie, MovieDetail } from '../types/index';
import { formatDateFull, statusLabel, formatAction, actionColor, sourceHost } from '../composables/useFormatters';
import { useModalA11y } from '../composables/useModalA11y';
import LoadingSpinner from './LoadingSpinner.vue';
import Poster from './Poster.vue';

defineEmits(['retry', 'delete']);

const visible = ref(false);
const loading = ref(false);
const movie = ref<Movie | null>(null);
const detail = ref<MovieDetail | null>(null);
const modalRoot = ref<HTMLElement>();
useModalA11y(visible, modalRoot);

const actualQuality = computed(() => {
  const downloads = detail.value?.downloads;
  if (downloads && downloads.length > 0) return downloads[0].quality;
  return null;
});

async function open(m: Movie) {
  movie.value = m;
  visible.value = true;
  loading.value = true;
  try {
    const res = await getMovie(m.id);
    detail.value = res.data;
  } catch {
    detail.value = { ...m, added_at: m.created_at, downloads: [], logs: [] };
  } finally {
    loading.value = false;
  }
}

function close() {
  visible.value = false;
  detail.value = null;
}

defineExpose({ open, close });
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
}

.modal-box {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  max-width: 600px;
  width: 90%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px 12px;
  border-bottom: 1px solid var(--border);
}

.modal-header h3 { font-size: 1.1rem; }
.modal-year { color: var(--text-secondary); font-weight: normal; }

.modal-close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 1.5em;
  cursor: pointer;
  line-height: 1;
  padding: var(--gap-xs);
  border-radius: var(--gap-xs);
  transition: color var(--duration-fast), background var(--duration-fast);
}

.modal-close-btn:hover { color: var(--text-primary); background: rgba(255, 255, 255, 0.05); }
.modal-close-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.modal-content {
  padding: 16px 24px;
  overflow-y: auto;
  flex: 1;
}

.modal-footer {
  padding: 12px 24px 20px;
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  border-top: 1px solid var(--border);
}

.detail-hero {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 4px;
}

.detail-hero-poster {
  flex-shrink: 0;
  width: 110px;
  border-radius: 6px;
  overflow: hidden;
  background: linear-gradient(160deg, #2a1a2a, #1a1c21);
  box-shadow: 0 6px 20px -8px rgba(0, 0, 0, 0.6);
}

.detail-hero .detail-grid {
  flex: 1;
  min-width: 0;
}

.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.detail-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-label {
  font-size: 0.8em;
  color: var(--text-secondary);
  text-transform: uppercase;
}

.download-entry {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
  font-size: 0.9em;
}

.log-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.log-entry {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 0.85em;
}

.log-time {
  color: var(--text-secondary);
  white-space: nowrap;
  font-size: 0.9em;
}

.log-details {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modal-enter-active { transition: opacity 0.2s; }
.modal-leave-active { transition: opacity 0.15s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }

@media (max-width: 768px) {
  .modal-box {
    width: 96%;
    max-height: 85vh;
    border-radius: 10px;
    margin: 0 auto;
  }

  .modal-header {
    padding: 16px 16px 10px;
  }

  .modal-header h3 {
    font-size: 1rem;
  }

  .modal-content {
    padding: 12px 16px;
  }

  .detail-hero {
    gap: 12px;
  }

  .detail-hero-poster {
    width: 84px;
  }

  .detail-grid {
    grid-template-columns: 1fr;
    gap: 10px;
  }

  .modal-footer {
    padding: 12px 16px 16px;
    flex-wrap: wrap;
  }

  .modal-footer .btn {
    flex: 1;
    justify-content: center;
    min-height: 44px;
  }

  .log-entry {
    flex-wrap: wrap;
    gap: 4px 8px;
  }

  .log-time {
    width: 100%;
    font-size: 0.8em;
  }

  .download-entry {
    flex-wrap: wrap;
    gap: 4px 8px;
  }
}
</style>
