import { ref, computed, watch, type Ref, type ComputedRef } from 'vue';

export function usePagination<T>(source: ComputedRef<T[]> | Ref<T[]>, perPage = 50) {
  const page = ref(1);
  const itemsPerPage = ref(perPage);

  const totalPages = computed(() => Math.max(1, Math.ceil(source.value.length / itemsPerPage.value)));

  const paginatedItems = computed(() => {
    const start = (page.value - 1) * itemsPerPage.value;
    return source.value.slice(start, start + itemsPerPage.value);
  });

  const hasNextPage = computed(() => page.value < totalPages.value);
  const hasPrevPage = computed(() => page.value > 1);

  function nextPage() {
    if (hasNextPage.value) page.value++;
  }

  function prevPage() {
    if (hasPrevPage.value) page.value--;
  }

  function goToPage(p: number) {
    page.value = Math.max(1, Math.min(p, totalPages.value));
  }

  /**
   * Jump back to the first page. Call this when the FILTER changes — a narrowed
   * list has a new "top", and staying on page 5 showed matches 201-250 while the
   * best hits sat invisibly on page 1, which reads as a broken search.
   *
   * Deliberately explicit rather than watching the source length: these lists
   * are also live-polled, and resetting on every incremental change would yank
   * the user back to page 1 while they were reading page 4.
   */
  function resetPage() {
    page.value = 1;
  }

  // Keep the page in range when the source shrinks under it (e.g. items removed).
  watch(() => source.value.length, () => {
    if (page.value > totalPages.value) {
      page.value = Math.max(1, totalPages.value);
    }
  });

  return {
    page, totalPages, paginatedItems, itemsPerPage,
    hasNextPage, hasPrevPage,
    nextPage, prevPage, goToPage, resetPage,
  };
}
