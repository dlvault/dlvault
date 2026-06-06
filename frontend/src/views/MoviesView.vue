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
            placeholder="Titel suchen…"
            aria-label="Warteschlange durchsuchen"
          />
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
        <div v-if="selectedIds.length > 0" class="qx-bulk" role="region" aria-label="Sammelaktionen">
          <span class="qx-bulk-count">
            <strong>{{ selectedIds.length }}</strong> ausgewählt
          </span>
          <button class="bulk-btn" type="button" @click="bulkRetry">
            <RefreshCw :size="14" /><span>Neu suchen</span>
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

    <template v-else-if="movies.length === 0 && moviesStore.error">
      <div class="card">
        <EmptyState
          icon="AlertTriangle"
          title="Warteschlange konnte nicht geladen werden"
          description="Server nicht erreichbar."
        />
        <div class="qx-retry"><button class="btn btn-secondary" type="button" @click="moviesStore.fetch(true)">Erneut versuchen</button></div>
      </div>
    </template>

    <template v-else-if="movies.length === 0">
      <div class="card">
        <EmptyState
          icon="Popcorn"
          title="Warteschlange ist leer"
          description="Titel kommen über deine Watchlist (Trakt, Plex oder Seerr) oder über die Suche hinzu."
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
          :importing="importByMovie.get(m.id)"
          :jd-loading="dlStore.loading"
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
      @delete="onPanelDelete"
      @set-season-cutoff="onSetSeasonCutoff"
      @set-quality-override="onSetQualityOverride"
    />
  </div>
</template>

<script setup lang="ts">
import { safeStorage } from '../utils/storage';
import { apiMessage } from '../utils/apiError';
import { packageKey } from '../components/downloads/downloadPackage';
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Movie, MovieStatus } from '../types/index';
import { setSeasonCutoff, setQualityOverride } from '../api/index';
import { useMoviesStore } from '../stores/movies';
import { useDownloadsStore } from '../stores/downloads';
import { useDownloadPolling } from '../composables/useDownloadPolling';
import { useSyncStore } from '../stores/sync';
import { useToast, useConfirm } from '../composables/useApp';
import { useMovieFiltering } from '../composables/useMovieFiltering';
import { useSearchShortcut } from '../composables/useSearchShortcut';
import { useDetailPanel } from '../composables/useDetailPanel';
import { displayStatus, statusLabel, parseServerDate } from '../composables/useFormatters';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import EmptyState from '../components/EmptyState.vue';
import DetailPanel from '../components/DetailPanel.vue';
import ActiveCard from '../components/queue/ActiveCard.vue';
import StageGroup from '../components/queue/StageGroup.vue';
import MovieRow from '../components/queue/MovieRow.vue';
import { Search, RefreshCw, Trash2, X } from 'lucide-vue-next';

const moviesStore = useMoviesStore();
const dlStore = useDownloadsStore();
useDownloadPolling();
const syncStore = useSyncStore();
const toast = useToast();
const confirmModal = useConfirm();

const { movie: panelMovie, context: panelContext, close: closePanel, openFromMovie } = useDetailPanel();
const searchInput = ref<HTMLInputElement>();
const refreshing = ref(false);

// ── Group open/close state, persisted per stage ────────────
const STAGE_ORDER = ['searching', 'found', 'pending', 'quality_mismatch', 'no_download', 'not_available', 'moved', 'downloaded'] as const;
// 'not_available' is the big passive bucket (waiting on the source) — collapse it
// by default so the actionable buckets aren't buried.
const OPEN_BY_DEFAULT = new Set(['searching', 'found', 'pending', 'quality_mismatch', 'no_download']);
const openGroups = ref(new Set<string>(loadOpenGroups()));

function loadOpenGroups(): string[] {
  const out: string[] = [];
  for (const stage of STAGE_ORDER) {
    const stored = safeStorage.get(`dlvault-queue-open-${stage}`);
    const open = stored === null ? OPEN_BY_DEFAULT.has(stage) : stored === '1';
    if (open) out.push(stage);
  }
  return out;
}

