<template>
  <Teleport to="body">
    <Transition name="palette">
      <div v-if="visible" ref="modalRoot" class="palette-backdrop" @click.self="close" @keydown.escape="close">
        <div class="palette-box" role="dialog" aria-modal="true" aria-label="Command Palette">
          <div class="palette-input-wrapper">
            <span class="palette-icon" aria-hidden="true"><Search :size="16" /></span>
            <input
              ref="inputEl"
              v-model="query"
              placeholder="Seite, Film oder Aktion suchen..."
              class="palette-input"
              @keydown.down.prevent="moveSelection(1)"
              @keydown.up.prevent="moveSelection(-1)"
              @keydown.enter.prevent="executeSelected"
              aria-label="Suche"
              autocomplete="off"
              spellcheck="false"
            />
            <kbd class="palette-kbd">ESC</kbd>
          </div>

          <div v-if="filteredItems.length > 0" class="palette-results" ref="resultsEl">
            <div class="palette-group" v-if="filteredPages.length > 0">
              <div class="palette-group-label">Seiten</div>
              <button
                v-for="(item, i) in filteredPages"
                :key="'p-' + item.id"
                :class="['palette-item', { 'palette-item-active': selectedIndex === getGlobalIndex('pages', i) }]"
                @click="execute(item)"
                @mouseenter="selectedIndex = getGlobalIndex('pages', i)"
              >
                <span class="palette-item-icon" aria-hidden="true">
                  <component :is="item.icon" :size="16" />
                </span>
                <span class="palette-item-label">{{ item.label }}</span>
                <span v-if="item.hint" class="palette-item-hint">{{ item.hint }}</span>
              </button>
            </div>

            <div class="palette-group" v-if="filteredActions.length > 0">
              <div class="palette-group-label">Aktionen</div>
              <button
                v-for="(item, i) in filteredActions"
                :key="'a-' + item.id"
                :class="['palette-item', { 'palette-item-active': selectedIndex === getGlobalIndex('actions', i) }]"
                @click="execute(item)"
                @mouseenter="selectedIndex = getGlobalIndex('actions', i)"
              >
                <span class="palette-item-icon" aria-hidden="true">
                  <component :is="item.icon" :size="16" />
                </span>
                <span class="palette-item-label">{{ item.label }}</span>
                <span v-if="item.hint" class="palette-item-hint">{{ item.hint }}</span>
              </button>
            </div>

            <div class="palette-group" v-if="filteredMovies.length > 0">
              <div class="palette-group-label">Filme</div>
              <button
                v-for="(item, i) in filteredMovies"
                :key="'m-' + item.id"
                :class="['palette-item', { 'palette-item-active': selectedIndex === getGlobalIndex('movies', i) }]"
                @click="execute(item)"
                @mouseenter="selectedIndex = getGlobalIndex('movies', i)"
              >
                <span class="palette-item-icon" aria-hidden="true">
                  <Film :size="16" />
                </span>
                <span class="palette-item-label">{{ item.label }}</span>
                <span class="palette-item-hint">{{ item.hint }}</span>
              </button>
            </div>
          </div>

          <div v-else-if="query.trim()" class="palette-empty">
            Keine Ergebnisse für "{{ query }}"
          </div>

          <div class="palette-footer">
            <span><kbd>&uarr;</kbd><kbd>&darr;</kbd> Navigieren</span>
            <span><kbd>Enter</kbd> Ausführen</span>
            <span><kbd>Esc</kbd> Schließen</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import type { Component } from 'vue';
import { useRouter } from 'vue-router';
import { useMoviesStore } from '../stores/movies';
import { useSyncStore } from '../stores/sync';
import { useToast } from '../composables/useApp';
import { useModalA11y } from '../composables/useModalA11y';
import { statusLabel } from '../composables/useFormatters';
import {
  Search, LayoutDashboard, ListVideo, Library, Download,
  Settings, FileText, Zap, Film,
} from 'lucide-vue-next';

interface PaletteItem {
  id: string;
  label: string;
  icon: Component;
  hint?: string;
  group: 'pages' | 'actions' | 'movies';
  action: () => void;
}

const router = useRouter();
const moviesStore = useMoviesStore();
const syncStore = useSyncStore();
const toast = useToast();

const visible = ref(false);
const query = ref('');
const selectedIndex = ref(0);
const inputEl = ref<HTMLInputElement>();
const resultsEl = ref<HTMLElement>();
const modalRoot = ref<HTMLElement>();
useModalA11y(visible, modalRoot);

const pages: PaletteItem[] = [
  { id: 'nav-dashboard', label: 'Dashboard', icon: LayoutDashboard, hint: '/', group: 'pages', action: () => router.push('/') },
  { id: 'nav-movies', label: 'Warteschlange', icon: ListVideo, hint: '/movies', group: 'pages', action: () => router.push('/movies') },
  { id: 'nav-library', label: 'Mediathek', icon: Library, hint: '/library', group: 'pages', action: () => router.push('/library') },
  { id: 'nav-downloads', label: 'Downloads', icon: Download, hint: '/downloads', group: 'pages', action: () => router.push('/downloads') },
  { id: 'nav-settings', label: 'Einstellungen', icon: Settings, hint: '/settings', group: 'pages', action: () => router.push('/settings') },
  { id: 'nav-logs', label: 'Logs', icon: FileText, hint: '/logs', group: 'pages', action: () => router.push('/logs') },
];

