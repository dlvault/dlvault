<template>
  <div class="queue">
    <header class="qx-header">
      <h1 class="qx-title">
        Warteschlange <span class="serif">{{ filteredCount }}</span>
      </h1>
      <div class="qx-tools">
        <div class="qx-search-wrap">
          <Search :size="14" class="qx-search-icon" />
          <input
            ref="searchInput"
            v-model="search"
            class="qx-search"
            placeholder="Film suchen…"
            aria-label="Filme durchsuchen"
          />
        </div>
        <div class="qx-view-seg" role="radiogroup" aria-label="Ansicht">
          <button
            type="button"
            :class="{ active: viewMode === 'cards' }"
            @click="setView('cards')"
          >
            <Rows3 :size="14" />
            <span>Karten</span>
          </button>
          <button
            type="button"
            :class="{ active: viewMode === 'kanban' }"
            @click="setView('kanban')"
          >
            <LayoutGrid :size="14" />
            <span>Kanban</span>
          </button>
        </div>
        <button class="btn btn-primary" :disabled="refreshing" @click="loadMovies">
          <RefreshCw :size="14" />
          <span>{{ refreshing ? 'Sync läuft…' : 'Sync' }}</span>
        </button>
      </div>
    </header>

    <!-- Filter chips -->
    <div class="qx-chips" role="group" aria-label="Status-Filter">
      <button
        v-for="c in chips"
        :key="c.key"
        :class="['qx-chip', { active: statusFilter === c.key }]"
        :style="{ '--chip-color': c.color }"
        @click="setStatusFilter(c.key)"
      >
        <span v-if="c.key !== 'all'" class="dot"></span>
        <span class="label">{{ c.label }}</span>
        <span class="count">{{ c.count }}</span>
      </button>
    </div>

    <!-- Bulk action pill (Glass) -->
    <Teleport to="body">
      <Transition name="bulk-rise">
        <div v-if="selectedIds.length > 0" class="qx-bulk" role="region" aria-label="Bulk-Aktionen">
          <span class="qx-bulk-count">
            <strong>{{ selectedIds.length }}</strong> ausgewählt
          </span>
          <button class="bulk-btn" type="button" @click="bulkRetry">
            <RefreshCw :size="14" /><span>Retry</span>
          </button>
          <button class="bulk-btn danger" type="button" @click="bulkDelete">
            <Trash2 :size="14" /><span>Löschen</span>
          </button>
          <button class="bulk-x" type="button" @click="selectedIds = []" aria-label="Auswahl aufheben">
            <X :size="14" />
          </button>
        </div>
      </Transition>
    </Teleport>

    <SkeletonLoader v-if="loading" variant="grid" :count="6" />

    <template v-else-if="movies.length === 0">
      <div class="card">
        <EmptyState
          icon="Popcorn"
          title="Keine Filme in der Warteschlange"
          description="Füge Filme über die Trakt Watchlist hinzu und starte einen Sync."
          action-to="/settings"
          action-label="Einstellungen"
        />
      </div>
    </template>

    <template v-else-if="filteredMovies.length === 0">
      <div class="card">
        <EmptyState icon="Search" title="Keine Treffer" description="Ändere den Suchbegriff oder Filter." />
      </div>
    </template>

    <!-- Kanban view -->
    <div v-else-if="viewMode === 'kanban'" class="qx-kanban">
      <KanbanColumn
        v-for="col in kanbanCols"
        :key="col.key"
        :label="col.label"
        :stage-color="col.color"
        :items="col.items"
        :progress-map="progressByPrefix"
        @open="openDetail"
      />
    </div>

    <!-- Cards / grouped view -->
    <div v-else class="qx-content">
      <!-- Active strip — only when something is currently moving -->
      <div v-if="activeMovies.length > 0" class="qx-active-strip fade-in">
        <ActiveCard
          v-for="m in activeMovies"
          :key="m.id"
          :movie="m"
          :pkg="packageForMovie(m)"
          :progress-fraction="progressByPrefix.get(movieKey(m))"
          :is-extracting="extractingByPrefix.get(movieKey(m))"
        />
      </div>

      <StageGroup
        v-for="group in stageGroups"
        :key="group.stage"
        :stage-mono="group.mono"
        :stage-color="group.color"
        :count="group.items.length"
        :hint="group.hint"
        :open="openGroups.has(group.stage)"
        @toggle="toggleGroup(group.stage)"
      >
        <MovieRow
          v-for="m in group.items"
          :key="m.id"
          :movie="m"
          :search-query="debouncedSearch"
          :is-checked="selectedIds.includes(m.id)"
          :progress-fraction="progressByPrefix.get(movieKey(m))"
          @open="openDetail"
          @retry="retry"
          @remove="remove"
          @toggle-select="toggleSelect"
        />
      </StageGroup>
    </div>

    <DetailPanel
      :movie="panelMovie"
      :context="panelContext"
      @close="closePanel"
      @retry="onPanelRetry"
      @research="onPanelResearch"
      @delete="onPanelDelete"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import type { Movie, MovieStatus } from '../types/index';
