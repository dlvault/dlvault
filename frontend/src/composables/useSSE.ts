import { ref, onMounted, onUnmounted } from 'vue';
import { subscribeToEvents } from '../api/index';
import { useSyncStore } from '../stores/sync';
import { useMoviesStore } from '../stores/movies';
import { useDownloadsStore } from '../stores/downloads';

export const sseConnected = ref(false);
let eventSource: EventSource | null = null;
let refCount = 0;
// EventSource auto-reconnects within a few seconds, and a reverse proxy in front
// of the server (e.g. via a DuckDNS domain) routinely recycles long-lived
// connections. Flipping the global "OFFLINE" badge on the first onerror made it
// flash constantly. Only declare offline if the stream stays down past this grace
// window — a reconnect (onopen) within it clears the pending flip.
const OFFLINE_GRACE_MS = 8000;
let offlineTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
    sseConnected.value = true;
  };

  eventSource.onerror = () => {
    // Browser auto-reconnects EventSource. Don't show OFFLINE for a brief blip —
    // only after the grace window elapses without a reconnect. onerror fires
    // repeatedly while down, so don't restart the countdown if it's already running.
    if (offlineTimer) return;
    offlineTimer = setTimeout(() => {
      sseConnected.value = false;
      offlineTimer = null;
    }, OFFLINE_GRACE_MS);
  };
}

function disconnect() {
  if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
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
