<template>
  <div class="lx">
    <!-- Header — H1 with serif count + search -->
    <header class="lx-header">
      <h1 class="lx-title">
        Mediathek <span class="serif">{{ filteredItems.length }}</span>
      </h1>
      <div class="lx-tools">
        <div class="lx-search-wrap">
          <Search :size="14" class="lx-search-icon" />
          <input
            ref="searchInput"
            v-model="search"
            class="lx-search"
            type="text"
            placeholder="Mediathek durchsuchen…"
            aria-label="Mediathek durchsuchen"
          />
        </div>
      </div>
    </header>

    <div v-if="source === 'none' && !loading" class="alert alert-error">
      Keine Mediathek konfiguriert. Media Server in den Einstellungen verbinden.
    </div>

    <SkeletonLoader v-if="loading" variant="grid" :count="12" />

    <template v-else-if="source !== 'none' && items.length > 0">
      <!-- Stat strip — Filme · Serien · Kürzlich · Gesamt -->
      <LibraryStatStrip :items="enrichedItems" />

      <!-- Tabs + sort -->
      <div class="lx-bar">
        <div class="lx-tabs" role="tablist" aria-label="Mediathek-Typ">
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'movie'"
            :class="['lx-tab', { active: tab === 'movie' }]"
            @click="tab = 'movie'"
          >
            Filme<span class="lx-tab-count">{{ counts.movie }}</span>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'show'"
            :class="['lx-tab', { active: tab === 'show' }]"
            @click="tab = 'show'"
          >
            Serien<span class="lx-tab-count">{{ counts.show }}</span>
          </button>
        </div>

        <div class="lx-sort">
          <select id="lx-sort-select" v-model="sort" class="lx-sort-select" aria-label="Sortieren">
            <option value="title">Titel · A–Z</option>
            <option value="title_desc">Titel · Z–A</option>
            <option value="year_desc">Jahr · neueste</option>
            <option value="year_asc">Jahr · älteste</option>
            <option v-if="hasAddedAt" value="added">Zuletzt hinzugefügt</option>
          </select>
        </div>
      </div>

      <!-- Featured "Frisch hinzugefügt" — only with enough enriched items + the
           default view (no search, no special sort). -->
      <LibraryFeaturedShelf
        v-if="showFeatured"
        :items="featuredItems"
        :selected-id="panelMovie?.id"
        @open="openItem"
        @delete="confirmDelete"
      />

      <!-- Empty after filter / search -->
      <div v-if="filteredItems.length === 0" class="lx-empty">
        <div class="icon-circle"><Search :size="22" /></div>
        <div class="title">Keine Treffer</div>
        <div class="sub">Suchbegriff anpassen oder die andere Kategorie versuchen.</div>
      </div>

      <!-- Grid + alphabet rail -->
      <div v-else class="lx-grid-wrap">
        <div class="lx-grid-main" ref="gridRef">
          <section
            v-for="bucket in bucketedItems"
            :key="bucket.letter"
            class="lx-section"
            :data-bucket-section="bucket.letter"
          >
            <header v-if="showBuckets" class="lx-section-head">
              <span class="lx-section-letter">{{ bucket.letter }}</span>
              <span class="lx-section-count">{{ bucket.items.length }} {{ bucket.items.length === 1 ? 'Titel' : 'Titel' }}</span>
            </header>
            <div class="lx-grid">
              <div
                v-for="(item, idx) in bucket.items"
                :key="item.id"
                class="lx-tile"
                :style="{ animationDelay: (Math.min(idx, 20) * 22) + 'ms' }"
              ><!-- Delay capped: only the first viewport cascades. Unbounded idx*22 made
                   tile 300 wait 6.6s — and with content-visibility the animation would
                   only START when scrolled into view, leaving tiles blank for seconds. -->
                <LibraryPoster
                  :title="item.name"
                  :year="item.year"
                  :media-type="item.mediaType"
                  :poster-url="item.posterUrl"
                  :quality="item.quality"
                  :rating="item.rating"
                  :runtime-label="item.runtimeLabel"
                  :genres="item.genres"
                  :selected="panelMovie?.id === item.id"
                  @open="openItem(item)"
                  @delete="confirmDelete(item)"
                />
                <div class="lx-tile-label">
                  <div class="name">
                    <HighlightText :text="item.name" :query="debouncedSearch" />
                  </div>
                  <div class="meta">
                    <template v-if="item.year">{{ item.year }}</template>
                    <span v-if="item.year && item.quality" :class="{ hl: item.quality === '4K' }"> · {{ item.quality }}</span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>

        <aside
          v-if="showBuckets && availableBuckets.size > 1"
          class="lx-alphabet"
          aria-label="Sprungnavigation"
        >
          <button
            v-for="letter in ALPHABET"
            :key="letter"
            type="button"
            :class="['lx-alpha-btn', { disabled: !availableBuckets.has(letter) }]"
            :disabled="!availableBuckets.has(letter)"
            :aria-label="letter === '#' ? 'Zu Sonderzeichen springen' : 'Zu ' + letter + ' springen'"
            @click="jumpTo(letter)"
          >{{ letter }}</button>
        </aside>
      </div>
    </template>

    <!-- No items at all -->
    <div v-if="!loading && source !== 'none' && items.length === 0" class="card">
      <EmptyState
        icon="Search"
        :title="filter === 'movie' ? 'Keine Filme in der Mediathek' : 'Keine Serien in der Mediathek'"
        :description="''"
      />
    </div>

    <DetailPanel
      :movie="panelMovie"
      :context="panelContext"
      @close="closePanel"
      @open-in-jellyfin="onOpenInMediaServer"
      @delete="onPanelDelete"
      @set-season-cutoff="onSetSeasonCutoff"
      @set-quality-override="onSetQualityOverride"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { getLibrary, deleteLibraryItem, setSeasonCutoff, setQualityOverride } from '../api/index';
