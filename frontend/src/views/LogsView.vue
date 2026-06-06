<template>
  <div>
    <div class="section-header">
      <h2>Aktivitäts-Log</h2>
      <div class="flex-row-wrap">
        <div class="search-wrapper">
          <span class="search-icon" aria-hidden="true"><Search :size="14" /></span>
          <input
            v-model="search"
            placeholder="Logs durchsuchen..."
            class="search-input"
            aria-label="Logs durchsuchen"
            ref="searchInput"
          />
        </div>
        <select v-model="actionFilter" class="filter-select" aria-label="Aktions-Filter">
          <option value="">Alle Aktionen</option>
          <option value="movie_added">Film hinzugefügt</option>
          <option value="watchlist_sync">Watchlist Sync</option>
          <option value="search_started">Suche gestartet</option>
          <option value="not_found">Nicht gefunden</option>
          <option value="release_found">Release gefunden</option>
          <option value="sent_to_jdownloader">An JDownloader</option>
          <option value="sync_started">Sync gestartet</option>
          <option value="sync_completed">Sync abgeschlossen</option>
          <option value="error">Fehler</option>
        </select>
        <button class="btn btn-secondary" @click="loadLogs" aria-label="Aktualisieren">Aktualisieren</button>
      </div>
    </div>

    <SkeletonLoader v-if="loading" variant="table" :count="10" />

    <div v-else class="card">
      <!-- Desktop: Table -->
      <table v-if="pagedLogs.length > 0" class="logs-table">
        <thead>
          <tr>
            <th class="sortable" @click="toggleSort('created_at')" :aria-sort="ariaSort('created_at')">
              Zeitpunkt {{ sortIcon('created_at') }}
            </th>
            <th class="sortable" @click="toggleSort('movie_title')" :aria-sort="ariaSort('movie_title')">
              Film {{ sortIcon('movie_title') }}
            </th>
            <th>Aktion</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in pagedLogs" :key="log.id">
            <td class="text-nowrap" :title="formatDateFull(log.created_at)">{{ timeAgo(log.created_at) }}</td>
            <td>
              <button
                v-if="log.movie_id && log.movie_title"
                class="log-movie-link"
                title="Details öffnen"
                @click="goToMovie(log.movie_id)"
              >
                <HighlightText :text="log.movie_title" :query="debouncedSearch" />
              </button>
              <HighlightText v-else :text="log.movie_title || '-'" :query="debouncedSearch" />
            </td>
            <td>
              <span :class="'badge badge-' + actionColor(log.action)">
                {{ formatAction(log.action) }}
              </span>
            </td>
            <td class="log-details"><HighlightText :text="log.details || '-'" :query="debouncedSearch" /></td>
          </tr>
        </tbody>
      </table>

      <!-- Mobile: Card list -->
      <div v-if="pagedLogs.length > 0" class="logs-cards">
        <div v-for="log in pagedLogs" :key="'m-' + log.id" class="log-card">
          <div class="log-card-top">
            <span :class="'badge badge-' + actionColor(log.action)">{{ formatAction(log.action) }}</span>
            <span class="log-card-time" :title="formatDateFull(log.created_at)">{{ timeAgo(log.created_at) }}</span>
          </div>
          <div v-if="log.movie_title" class="log-card-title">
            <button
              v-if="log.movie_id"
              class="log-movie-link"
              title="Details öffnen"
              @click="goToMovie(log.movie_id)"
            >
              <HighlightText :text="log.movie_title" :query="debouncedSearch" />
            </button>
            <HighlightText v-else :text="log.movie_title" :query="debouncedSearch" />
          </div>
          <div v-if="log.details" class="log-card-details">
            <HighlightText :text="log.details" :query="debouncedSearch" />
          </div>
        </div>
      </div>

      <EmptyState
        v-else-if="logs.length === 0"
        icon="ScrollText"
        title="Noch keine Log-Einträge vorhanden"
        description="Starte einen Sync um Aktivitäten zu erzeugen."
      />
      <EmptyState
        v-else
        icon="Search"
        title="Keine Treffer"
        description="Ändere den Suchbegriff oder Filter."
      />
      <PaginationBar
        v-if="pagedLogs.length > 0"
        :page="page" :total-pages="totalPages" :total-items="filteredLogs.length"
        :per-page="itemsPerPage" :has-prev="hasPrevPage" :has-next="hasNextPage"
        @prev="prevPage" @next="nextPage"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { getLogs } from '../api/index';
