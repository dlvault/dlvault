import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getMovies, retryMovie, deleteMovie } from '../api/index';
import type { Movie } from '../types/index';

export const useMoviesStore = defineStore('movies', () => {
  const movies = ref<Movie[]>([]);
  const loading = ref(true);
  const error = ref<string | null>(null);
  let lastFetched = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  async function fetch(force = false) {
    const now = Date.now();
    if (!force && now - lastFetched < 3000 && movies.value.length > 0) return;
    lastFetched = now;

    try {
      const res = await getMovies();
      movies.value = res.data;
      error.value = null;
    } catch (e) {
      error.value = 'Filme konnten nicht geladen werden';
    } finally {
      loading.value = false;
    }
  }

  async function retry(id: number) {
    await retryMovie(id);
    // Debounced refetch to pick up status change
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      fetch(true);
    }, 2000);
  }

  async function remove(id: number) {
    await deleteMovie(id);
    movies.value = movies.value.filter(m => m.id !== id);
  }

  function onMovieUpdated() {
    fetch(true);
  }

  return { movies, loading, error, fetch, retry, remove, onMovieUpdated };
});