import type { LibraryItem, Movie } from '../types/index';
import { useToast, useConfirm } from '../composables/useApp';
import { useDebouncedRef } from '../composables/useDebounce';
import { useDetailPanel } from '../composables/useDetailPanel';
import { useMoviesStore } from '../stores/movies';
import { useSearchShortcut } from '../composables/useSearchShortcut';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import EmptyState from '../components/EmptyState.vue';
import DetailPanel from '../components/DetailPanel.vue';
import HighlightText from '../components/HighlightText.vue';
import LibraryStatStrip from '../components/library/LibraryStatStrip.vue';
import LibraryFeaturedShelf from '../components/library/LibraryFeaturedShelf.vue';
import LibraryPoster from '../components/library/LibraryPoster.vue';
import { enrichItems, type EnrichedLibraryItem } from '../components/library/libraryItem';
import { Search } from 'lucide-vue-next';

const toast = useToast();
const confirmModal = useConfirm();
const moviesStore = useMoviesStore();
const { movie: panelMovie, context: panelContext, close: closePanel, openFromLibraryItem } = useDetailPanel();

const items = ref<LibraryItem[]>([]);
const source = ref('none');
const loading = ref(true);
const tab = ref<'movie' | 'show'>('movie');
const search = ref('');
const debouncedSearch = useDebouncedRef(search);
const sort = ref<'title' | 'title_desc' | 'year_desc' | 'year_asc' | 'added'>('title');
const searchInput = ref<HTMLInputElement>();
const gridRef = ref<HTMLElement | null>(null);

// Back-compat alias for the empty-state copy below.
const filter = computed(() => tab.value);

