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

  // Reset to page 1 when source changes (e.g. filter/search)
  watch(() => source.value.length, () => {
    if (page.value > totalPages.value) {
      page.value = Math.max(1, totalPages.value);
    }
  });

  return {
    page, totalPages, paginatedItems, itemsPerPage,
    hasNextPage, hasPrevPage,
    nextPage, prevPage, goToPage,
  };
}