import { useMoviesStore } from '../stores/movies';
import { useDownloadsStore } from '../stores/downloads';
import { useDownloadPolling } from '../composables/useDownloadPolling';
import { useSyncStore } from '../stores/sync';
import { useToast, useConfirm } from '../composables/useApp';
import { useMovieFiltering } from '../composables/useMovieFiltering';
import { useSearchShortcut } from '../composables/useSearchShortcut';
import { useDetailPanel } from '../composables/useDetailPanel';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import EmptyState from '../components/EmptyState.vue';
import DetailPanel from '../components/DetailPanel.vue';
import ActiveCard from '../components/queue/ActiveCard.vue';
import StageGroup from '../components/queue/StageGroup.vue';
import MovieRow from '../components/queue/MovieRow.vue';
import KanbanColumn from '../components/queue/KanbanColumn.vue';
import { Search, RefreshCw, Trash2, X, LayoutGrid, Rows3 } from 'lucide-vue-next';

const moviesStore = useMoviesStore();
const dlStore = useDownloadsStore();
useDownloadPolling();
const syncStore = useSyncStore();
const toast = useToast();
const confirmModal = useConfirm();

const { movie: panelMovie, context: panelContext, close: closePanel, openFromMovie } = useDetailPanel();
const searchInput = ref<HTMLInputElement>();
const refreshing = ref(false);

// ── View mode persistence ──────────────────────────────────
const STORED_VIEW = localStorage.getItem('dlvault-view-mode');
const viewMode = ref<'cards' | 'kanban'>(STORED_VIEW === 'kanban' ? 'kanban' : 'cards');
function setView(v: 'cards' | 'kanban') {
  viewMode.value = v;
  localStorage.setItem('dlvault-view-mode', v);
}

// ── Group open/close state, persisted per stage ────────────
const STAGE_ORDER = ['searching', 'found', 'pending', 'not_found', 'moved', 'downloaded'] as const;
const OPEN_BY_DEFAULT = new Set(['searching', 'found', 'pending', 'not_found']);
const openGroups = ref(new Set<string>(loadOpenGroups()));

function loadOpenGroups(): string[] {
  const out: string[] = [];
  for (const stage of STAGE_ORDER) {
    const stored = localStorage.getItem(`dlvault-queue-open-${stage}`);
    const open = stored === null ? OPEN_BY_DEFAULT.has(stage) : stored === '1';
    if (open) out.push(stage);
  }
  return out;
}

function toggleGroup(stage: string) {
  if (openGroups.value.has(stage)) {
    openGroups.value.delete(stage);
    localStorage.setItem(`dlvault-queue-open-${stage}`, '0');
  } else {
    openGroups.value.add(stage);
    localStorage.setItem(`dlvault-queue-open-${stage}`, '1');
  }
  openGroups.value = new Set(openGroups.value); // trigger reactivity
}

// ── Filtering / search / selection (reuse existing composable) ──
const movies = computed(() => moviesStore.movies);
const loading = computed(() => moviesStore.loading);

const {
  search, debouncedSearch, statusFilter,
  selectedIds, toggleSelect,
} = useMovieFiltering(movies);

// The composable defaults statusFilter to 'active' — our new chip set uses 'all'
// instead. Normalize.
if (statusFilter.value === 'active') statusFilter.value = 'all';

function setStatusFilter(key: string) {
  statusFilter.value = key === 'all' ? 'all' : key;
}

// ── Filtering manually (composable uses its own status-filter semantics) ──
const filteredMovies = computed(() => {
  let result = movies.value;
  if (statusFilter.value && statusFilter.value !== 'all') {
    result = result.filter(m => effectiveStatus(m) === statusFilter.value);
  }
  const q = debouncedSearch.value.trim().toLowerCase();
  if (q) {
    result = result.filter(m =>
      m.title.toLowerCase().includes(q) || String(m.year).includes(q)
    );
  }
  return result;
});

const filteredCount = computed(() => filteredMovies.value.length);

// ── JD progress matching (preserved from previous impl) ─────
function movieKey(m: Movie): string { return `${m.title} (${m.year})`; }

const extractingByPrefix = computed(() => {
  const map = new Map<string, boolean>();
  for (const pkg of dlStore.packages) {
    const m = (pkg.name || '').match(/^(.+? \(\d{4}\))/);
    if (m) map.set(m[1], dlStore.isExtracting(pkg));
  }
  return map;
});

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