const ALPHABET = ['#', 'A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];
const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

// ───── Enrichment + filtering ─────

const enrichedItems = computed<EnrichedLibraryItem[]>(() =>
  enrichItems(items.value, moviesStore.movies),
);

const hasAddedAt = computed(() => enrichedItems.value.some(i => i.addedAt));

const counts = computed(() => {
  let movie = 0, show = 0;
  for (const i of enrichedItems.value) {
    if (i.mediaType === 'movie') movie++;
    else if (i.mediaType === 'show') show++;
  }
  return { movie, show };
});

const filteredItems = computed<EnrichedLibraryItem[]>(() => {
  let list = enrichedItems.value.filter(i => i.mediaType === tab.value);
  const q = debouncedSearch.value.trim().toLowerCase();
  if (q) {
    list = list.filter(i =>
      i.name?.toLowerCase().includes(q) ||
      String(i.year ?? '').includes(q) ||
      (i.genres || []).some(g => g.toLowerCase().includes(q)),
    );
  }
  return list;
});

const sortedItems = computed<EnrichedLibraryItem[]>(() => {
  const list = [...filteredItems.value];
  const cmpTitle = (a: EnrichedLibraryItem, b: EnrichedLibraryItem) => collator.compare(a.sortName, b.sortName);
  switch (sort.value) {
    case 'title':       list.sort(cmpTitle); break;
    case 'title_desc':  list.sort((a, b) => -cmpTitle(a, b)); break;
    case 'year_desc':   list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || cmpTitle(a, b)); break;
    case 'year_asc':    list.sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || cmpTitle(a, b)); break;
    case 'added':
      // Items without an addedAt timestamp sink to the bottom — they would
      // otherwise jump to the top via "" < anything.
      list.sort((a, b) => {
        if (!!a.addedAt === !!b.addedAt) return (b.addedAt || '').localeCompare(a.addedAt || '') || cmpTitle(a, b);
        return a.addedAt ? -1 : 1;
      });
      break;
  }
  return list;
});

// Letter sections are only meaningful when sorting alphabetically. For year /
// recency sorts we drop the headers and render a single ungrouped block.
const showBuckets = computed(() => sort.value === 'title' || sort.value === 'title_desc');

const bucketedItems = computed(() => {
  if (!showBuckets.value) {
    return [{ letter: '__all', items: sortedItems.value }];
  }
  const groups = new Map<string, EnrichedLibraryItem[]>();
  for (const it of sortedItems.value) {
    const arr = groups.get(it.bucket) ?? [];
    arr.push(it);
    groups.set(it.bucket, arr);
  }
  return [...groups.entries()].map(([letter, list]) => ({ letter, items: list }));
});

const availableBuckets = computed(() => {
  const s = new Set<string>();
  for (const i of sortedItems.value) s.add(i.bucket);
  return s;
});

// ───── Featured shelf ─────

// Only show when (a) we have at least 4 items with a real addedAt timestamp,
// (b) the user hasn't started filtering, and (c) we're on the default sort —
// otherwise the shelf duplicates what the grid already shows in better order.
const DAY = 86_400_000;
const featuredItems = computed<EnrichedLibraryItem[]>(() => {
  const cutoff = Date.now() - 60 * DAY;
  return enrichedItems.value
    .filter(i => i.mediaType === tab.value && i.addedAt)
    .filter(i => new Date(i.addedAt + 'Z').getTime() >= cutoff)
    .sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''))
    .slice(0, 10);
});
const showFeatured = computed(() =>
  !debouncedSearch.value.trim() && sort.value === 'title' && featuredItems.value.length >= 4,
);

// ───── A–Z jump ─────

