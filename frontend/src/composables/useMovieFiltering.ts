import { ref, computed, type ComputedRef } from 'vue';
import type { Movie } from '../types/index';
import { useDebouncedRef } from './useDebounce';
import { usePagination } from './usePagination';

export function useMovieFiltering(movies: ComputedRef<Movie[]>) {
  const search = ref('');
  const debouncedSearch = useDebouncedRef(search);
  const statusFilter = ref('active');
  const sortKey = ref('');
  const sortAsc = ref(true);
  const selectedIds = ref<number[]>([]);

  // Status counts for filter chips
  const statusCounts = computed(() => {
    const counts: Record<string, number> = {
      active: 0, '': 0, pending: 0, searching: 0,
      found: 0, downloading: 0, downloaded: 0, not_found: 0,
    };
    for (const m of movies.value) {
      counts['']++;
      counts[m.status] = (counts[m.status] || 0) + 1;
      if (m.status !== 'downloaded') counts.active++;
    }
    return counts;
  });

  const filterOptions = computed(() => [
    { value: 'active', label: 'Aktive', count: statusCounts.value.active },
    { value: '', label: 'Alle', count: statusCounts.value[''] },
    { value: 'pending', label: 'Ausstehend', count: statusCounts.value.pending },
    { value: 'searching', label: 'Suche', count: statusCounts.value.searching },
    { value: 'found', label: 'Gefunden', count: statusCounts.value.found },
    { value: 'downloading', label: 'Laden', count: statusCounts.value.downloading },
    { value: 'downloaded', label: 'Fertig', count: statusCounts.value.downloaded },
    { value: 'not_found', label: 'Fehlt', count: statusCounts.value.not_found },
  ]);

  // Filtering
  const filteredMovies = computed(() => {
    let result = movies.value;
    if (statusFilter.value === 'active') {
      result = result.filter(m => m.status !== 'downloaded');
    } else if (statusFilter.value) {
      result = result.filter(m => m.status === statusFilter.value);
    }
    if (debouncedSearch.value.trim()) {
      const q = debouncedSearch.value.toLowerCase();
      result = result.filter(m =>
        m.title.toLowerCase().includes(q) || String(m.year).includes(q)
      );
    }
    return result;
  });

  // Sorting
  const sortedMovies = computed(() => {
    if (!sortKey.value) return filteredMovies.value;
    const key = sortKey.value as keyof Movie;
    return [...filteredMovies.value].sort((a, b) => {
      const va = a[key] ?? '';
      const vb = b[key] ?? '';
      const cmp = String(va).localeCompare(String(vb), 'de', { numeric: true });
      return sortAsc.value ? cmp : -cmp;
    });
  });

  // Pagination
  const pagination = usePagination(sortedMovies, 50);

  // Sort helpers
  function toggleSort(key: string) {
    if (sortKey.value === key) {
      sortAsc.value = !sortAsc.value;
    } else {
      sortKey.value = key;
      sortAsc.value = true;
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

  // Selection
  const allSelected = computed(() =>
    pagination.paginatedItems.value.length > 0 &&
    pagination.paginatedItems.value.every(m => selectedIds.value.includes(m.id))
  );

  function toggleAll() {
    if (allSelected.value) {
      selectedIds.value = [];
    } else {
      selectedIds.value = pagination.paginatedItems.value.map(m => m.id);
    }
  }

  function toggleSelect(id: number) {
    const idx = selectedIds.value.indexOf(id);
    if (idx >= 0) {
      selectedIds.value.splice(idx, 1);
    } else {
      selectedIds.value.push(id);
    }
  }

  return {
    search, debouncedSearch, statusFilter,
    filterOptions, sortedMovies,
    toggleSort, sortIcon, ariaSort,
    selectedIds, allSelected, toggleAll, toggleSelect,
    ...pagination,
  };
}