const actions: PaletteItem[] = [
  {
    id: 'action-sync', label: 'Sync starten', icon: Zap, hint: 'Watchlist synchronisieren', group: 'actions',
    action: async () => {
      const ok = await syncStore.triggerSync();
      toast.value?.add(ok ? 'Sync gestartet!' : 'Sync fehlgeschlagen', ok ? 'success' : 'error');
    },
  },
];

function matchesQuery(item: PaletteItem, q: string): boolean {
  return item.label.toLowerCase().includes(q) || (item.hint?.toLowerCase().includes(q) ?? false);
}

const filteredPages = computed(() => {
  if (!query.value.trim()) return pages;
  const q = query.value.toLowerCase();
  return pages.filter(p => matchesQuery(p, q));
});

const filteredActions = computed(() => {
  if (!query.value.trim()) return actions;
  const q = query.value.toLowerCase();
  return actions.filter(a => matchesQuery(a, q));
});

const filteredMovies = computed(() => {
  if (!query.value.trim()) return [];
  const q = query.value.toLowerCase();
  return moviesStore.movies
    .filter(m => m.title.toLowerCase().includes(q) || String(m.year).includes(q))
    .slice(0, 6)
    .map(m => ({
      id: `movie-${m.id}`,
      label: `${m.title} (${m.year})`,
      icon: Film,
      hint: statusLabel(m.status),
      group: 'movies' as const,
      action: () => router.push({ path: '/movies', query: { highlight: String(m.id) } }),
    }));
});

const filteredItems = computed(() => [
  ...filteredPages.value,
  ...filteredActions.value,
  ...filteredMovies.value,
]);

function getGlobalIndex(group: string, localIndex: number): number {
  if (group === 'pages') return localIndex;
  if (group === 'actions') return filteredPages.value.length + localIndex;
  return filteredPages.value.length + filteredActions.value.length + localIndex;
}

watch(query, () => {
  selectedIndex.value = 0;
});

function moveSelection(delta: number) {
  const len = filteredItems.value.length;
  if (len === 0) return;
  selectedIndex.value = (selectedIndex.value + delta + len) % len;
  nextTick(() => {
    const active = resultsEl.value?.querySelector('.palette-item-active');
    active?.scrollIntoView({ block: 'nearest' });
  });
}

function executeSelected() {
  const item = filteredItems.value[selectedIndex.value];
  if (item) execute(item);
}

function execute(item: PaletteItem) {
  close();
  item.action();
}

function open() {
  visible.value = true;
  query.value = '';
  selectedIndex.value = 0;
  moviesStore.fetch();
  nextTick(() => inputEl.value?.focus());
}

function close() {
  visible.value = false;
}

function toggle() {
  if (visible.value) close();
  else open();
}

function handleKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    toggle();
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
});

defineExpose({ open, close, toggle });
</script>

<style scoped>
.palette-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
  z-index: 9999;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.palette-box {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  width: 580px;
  max-width: 92vw;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-2);
  overflow: hidden;
}

.palette-input-wrapper {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}

.palette-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  flex-shrink: 0;
}

.palette-input {
  flex: 1;
  background: none;
  border: none;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 15px;
  outline: none;
}

.palette-input::placeholder {
  color: var(--text-3);
}

.palette-kbd {
  background: var(--surface-2);
  color: var(--text-secondary);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  border: 1px solid var(--line-2);
}

.palette-results {
  overflow-y: auto;
  flex: 1;
  padding: 6px 0;
}

.palette-group {
  padding: 4px 0;
}

.palette-group-label {
  padding: 6px 16px 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  color: var(--text-3);
  font-weight: 500;
  letter-spacing: 0.1em;
}

.palette-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 16px;
  background: none;
  border: none;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  transition: background 0.08s;
}

.palette-item:hover,
.palette-item-active {
  background: var(--accent-soft);
}

.palette-item-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  flex-shrink: 0;
  color: var(--text-3);
}

.palette-item-active .palette-item-icon,
.palette-item:hover .palette-item-icon {
  color: var(--accent);
}

.palette-item-label {
  flex: 1;
}

.palette-item-hint {
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: 11px;
}

.palette-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-3);
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 16px;
}

.palette-footer {
  display: flex;
  gap: 16px;
  padding: 8px 16px;
  border-top: 1px solid var(--line);
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--font-mono);
}

.palette-footer kbd {
  background: var(--surface-2);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-family: var(--font-mono);
  border: 1px solid var(--line-2);
  margin-right: 3px;
}

/* Transitions */
.palette-enter-active { transition: opacity 0.15s ease; }
.palette-leave-active { transition: opacity 0.1s ease; }
.palette-enter-from, .palette-leave-to { opacity: 0; }

@media (max-width: 768px) {
  .palette-backdrop {
    padding-top: 8vh;
  }

  .palette-box {
    max-height: 70vh;
  }

  .palette-footer {
    display: none;
  }
}
</style>