function jumpTo(letter: string) {
  if (!availableBuckets.value.has(letter)) return;
  const el = gridRef.value?.querySelector(
    `[data-bucket-section="${CSS.escape(letter)}"]`,
  ) as HTMLElement | null;
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ───── Data loading ─────

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

// ───── Detail panel + actions ─────

function matchMovie(item: LibraryItem): Movie | null {
  if (item.imdbId) {
    const byImdb = moviesStore.movies.find(m => m.imdb_id === item.imdbId);
    if (byImdb) return byImdb;
  }
  return moviesStore.movies.find(m => m.title === item.name && m.year === item.year)
    || moviesStore.movies.find(m => m.title === item.name)
    || null;
}

function openItem(item: LibraryItem) {
  openFromLibraryItem(item, matchMovie(item));
}

function onOpenInMediaServer(pm: { deepLinkUrl?: string | null }) {
  if (pm.deepLinkUrl) {
    window.open(pm.deepLinkUrl, '_blank', 'noopener');
  } else {
    toast.value?.add('Direktlink zum Mediaserver ist nicht verfügbar', 'info');
  }
}

async function onPanelDelete(pm: { id: number | string }) {
  const item = items.value.find(i => i.id === String(pm.id));
  if (!item) { closePanel(); return; }
  await confirmDelete(item);
  closePanel();
}
async function onSetSeasonCutoff(id: number | string, cutoff: number | null) {
  try {
    await setSeasonCutoff(Number(id), cutoff);
    toast.value?.add(cutoff == null ? 'Alle Staffeln werden geladen' : `Download ab Staffel ${cutoff}`, 'success');
  } catch {
    toast.value?.add('Staffel-Auswahl konnte nicht gespeichert werden', 'error');
  }
}

// A library title downloaded with a relaxed per-title filter keeps showing the
// override selector so it can be reset from here too.
async function onSetQualityOverride(id: number | string, mode: 'relaxed' | 'any' | null) {
  try {
    await setQualityOverride(Number(id), mode);
    toast.value?.add(
      mode == null ? 'Globaler Qualitätsfilter aktiv'
        : mode === 'relaxed' ? 'Filter gelockert — beste Version in gewünschter Sprache'
        : 'Filter aufgehoben — jedes Release wird akzeptiert',
      'success',
    );
  } catch {
    toast.value?.add('Filter-Auswahl konnte nicht gespeichert werden', 'error');
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

// ───── Persisted sort preference ─────

const SORT_KEY = 'dlvault.library.sort';
const stored = typeof window !== 'undefined' ? localStorage.getItem(SORT_KEY) : null;
if (stored === 'title' || stored === 'title_desc' || stored === 'year_desc' || stored === 'year_asc' || stored === 'added') {
  sort.value = stored;
}
watch(sort, v => { try { localStorage.setItem(SORT_KEY, v); } catch { /* ignore */ } });

// If the user persisted 'added' but the current library has no timestamps yet,
// quietly fall back to title sort instead of leaving an unsortable selection.
watch(hasAddedAt, has => {
  if (!has && sort.value === 'added') sort.value = 'title';
});

useSearchShortcut(searchInput);

onMounted(() => {
  loadLibrary();
  moviesStore.fetch();
});
</script>

<style scoped>
.lx {
  display: flex; flex-direction: column;
  gap: 22px;
}

/* ───── Header ───── */
.lx-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 18px;
  flex-wrap: wrap;
}
.lx-title {
  font-size: 28px; font-weight: 600;
  letter-spacing: -0.02em;
  display: flex; align-items: baseline; gap: 12px;
}
.lx-title .serif {
  font-family: var(--font-serif);
  font-style: italic; font-weight: 400;
  color: var(--accent-2);
  font-size: 22px;
}
.lx-tools { display: flex; align-items: center; gap: 10px; }

.lx-search-wrap {
  position: relative;
  display: inline-flex; align-items: center;
}
.lx-search-icon {
  position: absolute; left: 12px;
  color: var(--text-3);
  pointer-events: none;
}
.lx-search {
  width: 260px; max-width: 50vw;
  padding: 8px 12px 8px 32px;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-primary);
  font-family: var(--font-sans); font-size: 13px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s, width 0.2s;
}
.lx-search::placeholder { color: var(--text-3); }
.lx-search:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  width: 320px;
}

/* ───── Tab bar + sort ───── */
.lx-bar {
  display: flex; align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.lx-tabs {
  display: inline-flex;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px;
  gap: 2px;
}
.lx-tab {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 7px 16px 7px 14px;
  background: transparent; border: none;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 13px; font-weight: 500;
  cursor: pointer;
  border-radius: 999px;
  transition: background 0.15s, color 0.15s;
}
.lx-tab:hover:not(.active) { color: var(--text-primary); }
.lx-tab.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.lx-tab-count {
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-3);
}
.lx-tab.active .lx-tab-count {
  background: rgba(240, 107, 130, 0.18);
  color: var(--accent);
}

