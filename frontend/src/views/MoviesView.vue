<template>
  <div>
    <div class="section-header">
      <h2>Warteschlange</h2>
      <div class="flex-row-wrap">
        <div class="search-wrapper">
          <span class="search-icon" aria-hidden="true"><Search :size="14" /></span>
          <input
            v-model="search"
            placeholder="Film suchen..."
            class="search-input"
            aria-label="Filme durchsuchen"
            ref="searchInput"
          />
        </div>
        <button class="btn btn-secondary" @click="loadMovies" :disabled="refreshing" aria-label="Sync starten">
          {{ refreshing ? 'Sync läuft…' : 'Aktualisieren' }}
        </button>
        <button class="btn btn-secondary view-toggle-btn" @click="toggleView" :aria-label="viewMode === 'table' ? 'Kartenansicht' : 'Tabellenansicht'">
          <component :is="viewMode === 'table' ? LayoutGrid : Rows3" :size="14" />
        </button>
      </div>
    </div>

    <!-- Faceted filter chips -->
    <div class="filter-chips" role="group" aria-label="Status-Filter">
      <button
        v-for="f in filterOptions"
        :key="f.value"
        :class="['filter-chip', { 'filter-chip-active': statusFilter === f.value }]"
        @click="statusFilter = f.value"
      >
        {{ f.label }}
        <span class="filter-chip-count">{{ f.count }}</span>
      </button>
    </div>

    <!-- Bulk Actions — floating pill, teleported to body so scroll/sticky never clips it -->
    <Teleport to="body">
      <Transition name="bulk-rise">
        <div v-if="selectedIds.length > 0" class="bulk-pill" role="region" aria-label="Bulk-Aktionen">
          <span class="bulk-count">
            <strong>{{ selectedIds.length }}</strong>ausgewählt
          </span>
          <button class="bulk-btn" @click="bulkRetry">
            <RefreshCw :size="14" /> Retry
          </button>
          <button class="bulk-btn danger" @click="bulkDelete">
            <Trash2 :size="14" /> Löschen
          </button>
          <button class="bulk-x" @click="selectedIds = []" aria-label="Auswahl aufheben">
            <X :size="14" />
          </button>
        </div>
      </Transition>
    </Teleport>

    <SkeletonLoader v-if="loading" :variant="viewMode === 'table' ? 'table' : 'grid'" :count="8" />

    <!-- Table View (hidden on mobile via CSS) -->
    <div v-else-if="viewMode === 'table'" class="card table-view">
      <table v-if="pagedMovies.length > 0">
        <thead>
          <tr>
            <th style="width: 32px;">
              <input type="checkbox" :checked="allSelected" @change="toggleAll" aria-label="Alle auswählen" />
            </th>
            <th class="sortable" @click="toggleSort('title')" :aria-sort="ariaSort('title')">
              Titel {{ sortIcon('title') }}
            </th>
            <th class="sortable" @click="toggleSort('year')" :aria-sort="ariaSort('year')">
              Jahr {{ sortIcon('year') }}
            </th>
            <th class="sortable" @click="toggleSort('status')" :aria-sort="ariaSort('status')">
              Status {{ sortIcon('status') }}
            </th>
            <th>Qualität</th>
            <th class="sortable" @click="toggleSort('last_checked_at')" :aria-sort="ariaSort('last_checked_at')">
              Zuletzt geprüft {{ sortIcon('last_checked_at') }}
            </th>
            <th>Aktionen</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="movie in pagedMovies" :key="movie.id" @click="openDetail(movie)" class="table-row-animate cursor-pointer">
            <td @click.stop>
              <input type="checkbox" :checked="selectedIds.includes(movie.id)" @change="toggleSelect(movie.id)" :aria-label="'Auswählen: ' + movie.title" />
            </td>
            <td>
              <strong><HighlightText :text="movie.title" :query="debouncedSearch" /></strong>
              <br v-if="movie.source_url" />
              <a v-if="movie.source_url" :href="movie.source_url" target="_blank" rel="noopener"
                 class="link-accent text-xs" @click.stop>{{ sourceHost(movie.source_url) }}</a>
            </td>
            <td>{{ movie.year }}</td>
            <td>
              <span :class="'badge badge-' + effectiveStatus(movie)">
                {{ statusLabel(effectiveStatus(movie)) }}
              </span>
            </td>
            <td>{{ movie.desired_quality }}</td>
            <td>{{ movie.last_checked_at ? formatDate(movie.last_checked_at) : '-' }}</td>
            <td @click.stop>
              <div class="row-actions">
                <button class="icon-btn" @click="openDetail(movie)" :aria-label="'Detail: ' + movie.title" title="Detail">
                  <SearchIcon :size="14" />
                </button>
                <button class="icon-btn" @click="retry(movie.id)"
                        :disabled="movie.status === 'downloading'" :aria-label="'Retry: ' + movie.title" title="Erneut versuchen">
                  <RefreshCw :size="14" />
                </button>
                <button class="icon-btn danger" @click="remove(movie)" :aria-label="'Löschen: ' + movie.title" title="Löschen">
                  <Trash2 :size="14" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState
        v-else-if="movies.length === 0"
        icon="Popcorn"
        title="Keine Filme in der Warteschlange"
        description="Füge Filme über die Trakt Watchlist hinzu und starte einen Sync."
        action-to="/settings"
        action-label="Einstellungen"
      />
      <EmptyState
        v-else
        icon="Search"
        title="Keine Treffer"
        description="Ändere den Suchbegriff oder Filter."
      />
      <PaginationBar
        v-if="pagedMovies.length > 0"
        :page="page" :total-pages="totalPages" :total-items="sortedMovies.length"
        :per-page="itemsPerPage" :has-prev="hasPrevPage" :has-next="hasNextPage"
        @prev="prevPage" @next="nextPage"
      />
    </div>

    <!-- Card View (also shown on mobile when table is active, via mobile-cards class) -->
    <div v-if="!loading && (viewMode === 'cards' || viewMode === 'table')" :class="viewMode === 'cards' ? 'cards-view' : 'cards-view mobile-fallback'">
      <div v-if="pagedMovies.length > 0" class="movie-rows stagger-in">
        <div v-for="movie in pagedMovies" :key="movie.id" class="movie-row" @click="openDetail(movie)">
          <div class="movie-row-poster" :class="'poster-tone-' + effectiveStatus(movie)">
            <Poster
              :imdb-id="movie.imdb_id"
              :title="movie.title"
            />
          </div>
          <div class="movie-row-body">
            <div class="movie-row-title">
              <strong><HighlightText :text="movie.title" :query="debouncedSearch" /></strong>
              <span class="yr">{{ movie.year }}</span>
            </div>
            <div class="movie-row-meta">
              <span :class="'badge badge-' + effectiveStatus(movie)">{{ statusLabel(effectiveStatus(movie)) }}</span>
              <span class="meta-sep" v-if="movie.desired_quality"></span>
              <span v-if="movie.desired_quality" class="meta-mono">{{ movie.desired_quality }}</span>
              <span class="meta-sep" v-if="movie.last_checked_at"></span>
              <span v-if="movie.last_checked_at" class="meta-mono">{{ formatDate(movie.last_checked_at) }}</span>
              <span class="meta-sep" v-if="movie.media_type === 'show'"></span>
              <span v-if="movie.media_type === 'show'" class="meta-mono">Serie</span>
            </div>
            <div v-if="effectiveStatus(movie) === 'downloading' && progressByPrefix.get(movieKey(movie)) !== undefined" class="movie-row-progress" :title="`${Math.round((progressByPrefix.get(movieKey(movie)) || 0) * 100)}%`">
              <div class="bar" :style="{ width: ((progressByPrefix.get(movieKey(movie)) || 0) * 100).toFixed(0) + '%' }"></div>
            </div>
          </div>
          <div class="movie-row-actions" @click.stop>
            <input type="checkbox" :checked="selectedIds.includes(movie.id)" @change.stop="toggleSelect(movie.id)" :aria-label="'Auswählen: ' + movie.title" @click.stop class="row-checkbox" />
            <button class="icon-btn" @click="retry(movie.id)" :disabled="movie.status === 'downloading'" :aria-label="'Retry: ' + movie.title" title="Erneut versuchen">
              <RefreshCw :size="14" />
            </button>
            <button class="icon-btn danger" @click="remove(movie)" :aria-label="'Löschen: ' + movie.title" title="Löschen">
              <Trash2 :size="14" />
            </button>
            <a v-if="movie.source_url" :href="movie.source_url" target="_blank" rel="noopener" class="icon-btn" @click.stop :aria-label="'Quelle öffnen'" :title="sourceHost(movie.source_url)">
              <ExternalLink :size="14" />
            </a>
          </div>
        </div>
      </div>
      <div v-else-if="movies.length === 0" class="card">
        <EmptyState
          icon="Popcorn"
          title="Keine Filme in der Warteschlange"
          description="Füge Filme über die Trakt Watchlist hinzu und starte einen Sync."
          action-to="/settings"
          action-label="Einstellungen"
        />
      </div>
      <div v-else class="card">
        <EmptyState icon="Search" title="Keine Treffer" description="Ändere den Suchbegriff oder Filter." />
      </div>
      <PaginationBar
        v-if="pagedMovies.length > 0"
        :page="page" :total-pages="totalPages" :total-items="sortedMovies.length"
        :per-page="itemsPerPage" :has-prev="hasPrevPage" :has-next="hasNextPage"
        @prev="prevPage" @next="nextPage"
      />
    </div>

    <MovieDetailModal
      ref="detailModal"
      @retry="retryFromModal"
      @delete="deleteFromModal"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import type { Movie } from '../types/index';
