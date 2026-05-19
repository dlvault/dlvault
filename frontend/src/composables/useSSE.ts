import { ref, onMounted, onUnmounted } from 'vue';
import { subscribeToEvents } from '../api/index';
import { useSyncStore } from '../stores/sync';
import { useMoviesStore } from '../stores/movies';
import { useDownloadsStore } from '../stores/downloads';

export const sseConnected = ref(false);
let eventSource: EventSource | null = null;
let refCount = 0;

function handleEvent(event: string, _data: unknown) {
  const sync = useSyncStore();
  const movies = useMoviesStore();
  const downloads = useDownloadsStore();

  switch (event) {
    case 'sync:started':
      sync.onSyncStarted();
      break;
    case 'sync:progress':
      sync.onSyncProgress();
      break;
    case 'sync:completed':
      sync.onSyncCompleted();
      movies.onMovieUpdated();
      break;
    case 'log:created':
      sync.onLogCreated();
      break;
    case 'movie:updated':
      sync.onMovieUpdated();
      movies.onMovieUpdated();
      break;
    case 'download:progress':
    case 'download:complete':
    case 'download:started':
      downloads.onDownloadUpdated();
      break;
  }
}

function connect() {
  if (eventSource) return;

  eventSource = subscribeToEvents(handleEvent);

  eventSource.onopen = () => {
    sseConnected.value = true;
  };

  eventSource.onerror = () => {
    sseConnected.value = false;
    // Browser auto-reconnects EventSource
  };
}

function disconnect() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
    sseConnected.value = false;
  }
}

/**
 * Hook to manage the global SSE connection via ref-counting.
 * Call in App.vue — the connection stays alive while the app is mounted.
 */
export function useSSE() {
  onMounted(() => {
    refCount++;
    if (refCount === 1) connect();
  });

  onUnmounted(() => {
    refCount--;
    if (refCount === 0) disconnect();
  });

  return { sseConnected };
}
