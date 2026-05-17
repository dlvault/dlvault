import { watch, onMounted, onUnmounted, computed } from 'vue';
import { useDownloadsStore } from '../stores/downloads';

/**
 * Shared polling for download updates.
 * Uses ref-counting so multiple consumers (DownloadsView + DownloadTray)
 * share a single interval instead of duplicating API calls.
 */
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;
const POLL_INTERVAL = 5000;

function startPolling(store: ReturnType<typeof useDownloadsStore>) {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (store.activeCount > 0) {
      store.fetch(true);
    } else {
      stopPolling();
    }
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function useDownloadPolling() {
  const dlStore = useDownloadsStore();
  const activeCount = computed(() => dlStore.activeCount);

  const stopWatch = watch(activeCount, (val) => {
    if (val > 0 && refCount > 0) startPolling(dlStore);
  });

  onMounted(() => {
    refCount++;
    if (activeCount.value > 0) startPolling(dlStore);
  });

  onUnmounted(() => {
    refCount--;
    stopWatch();
    if (refCount === 0) stopPolling();
  });
}