import { useMoviesStore } from '../stores/movies';
import { useDownloadsStore } from '../stores/downloads';
import { useDownloadPolling } from '../composables/useDownloadPolling';
import { useSyncStore } from '../stores/sync';
import { useToast, useConfirm } from '../composables/useApp';
import { useMovieFiltering } from '../composables/useMovieFiltering';
import { formatDate, statusLabel, sourceHost } from '../composables/useFormatters';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import EmptyState from '../components/EmptyState.vue';
import MovieDetailModal from '../components/MovieDetailModal.vue';
import HighlightText from '../components/HighlightText.vue';
import PaginationBar from '../components/PaginationBar.vue';
import Poster from '../components/Poster.vue';
import { useSearchShortcut } from '../composables/useSearchShortcut';
import {
  Search, Search as SearchIcon, RefreshCw, Trash2, ExternalLink, LayoutGrid, Rows3, X,
} from 'lucide-vue-next';

const moviesStore = useMoviesStore();
const dlStore = useDownloadsStore();
useDownloadPolling();
const syncStore = useSyncStore();
const toast = useToast();
const confirmModal = useConfirm();

const detailModal = ref<InstanceType<typeof MovieDetailModal>>();
const searchInput = ref<HTMLInputElement>();
const refreshing = ref(false);
const storedViewMode = localStorage.getItem('dlvault-view-mode');
const viewMode = ref<'table' | 'cards'>(storedViewMode === 'cards' ? 'cards' : 'table');

