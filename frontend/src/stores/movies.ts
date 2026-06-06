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
  let sseTimer: ReturnType<typeof setTimeout> | null = null;
  // Responses can arrive out of order (a sync fires searching → found →
  // downloading in quick succession); only the newest request may write.
  let seq = 0;

  async function fetch(force = false) {
    const now = Date.now();
    if (!force && now - lastFetched < 3000 && movies.value.length > 0) return;
    lastFetched = now;
    const my = ++seq;

    try {
      const res = await getMovies();
      if (my !== seq) return;
      movies.value = res.data;
      error.value = null;
    } catch (e) {
      if (my === seq) error.value = 'Filme konnten nicht geladen werden';
    } finally {
      if (my === seq) loading.value = false;
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

  // Coalesce SSE bursts: a sync emits several movie:updated per title, each
  // used to trigger a full GET /movies.
  function onMovieUpdated() {
    if (sseTimer) return;
    sseTimer = setTimeout(() => {
      sseTimer = null;
      fetch(true);
    }, 400);
  }

  return { movies, loading, error, fetch, retry, remove, onMovieUpdated };
});