import type { LogEntry } from '../types/index';
import { useDebouncedRef } from '../composables/useDebounce';
import { usePagination } from '../composables/usePagination';
import { formatDateFull, timeAgo, formatAction, actionColor } from '../composables/useFormatters';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import EmptyState from '../components/EmptyState.vue';
import HighlightText from '../components/HighlightText.vue';
import { Search } from 'lucide-vue-next';
import PaginationBar from '../components/PaginationBar.vue';
import { useSearchShortcut } from '../composables/useSearchShortcut';
import { useSyncStore } from '../stores/sync';

const logs = ref<LogEntry[]>([]);
const router = useRouter();

// Titel → Warteschlange mit geöffnetem DetailPanel (gleiche Mechanik wie die
// Command-Palette: /movies?highlight=<id>).
function goToMovie(id: number | null | undefined) {
  if (!id) return;
  router.push({ path: '/movies', query: { highlight: String(id) } });
}

const search = ref('');
const debouncedSearch = useDebouncedRef(search);
const actionFilter = ref('');
const sortKey = ref('created_at');
const sortAsc = ref(false);
const loading = ref(true);
const searchInput = ref<HTMLInputElement>();

const filteredLogs = computed(() => {
  let result = logs.value;

  if (actionFilter.value) {
    result = result.filter(l => l.action === actionFilter.value);
  }

  if (debouncedSearch.value.trim()) {
    const q = debouncedSearch.value.toLowerCase();
    result = result.filter(l =>
      (l.movie_title || '').toLowerCase().includes(q) ||
      (l.details || '').toLowerCase().includes(q)
    );
  }

  if (sortKey.value) {
    const key = sortKey.value as keyof LogEntry;
    result = [...result].sort((a, b) => {
      const va = a[key] ?? '';
      const vb = b[key] ?? '';
      const cmp = String(va).localeCompare(String(vb), 'de', { numeric: true });
      return sortAsc.value ? cmp : -cmp;
    });
  }

  return result;
});

const { paginatedItems: pagedLogs, page, totalPages, hasNextPage, hasPrevPage, nextPage, prevPage, itemsPerPage } = usePagination(filteredLogs, 50);

function toggleSort(key: string) {
  if (sortKey.value === key) {
    sortAsc.value = !sortAsc.value;
  } else {
    sortKey.value = key;
    sortAsc.value = key !== 'created_at';
  }
}

function sortIcon(key: string) {
  if (sortKey.value !== key) return '';
  return sortAsc.value ? '\u25B2' : '\u25BC';
}

function ariaSort(key: string): 'ascending' | 'descending' | 'none' {
  if (sortKey.value !== key) return 'none';
  return sortAsc.value ? 'ascending' : 'descending';
}

async function loadLogs() {
  try {
    const res = await getLogs(500, actionFilter.value || undefined);
    logs.value = res.data;
  } catch {
    // ignore — logs view will show empty
  } finally {
    loading.value = false;
  }
}

useSearchShortcut(searchInput);

// Action filter is applied server-side (so it spans all entries, not just the
// loaded page) — refetch when it changes. Search stays client-side.
watch(actionFilter, () => loadLogs());

// Live-update: re-fetch when SSE triggers a store log update — debounced so a burst
// of log:created events doesn't refetch 500 entries per tick.
const syncStore = useSyncStore();
let logsRefetchTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => syncStore.logs.length, () => {
  if (logsRefetchTimer) clearTimeout(logsRefetchTimer);
  logsRefetchTimer = setTimeout(() => {
    logsRefetchTimer = null;
    loadLogs();
  }, 1000);
});

onUnmounted(() => {
  if (logsRefetchTimer) clearTimeout(logsRefetchTimer);
});

onMounted(() => {
  loadLogs();
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

.log-details {
  max-width: 400px;
  word-break: break-word;
}

/* Mobile: card layout */
.logs-cards {
  display: none;
}

.log-card {
  padding: var(--gap-md) 0;
  border-bottom: 1px solid var(--border);
}

.log-card:last-child {
  border-bottom: none;
}

.log-card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--gap-xs);
}

.log-card-time {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.log-card-title {
  font-weight: 600;
  font-size: var(--fs-sm);
  margin-bottom: 2px;
}

.log-card-details {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

@media (max-width: 768px) {
  .logs-table {
    display: none;
  }

  .logs-cards {
    display: block;
  }
}
.log-movie-link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.log-movie-link:hover { color: var(--accent); text-decoration: underline; }
</style>