const movies = computed(() => moviesStore.movies);
const loading = computed(() => moviesStore.loading);

const {
  search, debouncedSearch, statusFilter,
  filterOptions, sortedMovies,
  toggleSort, sortIcon, ariaSort,
  selectedIds, allSelected, toggleAll, toggleSelect,
  paginatedItems: pagedMovies, page, totalPages, hasNextPage, hasPrevPage, nextPage, prevPage, itemsPerPage,
} = useMovieFiltering(movies);

function toggleView() {
  viewMode.value = viewMode.value === 'table' ? 'cards' : 'table';
  localStorage.setItem('dlvault-view-mode', viewMode.value);
}

async function loadMovies() {
  if (refreshing.value) return;
  refreshing.value = true;
  const result = await syncStore.triggerSync();
  if (!result.ok) {
    toast.value?.add(result.error || 'Sync fehlgeschlagen', 'error');
    refreshing.value = false;
    return;
  }
  toast.value?.add('Sync gestartet — Warteschlange wird aktualisiert', 'success');
}

watch(() => syncStore.syncing, (now, before) => {
  if (before && !now && refreshing.value) {
    refreshing.value = false;
    selectedIds.value = [];
    moviesStore.fetch(true);
    toast.value?.add('Sync abgeschlossen', 'success');
  }
});