.lx-sort {
  margin-left: auto;
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.lx-sort-select {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  padding: 6px 10px;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 12.5px;
  cursor: pointer;
  outline: none;
  transition: border-color 0.15s;
}
.lx-sort-select:hover { border-color: var(--line-2); }
.lx-sort-select:focus { border-color: var(--accent); }

/* ───── Grid + alphabet rail ───── */
.lx-grid-wrap {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
.lx-grid-main { flex: 1; min-width: 0; }

.lx-section {
  display: flex; flex-direction: column;
  gap: 10px;
  margin-bottom: 22px;
  scroll-margin-top: 14px;
  /* Offscreen letter sections cost no layout/paint — without this, EVERY
     poster tile of a large library is a live DOM node the browser lays out
     on each frame. 520px is only the pre-render estimate; `auto` remembers
     the real height once a section was on screen (stable scrollbar). */
  content-visibility: auto;
  contain-intrinsic-size: auto 520px;
}
.lx-section:last-child { margin-bottom: 0; }
.lx-section-head {
  display: flex; align-items: baseline; gap: 10px;
  padding: 6px 4px 4px;
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  z-index: 4;
  background: linear-gradient(180deg, var(--bg-primary) 0%, var(--bg-primary) 70%, transparent 100%);
}
.lx-section-letter {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 26px;
  color: var(--accent-2);
  line-height: 1;
  letter-spacing: -0.01em;
}
.lx-section-count {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.lx-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 14px;
}
.lx-tile {
  display: flex; flex-direction: column;
  gap: 6px;
  animation: lxCascadeIn 0.32s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  /* Second level of the same trick: the year/recent sorts render ONE flat
     section, so section-level skipping alone wouldn't help there. ~250px ≈
     2:3 poster at typical column width + label; `auto` corrects after paint. */
  content-visibility: auto;
  contain-intrinsic-size: auto 250px;
}
.lx-tile-label {
  padding: 0 2px;
  display: flex; flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.lx-tile-label .name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: -0.005em;
}
.lx-tile-label .meta {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.lx-tile-label .meta .hl { color: var(--accent); }

/* Alphabet rail */
.lx-alphabet {
  position: sticky;
  top: 18px;
  display: flex; flex-direction: column;
  gap: 1px;
  padding: 6px 4px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 999px;
  flex-shrink: 0;
  max-height: calc(100vh - 36px);
  overflow-y: auto;
  scrollbar-width: none;
}
.lx-alphabet::-webkit-scrollbar { display: none; }
.lx-alpha-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 600;
  width: 22px;
  height: 20px;
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  transition: background 0.15s, color 0.15s;
}
.lx-alpha-btn:not(:disabled):hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.lx-alpha-btn.disabled {
  opacity: 0.22;
  cursor: default;
  pointer-events: none;
}

/* Empty state (filter / search yielded nothing) */
.lx-empty {
  padding: 60px 40px;
  text-align: center;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  color: var(--text-secondary);
}
.lx-empty .icon-circle {
  width: 56px; height: 56px;
  border-radius: 50%;
  background: var(--surface-2);
  border: 1px solid var(--line);
  display: inline-grid; place-items: center;
  color: var(--text-3);
  margin-bottom: 14px;
}
.lx-empty .title {
  font-size: 16px; font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
}
.lx-empty .sub { font-size: 13px; color: var(--text-3); }

/* ───── Animations ───── */
@keyframes lxCascadeIn {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* ───── Responsive ───── */
@media (max-width: 1100px) {
  .lx-alphabet { display: none; }
}
@media (max-width: 768px) {
  .lx-header { align-items: stretch; }
  .lx-search { width: 100%; max-width: none; }
  .lx-search:focus { width: 100%; }
  .lx-tools { width: 100%; }
  .lx-search-wrap { flex: 1; }
  .lx-grid {
    grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
    gap: 10px;
  }
  /* Keep the sort dropdown inline with the Filme/Serien tabs on one line, and
     let it shrink/truncate instead of overflowing the page edge (flex items
     default to min-width:auto, which is what made it bleed past the margin). */
  .lx-bar { flex-wrap: nowrap; gap: 10px; }
  .lx-tabs { flex: 0 0 auto; }
  .lx-sort { min-width: 0; }
  .lx-sort-select { min-width: 0; max-width: 100%; }
}
</style>