function toggleGroup(stage: string) {
  if (openGroups.value.has(stage)) {
    openGroups.value.delete(stage);
    safeStorage.set(`dlvault-queue-open-${stage}`, '0');
  } else {
    openGroups.value.add(stage);
    safeStorage.set(`dlvault-queue-open-${stage}`, '1');
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
    // Der "Lädt"-Chip zählt downloading UND extracting — der Filter muss beide
    // Status durchlassen, sonst stimmen Chip-Zahl und Liste nicht überein.
    result = result.filter(m => {
      const k = groupKey(m);
      return k === statusFilter.value || (statusFilter.value === 'downloading' && k === 'extracting');
    });
  }
  const q = debouncedSearch.value.trim().toLowerCase();
  if (q) {
    result = result.filter(m =>
      m.title.toLowerCase().includes(q) || String(m.year ?? '').includes(q)
    );
  }
  return result;
});

const filteredCount = computed(() => filteredMovies.value.length);

// ── JD progress matching (preserved from previous impl) ─────
// Same shape as packageKey(): "Title (Year)", or "Title" without a year —
// "Title (null)" never matched, so year-less titles showed no progress.
function movieKey(m: Movie): string { return m.year ? `${m.title} (${m.year})` : m.title; }

const extractingByPrefix = computed(() => {
  const map = new Map<string, boolean>();
  for (const pkg of dlStore.packages) {
    const key = packageKey(pkg.name);
    if (key) map.set(key, dlStore.isExtracting(pkg));
  }
  return map;
});

const progressByPrefix = computed(() => {
  const map = new Map<string, number>();
  for (const pkg of dlStore.packages) {
    const key = packageKey(pkg.name);
    if (!key) continue;
    if (pkg.bytesTotal > 0) {
      const ratio = Math.max(0, Math.min(1, pkg.bytesLoaded / pkg.bytesTotal));
      const prev = map.get(key);
      if (prev === undefined || ratio > prev) map.set(key, ratio);
    }
  }
  return map;
});

const importByMovie = computed(() => new Map(dlStore.importing.map(i => [i.movieId, i])));

function effectiveStatus(movie: Movie): string {
  if (movie.status !== 'downloading') return movie.status;
  return extractingByPrefix.value.get(movieKey(movie)) ? 'extracting' : movie.status;
}

// Grouping/filter/chip key: like effectiveStatus, but splits 'not_found' into its
// three reason buckets (not_available / no_download / quality_mismatch) so the
// queue shows distinct groups instead of one "Nicht gefunden". effectiveStatus
// stays in charge of the downloading→extracting derivation used by the active strip.
function groupKey(movie: Movie): string {
  const s = effectiveStatus(movie);
  return s === 'not_found' ? displayStatus(movie) : s;
}

function packageForMovie(m: Movie) {
  const key = movieKey(m);
  return dlStore.packages.find(p => packageKey(p.name) === key) || null;
}

// ── Active strip + stage groups ────────────────────────────
// A title belongs in the top "active" strip when it's downloading/extracting by
// status OR has a JD package currently transferring — e.g. a SHOW whose season
// downloads while the show row sits in another status (not_found, downloaded…).
// Without the package check the real current download (an active show season)
// gets buried in a stage group instead of surfacing as the current download.
function isActive(m: Movie): boolean {
  const s = effectiveStatus(m);
  if (s === 'downloading' || s === 'extracting') return true;
  if (importByMovie.value.has(m.id)) return true;
  const pkg = packageForMovie(m);
  return !!pkg && !pkg.finished && (pkg.running || (pkg.bytesLoaded ?? 0) > 0);
}

const activeMovies = computed(() => {
  const list = filteredMovies.value.filter(isActive);
  // Most-active first: a title actually transferring (running + speed) outranks
  // one merely queued in JD, which outranks the rest; ties break by progress.
  // Without this the strip followed added_at order, so the title being downloaded
  // could sit BELOW older, still-queued entries (the reported bug).
  const score = (m: Movie): number => {
    const pkg = packageForMovie(m);
    const frac = progressByPrefix.value.get(movieKey(m)) ?? 0;
    if (pkg?.running && (pkg.speed || 0) > 0) return 300 + frac;      // downloading now
    if (importByMovie.value.has(m.id)) return 250;                    // copying into the library
    if (extractingByPrefix.value.get(movieKey(m))) return 200 + frac; // extracting (almost done)
    if (pkg) return 100 + frac;                                       // queued in JD
    return frac;
  };
  return [...list].sort((a, b) => score(b) - score(a));
});