async function retry(id: number) {
  try {
    await moviesStore.retry(id);
    toast.value?.add('Retry gestartet', 'success');
  } catch (e: unknown) {
    const axiosErr = e as { response?: { data?: { error?: string } } };
    toast.value?.add(axiosErr.response?.data?.error || 'Fehler beim Retry', 'error');
  }
}

async function remove(movie: Movie) {
  const ok = await confirmModal.value?.show({
    title: 'Film löschen',
    message: `"${movie.title} (${movie.year})" wirklich aus der Warteschlange löschen?`,
    confirmText: 'Löschen',
    danger: true,
  });
  if (!ok) return;
  try {
    await moviesStore.remove(movie.id);
    toast.value?.add('Film gelöscht', 'success');
  } catch {
    toast.value?.add('Fehler beim Löschen', 'error');
  }
}

async function runBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = items.slice();
  let ok = 0;
  let fail = 0;
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift() as T;
      try { await fn(item); ok++; } catch { fail++; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return { ok, fail };
}

async function bulkRetry() {
  const ids = [...selectedIds.value];
  const count = ids.length;
  const { ok, fail } = await runBounded(ids, 3, (id) => moviesStore.retry(id));
  selectedIds.value = [];
  if (fail === 0) toast.value?.add(`Retry für ${count} Filme gestartet`, 'success');
  else toast.value?.add(`Retry: ${ok} OK, ${fail} fehlgeschlagen`, 'warning');
}

async function bulkDelete() {
  const ids = [...selectedIds.value];
  const count = ids.length;
  const confirmed = await confirmModal.value?.show({
    title: `${count} Filme löschen`,
    message: `Wirklich ${count} Filme aus der Warteschlange löschen?`,
    confirmText: `${count} löschen`,
    danger: true,
  });
  if (!confirmed) return;
  const { ok, fail } = await runBounded(ids, 3, (id) => moviesStore.remove(id));
  selectedIds.value = [];
  if (fail === 0) toast.value?.add(`${count} Filme gelöscht`, 'success');
  else toast.value?.add(`Löschen: ${ok} OK, ${fail} fehlgeschlagen`, 'warning');
}

function openDetail(movie: Movie) {
  detailModal.value?.open(movie);
}

async function retryFromModal(id: number) {
  await retry(id);
  detailModal.value?.close();
}

async function deleteFromModal(movie: Movie) {
  await remove(movie);
  detailModal.value?.close();
}

useSearchShortcut(searchInput);

function movieKey(movie: Movie): string { return `${movie.title} (${movie.year})`; }

// Index packages by their "Title (Year)" prefix so per-row state checks are O(1)
const extractingByPrefix = computed(() => {
  const map = new Map<string, boolean>();
  for (const pkg of dlStore.packages) {
    const m = (pkg.name || '').match(/^(.+? \(\d{4}\))/);
    if (m) map.set(m[1], dlStore.isExtracting(pkg));
  }
  return map;
});

