import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { getJDPackages, getJDLinkGrabber } from '../api/index';
import type { DownloadPackage } from '../types/index';
import { formatSpeed } from '../composables/useFormatters';

export const useDownloadsStore = defineStore('downloads', () => {
  const connected = ref(false);
  const packages = ref<DownloadPackage[]>([]);
  const linkgrabber = ref<DownloadPackage[]>([]);
  const loading = ref(true);
  const error = ref<string | null>(null);
  let lastFetched = 0;
  // The MyJDownloader relay (api.jdownloader.org) throws transient 502/503 on the
  // packages poll while the session is perfectly valid. Flipping straight to
  // "disconnected" on a single failed poll made the status badge flicker
  // ("NICHT VERBUNDEN") every few minutes. Tolerate a couple of consecutive
  // misses — keep the last-known state — before declaring JD unreachable.
  const MAX_TRANSIENT_FAILS = 2;
  let failStreak = 0;

  // Active-form extraction phrases only — must NOT match past tense like
  // "erfolgreich entpackt", "extracted", or icon keys like "extractOk" which JD
  // leaves on packages permanently after a successful extraction.
  const ACTIVE_EXTRACT_RE = /wird\s+entpackt|wird\s+extrahiert|extracting/i;

  function isMoved(p: DownloadPackage): boolean {
    // Authoritative: backend confirmed the saveTo folder is gone.
    return !!p.isMoved;
  }

  function isExtracting(p: DownloadPackage): boolean {
    // Once the post-processor moved the source folder, the package is done —
    // don't keep flashing "Entpacken" forever.
    if (isMoved(p)) return false;

    // 1. Backend annotated this from JD's extraction queue or filesystem scan (authoritative)
    if (p.isExtracting) return true;

    // 2. JD status string — active progress phrases only
    const s = p.status || '';
    if (ACTIVE_EXTRACT_RE.test(s)) return true;

    // 3. statusIconKey: only the exact "extract" key (the spinner icon).
    //    "extractOk" / "extractError" / "archive" are post-completion or
    //    static indicators and persist on the package forever.
    const icon = (p.statusIconKey || '').toLowerCase();
    if (icon === 'extract') return true;

    return false;
  }

  function isError(p: DownloadPackage): boolean {
    const s = (p.status || '').toLowerCase();
    if (!s) return false;
    return s.startsWith('error') || s.includes('fehler') || s.includes('failed') || s.includes('offline');
  }

  const runningCount = computed(() =>
    packages.value.filter(p => p.running && !isExtracting(p) && !isMoved(p)).length
  );
  const extractingCount = computed(() => packages.value.filter(p => isExtracting(p)).length);
  const movedCount = computed(() => packages.value.filter(p => isMoved(p)).length);
  const finishedCount = computed(() =>
    packages.value.filter(p => p.finished && !isExtracting(p) && !isMoved(p)).length
  );
  const activeCount = computed(() => runningCount.value + extractingCount.value);
  const hasContent = computed(() => connected.value && packages.value.length > 0);
  const totalSpeed = computed(() => {
    const speed = packages.value.reduce((s, p) => s + (p.speed || 0), 0);
    return formatSpeed(speed);
  });

  async function fetch(force = false) {
    const now = Date.now();
    if (!force && now - lastFetched < 3000 && packages.value.length > 0) return;
    lastFetched = now;

    try {
      const [pkgRes, lgRes] = await Promise.all([
        getJDPackages().catch(() => ({ data: { connected: false, packages: [] } })),
        getJDLinkGrabber().catch(() => ({ data: [] })),
      ]);
      if (pkgRes.data.connected) {
        failStreak = 0;
        connected.value = true;
        packages.value = pkgRes.data.packages || [];
        linkgrabber.value = lgRes.data || [];
        error.value = null;
      } else {
        // Transient relay/network blip — keep the last-known packages + connected
        // state until we've missed several polls in a row, so the badge doesn't
        // flap on a single 502/503.
        failStreak++;
        if (failStreak > MAX_TRANSIENT_FAILS) {
          connected.value = false;
          packages.value = [];
          linkgrabber.value = [];
          error.value = 'JDownloader nicht erreichbar';
        }
      }
    } catch {
      failStreak++;
      if (failStreak > MAX_TRANSIENT_FAILS) {
        connected.value = false;
        error.value = 'JDownloader nicht erreichbar';
      }
    } finally {
      loading.value = false;
    }
  }

  function onDownloadUpdated() {
    fetch(true);
  }

  return {
    connected, packages, linkgrabber, loading, error,
    runningCount, extractingCount, movedCount, finishedCount, activeCount, hasContent, totalSpeed,
    fetch, onDownloadUpdated, isExtracting, isMoved, isError,
  };
});
