<template>
  <div>
    <div class="section-header">
      <h2>Mediathek</h2>
      <div class="flex-row-wrap">
        <div class="library-tabs" role="tablist" aria-label="Mediathek-Typ">
          <button
            type="button"
            role="tab"
            class="library-tab"
            :class="{ 'is-active': filter === 'movie' }"
            :aria-selected="filter === 'movie'"
            @click="filter = 'movie'"
          >Filme <span class="library-tab-count">{{ totalByType.movie }}</span></button>
          <button
            type="button"
            role="tab"
            class="library-tab"
            :class="{ 'is-active': filter === 'show' }"
            :aria-selected="filter === 'show'"
            @click="filter = 'show'"
          >Serien <span class="library-tab-count">{{ totalByType.show }}</span></button>
        </div>
        <div class="search-wrapper">
          <span class="search-icon" aria-hidden="true"><Search :size="14" /></span>
          <input
            v-model="search"
            placeholder="Bibliothek durchsuchen..."
            class="search-input"
            aria-label="Mediathek durchsuchen"
            ref="searchInput"
          />
        </div>
        <span class="text-secondary text-sm">{{ filteredItems.length }} Einträge</span>
      </div>
    </div>

    <div v-if="source === 'none' && !loading" class="alert alert-error">
      Keine Mediathek konfiguriert. Media Server in den Einstellungen verbinden.
    </div>

    <SkeletonLoader v-if="loading" variant="grid" :count="12" />

    <div v-else-if="source !== 'none' && sortedItems.length > 0" class="library-layout">
      <div class="library-grid stagger-in" ref="gridRef">
        <div
          v-for="(item, idx) in sortedItems"
          :key="item.id"
          class="library-item"
          :data-bucket-anchor="bucketAnchors[idx]"
        >
          <div class="library-poster">
            <img v-if="item.posterUrl" :src="item.posterUrl" :alt="item.name" loading="lazy" decoding="async" @error="onImgError" />
            <div v-else class="library-poster-placeholder" :aria-label="item.name">
              {{ item.mediaType === 'show' ? 'S' : 'F' }}
            </div>
            <div class="library-poster-overlay">
              <span class="library-overlay-title">{{ item.name }}</span>
              <span v-if="item.year" class="library-overlay-year">{{ item.year }}</span>
            </div>
            <span class="library-type-badge">{{ item.mediaType === 'show' ? 'Serie' : 'Film' }}</span>
            <button
              class="library-delete-btn"
              @click.stop="confirmDelete(item)"
              aria-label="Aus Bibliothek löschen"
            >&times;</button>
          </div>
          <div class="library-info">
            <strong><HighlightText :text="item.name" :query="debouncedSearch" /></strong>
            <span class="library-year">{{ item.year }}</span>
          </div>
        </div>
      </div>

      <aside v-if="availableBuckets.size > 1" class="alphabet-bar" aria-label="Sprungnavigation">
        <button
          v-for="letter in ALPHABET"
          :key="letter"
          type="button"
          class="alpha-btn"
          :class="{ 'is-disabled': !availableBuckets.has(letter) }"
          :disabled="!availableBuckets.has(letter)"
          :aria-label="letter === '#' ? 'Zu Zahlen und Sonderzeichen springen' : 'Zu ' + letter + ' springen'"
          @click="jumpTo(letter)"
        >{{ letter }}</button>
      </aside>
    </div>

    <div v-if="!loading && source !== 'none' && sortedItems.length === 0" class="card">
      <EmptyState
        icon="Search"
        :title="emptyStateTitle"
        :description="emptyStateDescription"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { getLibrary, deleteLibraryItem } from '../api/index';
import type { LibraryItem } from '../types/index';
import { useToast, useConfirm } from '../composables/useApp';
import { useDebouncedRef } from '../composables/useDebounce';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import EmptyState from '../components/EmptyState.vue';
import HighlightText from '../components/HighlightText.vue';
import { Search } from 'lucide-vue-next';
import { useSearchShortcut } from '../composables/useSearchShortcut';

const toast = useToast();
const confirmModal = useConfirm();

const items = ref<LibraryItem[]>([]);
const source = ref('none');
const loading = ref(true);
const filter = ref<'movie' | 'show'>('movie');
const search = ref('');
const debouncedSearch = useDebouncedRef(search);
const searchInput = ref<HTMLInputElement>();
const gridRef = ref<HTMLElement | null>(null);