// Map "Title (Year)" → progress fraction (0..1) for any matching JD package.
const progressByPrefix = computed(() => {
  const map = new Map<string, number>();
  for (const pkg of dlStore.packages) {
    const m = (pkg.name || '').match(/^(.+? \(\d{4}\))/);
    if (!m) continue;
    if (pkg.bytesTotal > 0) {
      const ratio = Math.max(0, Math.min(1, pkg.bytesLoaded / pkg.bytesTotal));
      const prev = map.get(m[1]);
      if (prev === undefined || ratio > prev) map.set(m[1], ratio);
    }
  }
  return map;
});

function effectiveStatus(movie: Movie): string {
  if (movie.status !== 'downloading') return movie.status;
  return extractingByPrefix.value.get(movieKey(movie)) ? 'extracting' : movie.status;
}

onMounted(() => {
  moviesStore.fetch();
  dlStore.fetch();
});
</script>

<style scoped>
.sortable {
  cursor: pointer;
  user-select: none;
}

.sortable:hover {
  color: var(--accent);
}

/* Bulk-Pill — floating, sticky-bottom, backdrop-blur */
.bulk-pill {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 90;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px 10px 18px;
  background: rgba(20, 21, 25, 0.85);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  border: 1px solid var(--line-2);
  border-radius: 999px;
  box-shadow:
    0 12px 40px -8px rgba(0, 0, 0, 0.6),
    0 1px 0 rgba(255, 255, 255, 0.06) inset;
  font-size: 13px;
  color: var(--text-primary);
}

.bulk-count {
  font-family: var(--font-mono);
  color: var(--text-secondary);
  padding-right: 10px;
  border-right: 1px solid var(--line-2);
  font-variant-numeric: tabular-nums;
}

.bulk-count strong {
  color: var(--accent-2);
  margin-right: 4px;
  font-weight: 600;
}

.bulk-btn {
  appearance: none;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid transparent;
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 12.5px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: inherit;
  transition: background var(--duration-fast), color var(--duration-fast);
}

.bulk-btn:hover {
  background: var(--surface-2);
  color: var(--text-primary);
}

.bulk-btn.danger:hover {
  background: rgba(240, 123, 110, 0.12);
  color: var(--err, #f07b6e);
}

.bulk-x {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  appearance: none;
  background: var(--surface-2);
  color: var(--text-secondary);
  border: 1px solid var(--line);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--duration-fast), color var(--duration-fast);
}

.bulk-x:hover { background: var(--surface-3); color: var(--text-primary); }

.bulk-rise-enter-active { transition: all 0.4s cubic-bezier(0.2, 0.8, 0.2, 1); }
.bulk-rise-leave-active { transition: all 0.25s ease; }
.bulk-rise-enter-from,
.bulk-rise-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

@media (max-width: 768px) {
  .bulk-pill {
    bottom: 16px;
    padding: 8px 10px 8px 14px;
    gap: 6px;
    font-size: 12.5px;
  }
}

/* New movie rows — filmic 2:3 poster slot, mono meta, inline progress */
.movie-rows {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.movie-row {
  display: grid;
  grid-template-columns: 56px 1fr auto;
  gap: 16px;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  align-items: center;
  cursor: pointer;
  transition: border-color var(--duration-fast), background var(--duration-fast), transform var(--duration-fast);
}

.movie-row:hover {
  border-color: var(--line-2);
  background: var(--surface-2);
}

.movie-row:active {
  transform: scale(0.998);
}

.movie-row-poster {
  aspect-ratio: 2 / 3;
  width: 56px;
  border-radius: var(--r-sm);
  background: linear-gradient(160deg, #2a1a2a, #1a1c21);
  position: relative;
  overflow: hidden;
  box-shadow: var(--shadow-1);
  flex-shrink: 0;
}

.movie-row-poster::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, transparent 50%, rgba(0, 0, 0, 0.35));
  pointer-events: none;
}