function packageForMovie(m: Movie) {
  const key = movieKey(m);
  return dlStore.packages.find(p => {
    const match = (p.name || '').match(/^(.+? \(\d{4}\))/);
    return match && match[1] === key;
  }) || null;
}

// ── Active strip + stage groups ────────────────────────────
const activeMovies = computed(() =>
  filteredMovies.value.filter(m => {
    const s = effectiveStatus(m);
    return s === 'downloading' || s === 'extracting';
  })
);

const STAGE_META: Record<string, { mono: string; color: string }> = {
  pending:     { mono: 'PENDING',     color: 'var(--stage-pending)' },
  searching:   { mono: 'SEARCHING',   color: 'var(--stage-searching)' },
  found:       { mono: 'FOUND',       color: 'var(--stage-found)' },
  not_found:   { mono: 'NOT FOUND',   color: 'var(--stage-not_found)' },
  moved:       { mono: 'MOVED',       color: 'var(--stage-moved)' },
  downloaded:  { mono: 'IN LIBRARY',  color: 'var(--stage-library)' },
};

const stageGroups = computed(() => {
  // Group filtered movies (excluding active ones already in the strip) by stage
  const byStage = new Map<string, Movie[]>();
  for (const m of filteredMovies.value) {
    const s = effectiveStatus(m);
    if (s === 'downloading' || s === 'extracting') continue; // in the active strip
    const bucket = byStage.get(s) || [];
    bucket.push(m);
    byStage.set(s, bucket);
  }
  return STAGE_ORDER
    .filter(s => (byStage.get(s)?.length || 0) > 0)
    .map(stage => {
      const items = byStage.get(stage)!;
      const meta = STAGE_META[stage];
      return {
        stage,
        mono: meta.mono,
        color: meta.color,
        items,
        hint: hintFor(stage, items),
      };
    });
});

function hintFor(stage: string, items: Movie[]): string {
  if (stage === 'searching') return 'läuft jetzt';
  if (stage === 'not_found') return 'manueller Eingriff nötig';
  if (stage === 'moved') return '';
  if (stage === 'downloaded') return 'in Library';
  if (stage === 'pending') {
    const stuck = items.filter(m => {
      const ts = m.last_checked_at || m.added_at;
      if (!ts) return false;
      return (Date.now() - new Date(ts + 'Z').getTime()) > 86_400_000;
    });
    if (stuck.length === 0) return 'wartet auf nächsten Sync';
    const oldest = stuck.reduce((acc, m) => {
      const ts = m.last_checked_at || m.added_at;
      if (!ts) return acc;
      const t = new Date(ts + 'Z').getTime();
      return t < acc ? t : acc;
    }, Date.now());
    const ageDays = Math.floor((Date.now() - oldest) / 86_400_000);
    return `${stuck.length} stuck · älteste vor ${ageDays} ${ageDays === 1 ? 'Tag' : 'Tagen'}`;
  }
  return '';
}

// ── Chips ───────────────────────────────────────────────────
const chips = computed(() => {
  const counts: Record<string, number> = {};
  for (const m of movies.value) {
    const s = effectiveStatus(m);
    counts[s] = (counts[s] || 0) + 1;
  }
  return [
    { key: 'all',         label: 'Alle',           count: movies.value.length,                  color: 'var(--text-secondary)' },
    { key: 'pending',     label: 'Wartet',         count: counts.pending     || 0,              color: 'var(--stage-pending)' },
    { key: 'searching',   label: 'Suche',          count: counts.searching   || 0,              color: 'var(--stage-searching)' },
    { key: 'downloading', label: 'Lädt',           count: (counts.downloading || 0) + (counts.extracting || 0), color: 'var(--stage-downloading)' },
    { key: 'downloaded',  label: 'Fertig',         count: counts.downloaded  || 0,              color: 'var(--stage-library)' },
    { key: 'not_found',   label: 'Nicht gefunden', count: counts.not_found   || 0,              color: 'var(--stage-not_found)' },
  ];
});

// ── Kanban columns ──────────────────────────────────────────
const kanbanCols = computed(() => [
  {
    key: 'wartend', label: 'Wartet', color: 'var(--stage-pending)',
    items: filteredMovies.value.filter(m => m.status === 'pending'),
  },
  {
    key: 'suche', label: 'Suche', color: 'var(--stage-searching)',
    items: filteredMovies.value.filter(m => ['searching', 'found'].includes(m.status)),
  },
  {
    key: 'aktiv', label: 'Aktiv', color: 'var(--stage-downloading)',
    items: filteredMovies.value.filter(m => ['downloading', 'extracting'].includes(effectiveStatus(m))),
  },
  {
    key: 'fertig', label: 'Fertig', color: 'var(--stage-library)',
    items: filteredMovies.value.filter(m => ['moved', 'downloaded', 'not_found'].includes(m.status)),
  },
]);

