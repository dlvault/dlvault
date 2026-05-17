<template>
  <details class="card settings-section" open>
    <summary class="card-toggle"><h2>Verzeichnisse</h2></summary>
    <p class="section-hint">
      Pfade innerhalb des Containers. Normalerweise muessen diese nicht geaendert werden —
      die Defaults passen wenn die Docker Volume-Mounts korrekt gesetzt sind.
    </p>
    <div class="form-grid">
      <div class="form-group">
        <label for="path-downloads">Download-Verzeichnis <small class="text-secondary">(JDownloader Output)</small></label>
        <input id="path-downloads" v-model="settings['paths.downloads']" placeholder="/downloads" />
        <PathStatus :status="pathStatus['paths.downloads']" />
      </div>
      <div class="form-group">
        <label for="path-movies">Film-Verzeichnis <small class="text-secondary">({{ settings['library.provider'] === 'plex' ? 'Plex' : 'Jellyfin' }} Library)</small></label>
        <input id="path-movies" v-model="settings['paths.movies']" placeholder="/movies" />
        <PathStatus :status="pathStatus['paths.movies']" />
      </div>
      <div class="form-group">
        <label for="path-series">Serien-Verzeichnis <small class="text-secondary">({{ settings['library.provider'] === 'plex' ? 'Plex' : 'Jellyfin' }} Library)</small></label>
        <input id="path-series" v-model="settings['paths.series']" placeholder="/series" />
        <PathStatus :status="pathStatus['paths.series']" />
      </div>
    </div>
    <button class="btn btn-secondary btn-sm mt-sm" @click="checkPaths" :disabled="checking">
      {{ checking ? 'Pruefe...' : 'Pfade pruefen' }}
    </button>
  </details>
</template>

<script setup lang="ts">
import { ref, onMounted, defineComponent, h } from 'vue';
import { useSettingsContext } from '../../composables/useSettingsContext';
import { validatePaths } from '../../api/index';

interface PathResult {
  exists: boolean;
  writable: boolean;
  empty: boolean;
  error?: string;
}

const { settings } = useSettingsContext();
const pathStatus = ref<Record<string, PathResult>>({});
const checking = ref(false);

async function checkPaths() {
  checking.value = true;
  try {
    const res = await validatePaths();
    pathStatus.value = res.data;
  } catch {
    // ignore
  } finally {
    checking.value = false;
  }
}

onMounted(() => {
  // Auto-check paths on load after a short delay (settings need to load first)
  setTimeout(checkPaths, 1500);
});

const PathStatus = defineComponent({
  props: {
    status: { type: Object as () => PathResult | undefined, default: undefined },
  },
  setup(props) {
    return () => {
      const s = props.status;
      if (!s) return null;

      if (s.error) {
        return h('div', { class: 'path-status path-error' }, [
          h('span', { class: 'status-icon' }, '\u26A0'),
          h('span', s.error),
        ]);
      }

      return h('div', { class: 'path-status path-ok' }, [
        h('span', { class: 'status-icon' }, '\u2713'),
        h('span', 'OK — Pfad existiert und ist beschreibbar'),
      ]);
    };
  },
});
</script>

<style scoped>
.text-secondary {
  color: var(--text-secondary);
}

.mt-sm {
  margin-top: 8px;
}

.path-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
  margin-top: 4px;
  padding: 4px 8px;
  border-radius: 4px;
}

.path-error {
  color: var(--warning, #e6a23c);
  background: rgba(230, 162, 60, 0.1);
}

.path-ok {
  color: var(--success, #67c23a);
  background: rgba(103, 194, 58, 0.1);
}

.status-icon {
  font-weight: bold;
  font-size: 0.95rem;
}
</style>