/* Tonal poster gradients per status */
.poster-tone-pending { background: linear-gradient(160deg, rgba(245, 176, 65, 0.32), #1a1c21); }
.poster-tone-searching { background: linear-gradient(160deg, rgba(93, 173, 226, 0.32), #1a1c21); }
.poster-tone-found { background: linear-gradient(160deg, rgba(74, 222, 128, 0.28), #1a1c21); }
.poster-tone-downloading { background: linear-gradient(160deg, rgba(183, 148, 244, 0.36), #1a1c21); }
.poster-tone-extracting { background: linear-gradient(160deg, rgba(93, 173, 226, 0.32), #1a1c21); }
.poster-tone-downloaded { background: linear-gradient(160deg, rgba(74, 222, 128, 0.4), #1a1c21); }
.poster-tone-not_found { background: linear-gradient(160deg, rgba(240, 123, 110, 0.32), #1a1c21); }

.movie-row-body {
  min-width: 0;
}

.movie-row-title {
  font-size: 15px;
  font-weight: 500;
  letter-spacing: -0.005em;
  margin-bottom: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.movie-row-title strong {
  font-weight: 500;
}

.movie-row-title .yr {
  color: var(--text-3);
  font-weight: 400;
  margin-left: 6px;
  font-feature-settings: 'tnum';
  font-variant-numeric: tabular-nums;
}

.movie-row-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--text-3);
  flex-wrap: wrap;
}

.movie-row-meta .meta-mono {
  font-family: var(--font-mono);
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.movie-row-meta .meta-sep {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--text-3);
  opacity: 0.5;
}

.movie-row-progress {
  margin-top: 8px;
  height: 3px;
  background: var(--surface-3);
  border-radius: 2px;
  overflow: hidden;
}

.movie-row-progress .bar {
  height: 100%;
  width: 0;
  background: linear-gradient(90deg, var(--busy), var(--accent));
  border-radius: 2px;
  transition: width 0.3s ease;
}

.movie-row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.row-actions {
  display: flex;
  gap: 4px;
}

.row-checkbox {
  margin-right: 4px;
}

/* Faceted filter chips */
.filter-chips {
  display: flex;
  gap: var(--gap-sm);
  flex-wrap: wrap;
  margin-bottom: var(--gap-lg);
}

/* Filter-Chips — neue Tokens, mono Counter, subtler outline-active */
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 13px;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: var(--fs-sm, 13px);
  cursor: pointer;
  transition: border-color var(--duration-fast), color var(--duration-fast), background var(--duration-fast);
  white-space: nowrap;
  min-height: 36px;
}

.filter-chip:hover {
  border-color: var(--line-2);
  color: var(--text-primary);
}

.filter-chip-active {
  background: var(--accent-soft);
  border-color: rgba(240, 107, 130, 0.4);
  color: var(--accent-2);
}

.filter-chip-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  padding: 1px 6px;
  background: var(--surface-2);
  border-radius: 999px;
  min-width: 20px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.filter-chip-active .filter-chip-count {
  background: rgba(240, 107, 130, 0.2);
  color: var(--accent-2);
}

/* View toggle button */
.view-toggle-btn {
  padding: 6px 10px;
  min-width: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* mobile-fallback: hidden on desktop, shown on mobile */
.mobile-fallback { display: none; }

@media (max-width: 768px) {
  .table-view { display: none; }
  .mobile-fallback { display: block; }
  .view-toggle-btn { display: none; }

  .movie-row {
    padding: 12px 14px;
    gap: 12px;
  }

  .movie-row-poster {
    width: 48px;
  }

  .movie-row-title {
    font-size: 14px;
  }

  .filter-chips {
    flex-wrap: nowrap;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding-bottom: var(--gap-xs);
    margin-left: -16px;
    margin-right: -16px;
    padding-left: 16px;
    padding-right: 16px;
  }

  .filter-chips::-webkit-scrollbar {
    display: none;
  }

  .filter-chip {
    flex-shrink: 0;
    min-height: 36px;
  }
}

/* Table row hover animation */
.table-row-animate {
  transition: background-color 0.15s;
}
</style>