const STAGE_META: Record<string, { mono: string; color: string }> = {
  pending:          { mono: 'WARTET',                  color: 'var(--stage-pending)' },
  searching:        { mono: 'SUCHE LÄUFT',             color: 'var(--stage-searching)' },
  found:            { mono: 'QUELLE GEFUNDEN',         color: 'var(--stage-found)' },
  quality_mismatch: { mono: 'ANFORDERUNGEN NICHT ERFÜLLT', color: 'var(--stage-quality_mismatch)' },
  no_download:      { mono: 'KEIN DOWNLOAD',           color: 'var(--stage-no_download)' },
  not_available:    { mono: 'KEIN RELEASE BEI DER QUELLE', color: 'var(--stage-not_available)' },
  moved:            { mono: 'VERSCHOBEN',              color: 'var(--stage-moved)' },
  downloaded:       { mono: 'IN MEDIATHEK',            color: 'var(--stage-library)' },
};

const stageGroups = computed(() => {
  // Group filtered movies (excluding active ones already in the strip) by stage
  const byStage = new Map<string, Movie[]>();
  for (const m of filteredMovies.value) {
    if (isActive(m)) continue; // shown in the active strip
    const s = groupKey(m);
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
  if (stage === 'quality_mismatch') return 'manueller Eingriff nötig';
  if (stage === 'no_download') return 'an der Quelle, wartet auf Datei';
  if (stage === 'not_available') return 'wartet auf Quelle';
  if (stage === 'moved') return '';
  if (stage === 'downloaded') return 'in der Mediathek';
  if (stage === 'pending') {
    const stuck = items.filter(m => {
      const ts = m.last_checked_at || m.added_at;
      if (!ts) return false;
      return (Date.now() - parseServerDate(ts).getTime()) > 86_400_000;
    });
    if (stuck.length === 0) return 'wartet auf nächsten Sync';
    const oldest = stuck.reduce((acc, m) => {
      const ts = m.last_checked_at || m.added_at;
      if (!ts) return acc;
      const t = parseServerDate(ts).getTime();
      return t < acc ? t : acc;
    }, Date.now());
    const ageDays = Math.floor((Date.now() - oldest) / 86_400_000);
    return `${stuck.length} hängend · älteste vor ${ageDays} ${ageDays === 1 ? 'Tag' : 'Tagen'}`;
  }
  return '';
}

// ── Chips ───────────────────────────────────────────────────
const chips = computed(() => {
  const counts: Record<string, number> = {};
  for (const m of movies.value) {
    const s = groupKey(m);
    counts[s] = (counts[s] || 0) + 1;
  }
  // Labels aus dem gemeinsamen statusLabel()-Vokabular (useFormatters), damit
  // Chip, Zeilen-Badge und Gruppenheader dieselben Begriffe verwenden.
  return [
    { key: 'all',              label: 'Alle',                          count: movies.value.length,                  color: 'var(--text-secondary)' },
    { key: 'pending',          label: statusLabel('pending'),          count: counts.pending     || 0,              color: 'var(--stage-pending)' },
    { key: 'searching',        label: statusLabel('searching'),        count: counts.searching   || 0,              color: 'var(--stage-searching)' },
    { key: 'downloading',      label: statusLabel('downloading'),      count: (counts.downloading || 0) + (counts.extracting || 0), color: 'var(--stage-downloading)' },
    { key: 'downloaded',       label: statusLabel('downloaded'),       count: counts.downloaded  || 0,              color: 'var(--stage-library)' },
    { key: 'quality_mismatch', label: statusLabel('quality_mismatch'), count: counts.quality_mismatch || 0,         color: 'var(--stage-quality_mismatch)' },
    { key: 'no_download',      label: statusLabel('no_download'),      count: counts.no_download || 0,              color: 'var(--stage-no_download)' },
    { key: 'not_available',    label: statusLabel('not_available'),    count: counts.not_available || 0,            color: 'var(--stage-not_available)' },
  ];
});

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


function titleLabel(m: Pick<Movie, 'title' | 'year'>): string {
  return m.year ? `${m.title} (${m.year})` : m.title;
}

async function retry(id: number): Promise<boolean> {
  try {
    await moviesStore.retry(id);
    toast.value?.add('Neue Suche gestartet', 'success');
    return true;
  } catch (e: unknown) {
    toast.value?.add(apiMessage(e, 'Neue Suche konnte nicht gestartet werden'), 'error');
    return false;
  }
}

async function remove(movie: Movie): Promise<boolean> {
  const ok = await confirmModal.value?.show({
    title: 'Titel löschen',
    message: `„${titleLabel(movie)}“ aus der Warteschlange löschen? dlvault sucht ihn nicht mehr und übernimmt ihn auch nicht erneut aus der Watchlist. Dateien in der Mediathek bleiben.`,
    confirmText: 'Löschen',
    danger: true,
  });
  if (!ok) return false;
  try {
    await moviesStore.remove(movie.id);
    toast.value?.add('Gelöscht', 'success');
    return true;
  } catch (e: unknown) {
    toast.value?.add(apiMessage(e, 'Löschen fehlgeschlagen'), 'error');
    return false;
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

// Bulk actions only ever touch rows the user can SEE with a checkbox. The
// selection used to survive filter/search changes and a row moving into the
// active strip — "Löschen" then deleted titles that were no longer visible.
const selectableIds = computed(() => new Set(stageGroups.value.flatMap(g => g.items.map(m => m.id))));
watch(selectableIds, (ids) => {
  const kept = selectedIds.value.filter(id => ids.has(id));
  if (kept.length !== selectedIds.value.length) selectedIds.value = kept;
});

async function bulkRetry() {
  const ids = selectedIds.value.filter(id => selectableIds.value.has(id));
  const count = ids.length;
  const { ok, fail } = await runBounded(ids, 3, (id) => moviesStore.retry(id));
  selectedIds.value = [];
  if (fail === 0) toast.value?.add(`Neue Suche für ${count} Titel gestartet`, 'success');
  else toast.value?.add(`Neue Suche: ${ok} gestartet, ${fail} fehlgeschlagen`, 'warning');
}

async function bulkDelete() {
  const ids = selectedIds.value.filter(id => selectableIds.value.has(id));
  const count = ids.length;
  if (count === 0) return;
  const names = ids.map(id => movies.value.find(m => m.id === id)).filter(Boolean).map(m => `„${titleLabel(m!)}“`);
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ` und ${names.length - 5} weitere` : '');
  const confirmed = await confirmModal.value?.show({
    title: count === 1 ? 'Titel löschen' : `${count} Titel löschen`,
    message: `Aus der Warteschlange löschen: ${shown}? Sie werden nicht mehr gesucht und nicht erneut aus der Watchlist übernommen.`,
    confirmText: count === 1 ? 'Löschen' : `${count} löschen`,
    danger: true,
  });
  if (!confirmed) return;
  const { ok, fail } = await runBounded(ids, 3, (id) => moviesStore.remove(id));
  selectedIds.value = [];
  if (fail === 0) toast.value?.add(count === 1 ? 'Gelöscht' : `${count} Titel gelöscht`, 'success');
  else toast.value?.add(`Löschen: ${ok} gelöscht, ${fail} fehlgeschlagen`, 'warning');
}

function openDetail(movie: Movie) {
  const eff = groupKey(movie) as MovieStatus;
  const pkg = packageForMovie(movie);
  const extracting = !!extractingByPrefix.value.get(movieKey(movie));
  openFromMovie(movie, eff, pkg, extracting);
}

// Deep-Link: /movies?highlight=<id> öffnet direkt das DetailPanel des Titels.
// Die Command-Palette übergibt den Parameter seit jeher — er wurde nur nie
// ausgewertet, der User musste den Titel in der Liste selbst wiederfinden.
// Watcher statt onMounted, weil der Movies-Store beim Mount evtl. noch lädt.
const route = useRoute();
const router = useRouter();
watch(
  [() => route.query.highlight, () => moviesStore.movies.length],
  () => {
    const raw = route.query.highlight;
    if (typeof raw !== 'string' || !raw) return;
    const m = moviesStore.movies.find(x => x.id === Number(raw));
    if (!m) return; // Store lädt noch — der length-Watcher feuert erneut.
    openDetail(m);
    router.replace({ query: { ...route.query, highlight: undefined } });
  },
  { immediate: true },
);

async function onPanelRetry(id: number | string) {
  if (await retry(Number(id))) closePanel();
}

async function onPanelDelete(pm: { id: number | string }) {
  const m = movies.value.find(x => x.id === Number(pm.id));
  if (!m) return;
  if (await remove(m)) closePanel();
}
async function onSetSeasonCutoff(id: number | string, cutoff: number | null) {
  try {
    await setSeasonCutoff(Number(id), cutoff);
    if (panelMovie.value) panelMovie.value = { ...panelMovie.value, seasonCutoff: cutoff };
    toast.value?.add(cutoff == null ? 'Alle Staffeln werden geladen' : `Download ab Staffel ${cutoff}`, 'success');
    await moviesStore.fetch(true);
  } catch (e) {
    toast.value?.add(apiMessage(e, 'Staffel-Auswahl konnte nicht gespeichert werden'), 'error');
    // The panel switched optimistically — put it back to the stored value.
    if (panelMovie.value) panelMovie.value = { ...panelMovie.value };
  }
}

async function onSetQualityOverride(id: number | string, mode: 'relaxed' | 'any' | null) {
  try {
    await setQualityOverride(Number(id), mode);
    if (panelMovie.value) panelMovie.value = { ...panelMovie.value, qualityOverride: mode };
    toast.value?.add(
      mode == null ? 'Globaler Qualitätsfilter aktiv'
        : mode === 'relaxed' ? 'Filter gelockert — beste Version in gewünschter Sprache'
        : 'Filter aufgehoben — jedes Release wird akzeptiert',
      'success',
    );
    await moviesStore.fetch(true);
  } catch (e) {
    toast.value?.add(apiMessage(e, 'Filter-Auswahl konnte nicht gespeichert werden'), 'error');
    if (panelMovie.value) panelMovie.value = { ...panelMovie.value };
  }
}

useSearchShortcut(searchInput);

onMounted(() => {
  moviesStore.fetch();
  dlStore.fetch();
});
</script>

<style scoped>
.qx-retry { display: flex; justify-content: center; padding: 0 0 20px; }
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
/* Mobile: one compact, edge-to-edge scrollable row instead of 2–3 wrapped rows */
@media (max-width: 768px) {
  .qx-chips {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    padding-bottom: 2px;
  }
  .qx-chips::-webkit-scrollbar { display: none; }
  .qx-chip {
    flex: 0 0 auto;
    padding: 5px 10px 5px 9px;
    font-size: 12px;
    gap: 6px;
  }
  .qx-chip .count { font-size: 10px; padding: 1px 5px; }
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

@media (max-width: 768px) {
  .qx-active-strip { grid-template-columns: 1fr; }
}

/* ───── Bulk pill (Glass) ───── */
.qx-bulk {
  position: fixed;
  bottom: 24px;
  left: 50%;
  max-width: calc(100vw - 48px);
  transform: translate(calc(-50% + 120px), 0);
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
  transform: translate(calc(-50% + 120px), 30px);
}

@media (max-width: 768px) {
  .qx-bulk {
    left: 12px;
    right: 12px;
    /* Clear of the fixed bottom nav (64 px + safe area) — under it the
       Retry/Löschen buttons could not be tapped. */
    bottom: calc(76px + env(safe-area-inset-bottom, 0px));
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