// ── Actions ─────────────────────────────────────────────────
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
  const eff = effectiveStatus(movie) as MovieStatus;
  const pkg = packageForMovie(movie);
  const extracting = !!extractingByPrefix.value.get(movieKey(movie));
  openFromMovie(movie, eff, pkg, extracting);
}

async function onPanelRetry(id: number | string) {
  await retry(Number(id));
  closePanel();
}

async function onPanelResearch(pm: { id: number | string }) {
  await retry(Number(pm.id));
  closePanel();
}

async function onPanelDelete(pm: { id: number | string }) {
  const m = movies.value.find(x => x.id === Number(pm.id));
  if (!m) return;
  await remove(m);
  closePanel();
}

useSearchShortcut(searchInput);

onMounted(() => {
  moviesStore.fetch();
  dlStore.fetch();
});
</script>

<style scoped>
.queue {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ───── Header ───── */
.qx-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 4px;
}
.qx-title {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.02em;
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 0;
}
.qx-title .serif {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: var(--accent-2);
  letter-spacing: -0.01em;
}
.qx-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* Search */
.qx-search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.qx-search-icon {
  position: absolute;
  left: 12px;
  color: var(--text-3);
  pointer-events: none;
}
.qx-search {
  width: 260px;
  padding: 8px 12px 8px 34px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s, width 0.2s;
}
.qx-search::placeholder { color: var(--text-3); }
.qx-search:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  width: 320px;
}

/* View segmented */
.qx-view-seg {
  display: inline-flex;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px;
  gap: 2px;
}
.qx-view-seg button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 999px;
  transition: background 0.15s, color 0.15s;
}
.qx-view-seg button.active {
  background: var(--surface);
  color: var(--text-primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* ───── Filter chips ───── */
.qx-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.qx-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}
.qx-chip:hover { border-color: var(--line-2); color: var(--text-primary); }
.qx-chip.active {
  background: var(--surface-2);
  border-color: var(--chip-color);
  color: var(--chip-color);
}
.qx-chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--chip-color);
}
.qx-chip .count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  background: var(--surface-2);
  padding: 1px 6px;
  border-radius: 999px;
  font-variant-numeric: tabular-nums;
}
.qx-chip.active .count {
  background: color-mix(in srgb, var(--chip-color) 12%, transparent);
  color: var(--chip-color);
}

/* ───── Content ───── */
.qx-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.qx-active-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  gap: 14px;
  margin-bottom: 4px;
}

/* ───── Kanban ───── */
.qx-kanban {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
@media (max-width: 1100px) {
  .qx-kanban { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 768px) {
  .qx-kanban { grid-template-columns: 1fr; }
  .qx-active-strip { grid-template-columns: 1fr; }
}

/* ───── Bulk pill (Glass) ───── */
.qx-bulk {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translate(120px, 0);
  background: rgba(26, 28, 33, 0.92);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  border: 1px solid var(--line-2);
  border-radius: 999px;
  padding: 7px 7px 7px 18px;
  display: flex;
  align-items: center;
  gap: 10px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.3);
  z-index: 50;
  color: var(--text-primary);
  font-size: 13px;
}
.qx-bulk-count {
  font-family: var(--font-mono);
  color: var(--text-secondary);
  padding-right: 10px;
  border-right: 1px solid var(--line-2);
  font-variant-numeric: tabular-nums;
}
.qx-bulk-count strong {
  color: var(--accent-2);
  margin-right: 4px;
  font-weight: 600;
}
.bulk-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.bulk-btn:hover { background: var(--surface-2); color: var(--text-primary); border-color: var(--line-2); }
.bulk-btn.danger:hover { color: var(--err); border-color: rgba(240, 123, 110, 0.3); background: rgba(240, 123, 110, 0.06); }
.bulk-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: transparent;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bulk-x:hover { color: var(--text-primary); background: var(--surface-2); }

.bulk-rise-enter-active, .bulk-rise-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.bulk-rise-enter-from, .bulk-rise-leave-to {
  opacity: 0;
  transform: translate(120px, 30px);
}

@media (max-width: 768px) {
  .qx-bulk {
    left: 12px;
    right: 12px;
    bottom: 12px;
    transform: none;
    border-radius: var(--r-md);
  }
  .bulk-rise-enter-from, .bulk-rise-leave-to {
    opacity: 0;
    transform: translateY(30px);
  }
  .qx-search { width: 100%; }
  .qx-search:focus { width: 100%; }
  .qx-tools { width: 100%; }
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.fade-in { animation: fadeIn 0.3s ease; }
</style>
