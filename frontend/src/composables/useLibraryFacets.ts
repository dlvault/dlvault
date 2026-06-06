import { ref, computed, watch, onMounted, type Ref, type ComputedRef } from 'vue';
import type { EnrichedLibraryItem } from '../components/library/libraryItem';

export interface SavedView {
  id: string;
  name: string;
  genres: string[];
  quality: string[];
  yearMin: number | null;
  yearMax: number | null;
}

export interface FacetChip {
  key: string;
  kind: 'genre' | 'quality' | 'year';
  label: string;
  value: string;
}

const VIEWS_KEY = 'dlvault.library.views';

function loadViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(VIEWS_KEY);
    return raw ? (JSON.parse(raw) as SavedView[]) : [];
  } catch {
    return [];
  }
}

/**
 * Client-side facet filtering over already-loaded library items.
 * `items` should be tab-scoped (movie/show) so option counts match the grid.
 */
export function useLibraryFacets(items: ComputedRef<EnrichedLibraryItem[]>) {
  const genres = ref<string[]>([]);
  const quality = ref<string[]>([]);
  const yearMin = ref<number | null>(null);
  const yearMax = ref<number | null>(null);

  // ── Option universes (derived from whatever is loaded) ──
  const genreOptions = computed(() => {
    const c = new Map<string, number>();
    for (const i of items.value) for (const g of i.genres || []) c.set(g, (c.get(g) || 0) + 1);
    return [...c.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de'))
      .map(([value, count]) => ({ value, count }));
  });

  const QUALITY_ORDER = ['4K', '1080p', '720p'];
  const qualityOptions = computed(() => {
    const c = new Map<string, number>();
    for (const i of items.value) if (i.quality) c.set(i.quality, (c.get(i.quality) || 0) + 1);
    return [...c.entries()]
      .sort((a, b) => {
        const ia = QUALITY_ORDER.indexOf(a[0]);
        const ib = QUALITY_ORDER.indexOf(b[0]);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a[0].localeCompare(b[0]);
      })
      .map(([value, count]) => ({ value, count }));
  });

  const yearBounds = computed(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const i of items.value) if (i.year) { lo = Math.min(lo, i.year); hi = Math.max(hi, i.year); }
    return Number.isFinite(lo) ? { min: lo, max: hi } : { min: null as number | null, max: null as number | null };
  });

  // ── Filtering: OR within a facet, AND across facets ──
  function apply(list: EnrichedLibraryItem[]): EnrichedLibraryItem[] {
    const gs = genres.value, qs = quality.value, ymin = yearMin.value, ymax = yearMax.value;
    if (!gs.length && !qs.length && ymin == null && ymax == null) return list;
    return list.filter((i) => {
      if (gs.length && !(i.genres || []).some((g) => gs.includes(g))) return false;
      if (qs.length && !(i.quality && qs.includes(i.quality))) return false;
      if (ymin != null && (i.year == null || i.year < ymin)) return false;
      if (ymax != null && (i.year == null || i.year > ymax)) return false;
      return true;
    });
  }

  const activeCount = computed(
    () => genres.value.length + quality.value.length + (yearMin.value != null || yearMax.value != null ? 1 : 0),
  );

  // ── Toggles / reset (any manual change drops the active saved-view highlight) ──
  function toggle(arr: Ref<string[]>, v: string) {
    const idx = arr.value.indexOf(v);
    if (idx >= 0) arr.value.splice(idx, 1);
    else arr.value.push(v);
    activeViewId.value = null;
    syncUrl();
  }
  const toggleGenre = (g: string) => toggle(genres, g);
  const toggleQuality = (q: string) => toggle(quality, q);
  function setYear(min: number | null, max: number | null) {
    yearMin.value = Number.isFinite(min as number) ? min : null;
    yearMax.value = Number.isFinite(max as number) ? max : null;
    activeViewId.value = null;
    syncUrl();
  }
  function reset() {
    genres.value = [];
    quality.value = [];
    yearMin.value = null;
    yearMax.value = null;
    activeViewId.value = null;
    syncUrl();
  }

  // ── Active-filter chips ──
  const chips = computed<FacetChip[]>(() => {
    const out: FacetChip[] = [];
    for (const g of genres.value) out.push({ key: 'g:' + g, kind: 'genre', label: 'Genre', value: g });
    for (const q of quality.value) out.push({ key: 'q:' + q, kind: 'quality', label: 'Qualität', value: q });
    if (yearMin.value != null || yearMax.value != null) {
      const lo = yearMin.value ?? yearBounds.value.min;
      const hi = yearMax.value ?? yearBounds.value.max;
      out.push({ key: 'year', kind: 'year', label: 'Jahr', value: `${lo}–${hi}` });
    }
    return out;
  });
  function removeChip(c: FacetChip) {
    if (c.kind === 'genre') toggleGenre(c.value);
    else if (c.kind === 'quality') toggleQuality(c.value);
    else setYear(null, null);
  }

  // ── Saved views (localStorage) ──
  const views = ref<SavedView[]>(loadViews());
  const activeViewId = ref<string | null>(null);
  watch(views, (v) => { try { localStorage.setItem(VIEWS_KEY, JSON.stringify(v)); } catch { /* quota */ } }, { deep: true });

  function saveView(name: string) {
    const v: SavedView = {
      id: 'v' + Date.now().toString(36),
      name: name.trim() || 'Ansicht',
      genres: [...genres.value],
      quality: [...quality.value],
      yearMin: yearMin.value,
      yearMax: yearMax.value,
    };
    views.value.push(v);
    activeViewId.value = v.id;
    syncUrl();
  }
  function applyView(v: SavedView) {
    genres.value = [...v.genres];
    quality.value = [...v.quality];
    yearMin.value = v.yearMin;
    yearMax.value = v.yearMax;
    activeViewId.value = v.id;
    syncUrl();
  }
  function deleteView(id: string) {
    views.value = views.value.filter((v) => v.id !== id);
    if (activeViewId.value === id) { activeViewId.value = null; syncUrl(); }
  }

  // ── URL ?view=<id> — History API keeps this decoupled from vue-router ──
  function syncUrl() {
    try {
      const url = new URL(location.href);
      if (activeViewId.value) url.searchParams.set('view', activeViewId.value);
      else url.searchParams.delete('view');
      history.replaceState(history.state, '', url);
    } catch { /* noop */ }
  }
  onMounted(() => {
    try {
      const id = new URL(location.href).searchParams.get('view');
      const v = id ? views.value.find((x) => x.id === id) : null;
      if (v) applyView(v);
    } catch { /* noop */ }
  });

  return {
    genres, quality, yearMin, yearMax,
    genreOptions, qualityOptions, yearBounds,
    apply, activeCount, chips, removeChip,
    toggleGenre, toggleQuality, setYear, reset,
    views, activeViewId, saveView, applyView, deleteView,
  };
}