const ALPHABET = ['#', 'A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];
const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

// 'Über' → 'U', '300' → '#', leading 'The ' is kept (Plex/Jellyfin already normalize this in sortTitle).
function bucketOf(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return '#';
  // Strip combining diacritics (\p{Mn}) so 'Über' → 'U', 'Éclat' → 'E'.
  const first = trimmed.normalize('NFD').replace(/\p{Mn}/gu, '').charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : '#';
}

const totalByType = computed(() => ({
  movie: items.value.filter(i => i.mediaType === 'movie').length,
  show: items.value.filter(i => i.mediaType === 'show').length,
}));

const filteredItems = computed(() => {
  let result = items.value.filter(i => i.mediaType === filter.value);

  if (debouncedSearch.value.trim()) {
    const q = debouncedSearch.value.toLowerCase();
    result = result.filter(i => i.name?.toLowerCase().includes(q));
  }

  return result;
});

const sortedItems = computed(() =>
  [...filteredItems.value].sort((a, b) => collator.compare(a.name || '', b.name || ''))
);

// Per-index: letter if this item starts a new bucket, else undefined. Drives data-bucket-anchor for scroll targets.
const bucketAnchors = computed(() => {
  const out: (string | undefined)[] = [];
  let last: string | null = null;
  for (const item of sortedItems.value) {
    const b = bucketOf(item.name);
    if (b !== last) { out.push(b); last = b; } else { out.push(undefined); }
  }
  return out;
});

const availableBuckets = computed(() => {
  const set = new Set<string>();
  for (const item of sortedItems.value) set.add(bucketOf(item.name));
  return set;
});

const emptyStateTitle = computed(() =>
  debouncedSearch.value.trim()
    ? 'Keine Treffer für die Suche'
    : filter.value === 'movie' ? 'Keine Filme in der Mediathek' : 'Keine Serien in der Mediathek'
);

const emptyStateDescription = computed(() =>
  debouncedSearch.value.trim() ? 'Suchbegriff anpassen oder leeren.' : ''
);

function jumpTo(letter: string) {
  if (!availableBuckets.value.has(letter)) return;
  const el = gridRef.value?.querySelector(
    `[data-bucket-anchor="${CSS.escape(letter)}"]`
  ) as HTMLElement | null;
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onImgError(e: Event) {
  (e.target as HTMLImageElement).style.display = 'none';
}

async function loadLibrary() {
  loading.value = true;
  try {
    const res = await getLibrary();
    items.value = res.data.items || [];
    source.value = res.data.source || 'none';
  } catch {
    source.value = 'none';
  } finally {
    loading.value = false;
  }
}

async function confirmDelete(item: LibraryItem) {
  const ok = await confirmModal.value?.show({
    title: 'Aus Bibliothek löschen',
    message: `"${item.name} (${item.year})" wirklich löschen? Die Dateien werden ebenfalls entfernt.`,
    confirmText: 'Löschen',
    danger: true,
  });
  if (!ok) return;

  try {
    await deleteLibraryItem(item.id);
    items.value = items.value.filter(i => i.id !== item.id);
    toast.value?.add('Erfolgreich gelöscht', 'success');
  } catch {
    toast.value?.add('Löschen fehlgeschlagen', 'error');
  }
}

useSearchShortcut(searchInput);

onMounted(() => {
  loadLibrary();
});
</script>

<style scoped>
.library-layout {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.library-tabs {
  display: inline-flex;
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 3px;
  gap: 2px;
}

.library-tab {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 0.9em;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: background var(--duration-fast), color var(--duration-fast);
}

.library-tab:hover:not(.is-active) {
  color: var(--text-primary);
}

.library-tab.is-active {
  background: var(--accent);
  color: #fff;
}

.library-tab-count {
  font-size: 0.8em;
  opacity: 0.8;
  font-weight: 500;
}

.library-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.alphabet-bar {
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 4px;
  background: var(--bg-secondary);
  border-radius: 8px;
  flex-shrink: 0;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  scrollbar-width: none;
}

.alphabet-bar::-webkit-scrollbar { display: none; }

.alpha-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 0.75em;
  font-weight: 600;
  width: 22px;
  height: 18px;
  line-height: 1;
  border-radius: 3px;
  cursor: pointer;
  padding: 0;
  transition: background var(--duration-fast), color var(--duration-fast);
}

.alpha-btn:not(:disabled):hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.alpha-btn.is-disabled {
  opacity: 0.25;
  cursor: default;
}

@media (max-width: 768px) {
  .alphabet-bar {
    padding: 4px 2px;
  }
  .alpha-btn {
    width: 18px;
    height: 16px;
    font-size: 0.65em;
  }
}

@media (max-width: 768px) {
  .library-grid {
    grid-template-columns: repeat(3, 1fr);
    gap: var(--gap-sm);
  }

  .library-info strong {
    font-size: 0.8em;
  }

  .library-year {
    font-size: 0.7em;
  }

  .library-type-badge {
    font-size: 0.65em;
    padding: 2px 5px;
  }

  .library-delete-btn {
    opacity: 0.7;
    width: 32px;
    height: 32px;
    font-size: 16px;
  }
}

.library-item {
  background: var(--bg-secondary);
  border-radius: 8px;
  overflow: hidden;
  transition: transform var(--duration-fast), box-shadow var(--duration-fast);
  scroll-margin-top: 16px;
}

.library-item:hover {
  transform: translateY(-3px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
}

.library-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.library-poster {
  position: relative;
  aspect-ratio: 2/3;
  overflow: hidden;
  background: var(--bg-primary);
}

.library-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.library-poster-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2em;
  color: var(--text-secondary);
  background: var(--bg-primary);
}

.library-poster-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.3) 50%, transparent 100%);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 8px;
  opacity: 0;
  transition: opacity var(--duration-normal);
  pointer-events: none;
}

.library-item:hover .library-poster-overlay {
  opacity: 1;
}

.library-overlay-title {
  color: #fff;
  font-size: 0.8em;
  font-weight: 600;
  line-height: 1.2;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.library-overlay-year {
  color: rgba(255, 255, 255, 0.7);
  font-size: 0.7em;
}

/* Touch: show overlay always on touch devices */
@media (hover: none) {
  .library-poster-overlay {
    opacity: 0;
  }
}

.library-delete-btn {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgba(200, 0, 0, 0.8);
  color: white;
  border: none;
  border-radius: 50%;
  width: 28px;
  height: 28px;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--duration-fast);
  display: flex;
  align-items: center;
  justify-content: center;
}

.library-item:hover .library-delete-btn {
  opacity: 1;
}

/* Touch devices: always show delete button */
@media (hover: none) {
  .library-delete-btn {
    opacity: 0.7;
  }
}

.library-delete-btn:hover {
  background: rgba(230, 0, 0, 1);
}

.library-type-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  font-size: 0.7em;
  padding: 2px 6px;
  border-radius: 4px;
}

.library-info {
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.library-info strong {
  font-size: 0.85em;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.library-year {
  font-size: 0.75em;
  color: var(--text-secondary);
}
</style>
