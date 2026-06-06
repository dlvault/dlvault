import { ref, onMounted, onUnmounted } from 'vue';
import { subscribeToEvents } from '../api/index';
import { useSyncStore } from '../stores/sync';
import { useMoviesStore } from '../stores/movies';
import { useDownloadsStore } from '../stores/downloads';

export const sseConnected = ref(false);
let eventSource: EventSource | null = null;
let refCount = 0;
// EventSource auto-reconnects within a few seconds, and a reverse proxy in front
// of the server (e.g. via a dynamic-DNS domain) routinely recycles long-lived
// connections. Flipping the global "OFFLINE" badge on the first onerror made it
// flash constantly. Only declare offline if the stream stays down past this grace
// window — a reconnect (onopen) within it clears the pending flip.
const OFFLINE_GRACE_MS = 8000;
let offlineTimer: ReturnType<typeof setTimeout> | null = null;

let everConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 2000;

function handleEvent(event: string, data: unknown) {
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
      // A title just went to JD: the downloads poll had stopped (nothing was
      // active), so without this the new package showed as "Wartet 0 %".
      if ((data as { status?: string } | null)?.status === 'downloading') downloads.onDownloadUpdated();
      break;
    case 'download:complete':
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
    reconnectDelay = 2000;
    // Events sent while the stream was down are lost — catch up once.
    if (everConnected) {
      useSyncStore().fetchAll();
      useMoviesStore().fetch(true);
      useDownloadsStore().fetch(true);
    }
    everConnected = true;
  };

  eventSource.onerror = () => {
    // The browser only retries network errors. A 502/503 from a reverse proxy
    // while dlvault restarts CLOSES the stream for good — reconnect ourselves.
    if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      eventSource.close();
      eventSource = null;
      if (!reconnectTimer && refCount > 0) {
        reconnectTimer = setTimeout(() => { reconnectTimer = null; if (refCount > 0) connect(); }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      }
    }
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
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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
