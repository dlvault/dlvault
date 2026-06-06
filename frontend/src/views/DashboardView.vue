<template>
  <div class="dashboard">
    <!-- Update banner -->
    <Transition name="slide-down">
      <div v-if="updateAvailable" class="update-banner">
        <span><Package :size="16" /> <strong>Neue Version verfügbar!</strong></span>
        <button class="btn update-btn" @click="showUpdateModal = true">Aktualisieren</button>
      </div>
    </Transition>

    <!-- JDownloader offline warning -->
    <Transition name="slide-down">
      <div v-if="jdOffline" class="jd-banner jd-banner-warn">
        <span>
          <AlertTriangle :size="16" />
          <strong>JDownloader nicht erreichbar</strong>
          — bitte JD starten. Laufende Downloads werden danach automatisch fortgesetzt.
        </span>
      </div>
    </Transition>

    <!-- JDownloader update available (mutually exclusive with jdOffline: that
         needs !connected, this needs connected — so plain v-if, not v-else-if) -->
    <Transition name="slide-down">
      <div v-if="jdUpdateAvailable" class="jd-banner jd-banner-info">
        <span><Download :size="16" /> <strong>JDownloader-Update verfügbar</strong></span>
        <button class="btn update-btn" :disabled="jdUpdating" @click="triggerJdUpdate">
          {{ jdUpdating ? 'Wird gestartet…' : 'JD aktualisieren' }}
        </button>
      </div>
    </Transition>

    <!-- Update modal -->
    <Transition name="wizard-fade">
      <div v-if="showUpdateModal" class="update-overlay" @click.self="closeUpdateModal">
        <div class="update-modal">
          <h3 v-if="updateState === 'idle'">Update verfügbar</h3>
          <h3 v-else-if="updateState === 'running'">Update läuft...</h3>
          <h3 v-else-if="updateState === 'done'">Update erfolgreich</h3>
          <h3 v-else>Update fehlgeschlagen</h3>

          <template v-if="updateState === 'idle' && canStartUpdate">
            <p class="update-steps">
              Der Updater lädt das neueste Image aus der Registry, ersetzt den Container und prüft die Health.
              Konfiguration und Datenbank bleiben erhalten. Dauert ca. 1-3 Minuten.
            </p>
            <div class="update-modal-footer">
              <button class="btn btn-secondary" @click="closeUpdateModal">Abbrechen</button>
              <button class="btn btn-primary update-btn" @click="beginUpdate">
                Jetzt aktualisieren
              </button>
            </div>
          </template>

          <template v-else-if="updateState === 'idle'">
            <p v-if="updateBlockedReason" class="update-error">{{ updateBlockedReason }}</p>
            <p class="text-secondary">
              Der One-Click-Updater braucht die <code>HOST_DATA_DIR</code>-Umgebungsvariable, um Status zwischen
              altem und neuem Container zu teilen. Setze sie in deinem Container-Template auf den Host-Pfad,
              den du auf <code>/app/data</code> mountest (z.B. <code>/mnt/user/appdata/dlvault</code> auf Unraid).
              Danach Container neu starten — der Button funktioniert dann.
            </p>
            <div class="update-modal-footer">
              <button class="btn btn-secondary" @click="closeUpdateModal">Schließen</button>
            </div>
          </template>

          <template v-else>
            <div class="phase-stepper">
              <div v-for="step in phaseSteps" :key="step.key"
                   class="phase-step"
                   :class="{
                     active: step.key === currentPhase,
                     done: phaseStepDone(step.key),
                     error: updateState === 'error' && step.key === currentPhase,
                   }">
                <span class="phase-dot"></span>
                <span class="phase-label">{{ step.label }}</span>
              </div>
            </div>

            <div class="update-log" ref="logBox">
              <div v-for="(line, i) in logLines" :key="i" class="log-line">{{ line }}</div>
              <div v-if="reconnecting" class="log-line reconnect">… Verbindung zum Container verloren — versuche erneut …</div>
            </div>

            <div v-if="updateState === 'error'" class="update-error">
              <p><strong>{{ errorHeadline }}</strong></p>
              <p v-if="errorAction" style="margin-top: 6px;">{{ errorAction }}</p>
              <p v-else style="margin-top: 6px;">Der laufende Container ist nicht betroffen.</p>
            </div>

            <div class="update-modal-footer">
              <button v-if="updateState === 'running'" class="btn btn-secondary" disabled>
                Bitte warten...
              </button>
              <button v-else-if="updateState === 'done'" class="btn btn-primary" @click="reloadPage">
                Seite neu laden
              </button>
              <button v-else class="btn btn-secondary" @click="closeUpdateModal">Schließen</button>
            </div>
          </template>
        </div>
      </div>
    </Transition>

    <div class="section-header">
      <h1>
        Dashboard
        <span v-if="versionLabel" class="version-badge" :title="commitHash ? `Build ${commitHash}` : versionLabel">{{ versionLabel }}</span>
      </h1>
      <div class="section-actions">
        <span v-if="lastSyncRelative" class="last-sync">Letzter Sync · {{ lastSyncRelative }}</span>
        <button class="btn btn-primary dash-sync" @click="triggerSync" :disabled="syncStore.syncing">
          <RefreshCw :size="14" />
          <span class="dash-sync-full">{{ syncStore.syncing ? 'Sync läuft...' : 'Jetzt synchronisieren' }}</span>
          <span class="dash-sync-short">{{ syncStore.syncing ? 'Läuft…' : 'Sync' }}</span>
        </button>
      </div>
    </div>

    <SkeletonLoader v-if="initialLoading" variant="stats" :count="3" />
    <template v-else>
      <HeroEmpty
        v-if="dashboardState === 'empty'"
        :watchlist-configured="watchlistConfigured"
        :jd-configured="jdConfigured"
        :media-server-configured="mediaServerConfigured"
      />
      <HeroReady
        v-else-if="dashboardState === 'ready'"
        :watchlist-provider="watchlistProvider"
        :jd-configured="jdConfigured"
        :media-server-configured="mediaServerConfigured"
        :syncing="syncStore.syncing"
        @sync="triggerSync"
      />
      <HeroActive
        v-else-if="dashboardState === 'active' && activePrimary"
        :primary="activePrimary"
        :up-next="upNext"
        :last-finished="lastFinished"
        :active-count="activeCount"
      />
      <HeroIdle
        v-else
        :library-count="syncStore.status.totalMovies"
        :library-total="syncStore.status.libraryTotal"
        :pending-count="syncStore.status.pending"
        :scheduler-running="syncStore.status.schedulerRunning"
        :last-sync-label="lastSyncRelative"
        :week-delta="weekDelta"
      />

      <RecentShelf :items="recentShelfItems" @open="openRecent" />

      <div class="two-col">
        <HealthCard
          v-if="health"
          :services="health.services"
          :plugins="health.plugins"
          :disk="health.disk"
        />
        <div v-else class="card health-skeleton"><LoadingSpinner /></div>
        <ActivityStream :logs="syncStore.logs" :sse-connected="sseConnected" />
      </div>

    </template>

    <!-- Manual intervention: titles whose releases all fail the quality filter.
         The per-title override (relax + re-search) is the one action that can
         actually resolve this bucket — surface it here instead of letting the
         titles rot silently in the queue. -->
    <div v-if="interventionItems.length > 0" class="card intervention-section">
      <div class="card-header">
        <h2>Manueller Eingriff <span class="badge badge-secondary">{{ interventionItems.length }}</span></h2>
        <RouterLink to="/movies" class="card-link">Zur Warteschlange</RouterLink>
      </div>
      <p class="intervention-hint">
        Releases gefunden, aber keins erfüllt die Qualitäts-Filter. „Filter lockern" lädt die beste verfügbare Version in gewünschter Sprache — Details &amp; weitere Optionen im Titel.
      </p>
      <div v-for="m in interventionItems" :key="m.id" class="intervention-item">
        <div class="intervention-info">
          <span class="intervention-title">{{ m.title }}<span v-if="m.year"> ({{ m.year }})</span></span>
          <span class="intervention-reason">Anforderungen nicht erfüllt{{ m.quality_override ? ' · Filter bereits gelockert' : '' }}</span>
        </div>
        <button class="intervention-action" :disabled="relaxing.has(m.id)" @click="relaxAndRetry(m)">
          Filter lockern + Neu suchen
        </button>
      </div>
    </div>

    <!-- Blocklist (kept from previous design — "rest unten bleibt gleich") -->
    <div v-if="blocklist.length > 0" class="card blocklist-section">
      <div class="card-header">
        <h2>Blocklist <span class="badge badge-secondary">{{ blocklist.length }}</span></h2>
        <button class="card-link card-link-btn" @click="showBlocklist = !showBlocklist">
          {{ showBlocklist ? 'Ausblenden' : 'Anzeigen' }}
        </button>
      </div>
      <Transition name="slide-down">
        <div v-if="showBlocklist">
          <div v-for="entry in blocklist" :key="entry.id" class="blocklist-item">
            <div class="blocklist-info">
              <span class="blocklist-release">{{ entry.release_name }}</span>
              <span v-if="entry.reason" class="blocklist-reason">{{ entry.reason }}</span>
            </div>
            <button class="btn btn-danger btn-sm" @click="removeBlocklistItem(entry.id)" title="Entfernen">&times;</button>
          </div>
        </div>
      </Transition>
    </div>

    <!-- Mediathek-Detailansicht für die "Kürzlich hinzugefügt"-Poster -->
    <DetailPanel
      :movie="panelMovie"
      :context="panelContext"
      @close="closePanel"
      @open-in-jellyfin="onOpenInMediaServer"
      @delete="onPanelDelete"
      @set-season-cutoff="onSetSeasonCutoff"
      @set-quality-override="onPanelQualityOverride"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, onBeforeUnmount, watch, nextTick } from 'vue';
import { useSyncStore } from '../stores/sync';
import { useMoviesStore } from '../stores/movies';
import { useDownloadsStore } from '../stores/downloads';
import { useToast, useConfirm } from '../composables/useApp';
import { useDetailPanel } from '../composables/useDetailPanel';
import { useDownloadPolling } from '../composables/useDownloadPolling';
import { sseConnected } from '../composables/useSSE';
import { timeAgo, formatSpeed, formatEta } from '../composables/useFormatters';
import {
  checkForUpdate, getHealthDetailed, getBlocklist, removeFromBlocklist,
  getUpdateState, startUpdate, updateStreamUrl, triggerJDUpdate,
  setQualityOverride, getLibrary, deleteLibraryItem, setSeasonCutoff,
} from '../api';
import type { Movie, LibraryItem } from '../types/index';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import LoadingSpinner from '../components/LoadingSpinner.vue';
import HeroActive from '../components/dashboard/HeroActive.vue';
import HeroIdle from '../components/dashboard/HeroIdle.vue';
import HeroEmpty from '../components/dashboard/HeroEmpty.vue';
import HeroReady from '../components/dashboard/HeroReady.vue';
import RecentShelf from '../components/dashboard/RecentShelf.vue';
import DetailPanel from '../components/DetailPanel.vue';
import ActivityStream from '../components/dashboard/ActivityStream.vue';
import HealthCard from '../components/dashboard/HealthCard.vue';
import { Package, RefreshCw, AlertTriangle, Download } from 'lucide-vue-next';

const syncStore = useSyncStore();
const moviesStore = useMoviesStore();
const downloadsStore = useDownloadsStore();
const toast = useToast();

useDownloadPolling();

// ── Health + Blocklist ──────────────────────────────────────
interface ServiceHealth { configured: boolean; connected: boolean; error?: string; updateAvailable?: boolean }
interface DiskInfo { path: string; totalGB?: number; freeGB?: number; usedPercent?: number; error?: string }
interface PluginHealth { id: string; name: string; ok: boolean; critical: boolean; detail?: string; error?: string }
const health = ref<{
  services: Record<string, ServiceHealth>;
  plugins?: PluginHealth[];
  disk: Record<string, DiskInfo>;
  database: { movies: number; downloads: number; blocklist: number };
} | null>(null);

const blocklist = ref<{ id: number; release_name: string; title: string | null; reason: string | null; created_at: string }[]>([]);
const showBlocklist = ref(false);

const initialLoading = computed(() => syncStore.loading);

// ── Dashboard state machine ─────────────────────────────────
// empty  → no watchlist source connected yet → setup hero
// ready  → watchlist connected but zero movies yet → "press the button" hero
// active → at least one JD package / movie is moving → download hero
// idle   → library has movies, nothing in motion → library hero
type DashboardState = 'empty' | 'ready' | 'active' | 'idle';
const dashboardState = computed<DashboardState>(() => {
  if (syncStore.status.totalMovies === 0) {
    return watchlistConfigured.value ? 'ready' : 'empty';
  }
  if (activeCount.value > 0) return 'active';
  return 'idle';
});

// Count of items in active stages — drives the hero state + the "1 von X aktiv" badge
const activeCount = computed(() => {
  const pkgs = downloadsStore.packages.filter(p => p.running && !p.finished).length;
  if (pkgs > 0) return pkgs;
  // Fallback: movies in DB with active status (JD store may not be loaded yet)
  return moviesStore.movies.filter(m => m.status === 'downloading' || m.status === 'searching').length;
});

// ── Active hero data ────────────────────────────────────────
function cleanReleaseName(name: string): string {
  // Strip year, quality tags, container, group tags — best-effort.
  // "The.Departed.2006.1080p.BluRay.x264-GROUP" → "The Departed"
  let s = name.replace(/\.(mkv|mp4|avi)$/i, '');
  s = s.replace(/[._]/g, ' ').trim();
  // Cut at year (4 digits 19xx-20xx)
  const yearMatch = s.match(/\s(19\d\d|20\d\d)\b/);
  if (yearMatch && yearMatch.index !== undefined) s = s.slice(0, yearMatch.index);
  return s.trim();
}

// Try to match a JD package back to a Movie row — if found we can show the real poster
function matchMovie(packageName: string) {
  const lc = packageName.toLowerCase();
  return moviesStore.movies.find(m => {
    if (m.status !== 'downloading' && m.status !== 'searching' && m.status !== 'found') return false;
    return lc.includes(m.title.toLowerCase());
  });
}

const activePrimary = computed(() => {
  // Prefer a running JD package — gives us speed/ETA/progress
  const pkg = downloadsStore.packages
    .filter(p => p.running && !p.finished && p.bytesTotal > 0)
    .sort((a, b) => (b.bytesLoaded / b.bytesTotal) - (a.bytesLoaded / a.bytesTotal))[0];

  if (pkg) {
    const m = matchMovie(pkg.name);
    const progress = pkg.bytesTotal > 0 ? Math.round((pkg.bytesLoaded / pkg.bytesTotal) * 100) : 0;
    return {
      imdbId: m?.imdb_id ?? null,
      title: m?.title ?? cleanReleaseName(pkg.name) ?? 'Download',
      year: m?.year,
      quality: undefined,
      progress,
      loadedGB: pkg.bytesLoaded / (1024 ** 3),
      totalGB: pkg.bytesTotal / (1024 ** 3),
      speed: pkg.speed > 0 ? formatSpeed(pkg.speed) : undefined,
      eta: pkg.eta > 0 ? formatEta(pkg.eta) : undefined,
    };
  }

  // Fallback: a Movie row in downloading state without a matched JD package.
  // Gate on the JD store having finished its initial load — otherwise a refresh
  // flashes the FIRST 'downloading' movie at 0% (often a stale/stuck row) for a
  // beat before the real running package arrives over SSE, then snaps to it.
  if (!downloadsStore.loading) {
    const dl = moviesStore.movies.find(m => m.status === 'downloading');
    if (dl) {
      return {
        imdbId: dl.imdb_id ?? null,
        title: dl.title,
        year: dl.year,
        quality: undefined,
        progress: 0,
      };
    }
  }
  return null;
});

const upNext = computed(() => {
  const skipTitle = activePrimary.value?.title?.toLowerCase();
  // Priority: extracting → searching → found → pending
  const priorities: Array<{ status: string; label: string }> = [
    { status: 'searching', label: 'sucht' },
    { status: 'found',     label: 'bereit' },
    { status: 'pending',   label: 'wartet' },
  ];
  for (const p of priorities) {
    const m = moviesStore.movies.find(m => m.status === p.status && m.title.toLowerCase() !== skipTitle);
    if (m) return { imdbId: m.imdb_id ?? null, title: m.title, year: m.year, statusLabel: p.label };
  }
  return null;
});

// "Landed in the library" timestamp for the recently-added shelf + last-finished
// hero. Prefer downloaded_at (real completion time, stable); fall back to added_at
// for rows downloaded before that column existed. Deliberately NOT last_checked_at:
// that moves every time the scheduler re-searches a show, which made finished
// shows (Scrubs, Wednesday) bubble back to the top of "recently added" on every
// sync even though nothing was added or downloaded.
function movieTs(m: { downloaded_at?: string | null; added_at?: string | null }): string {
  return m.downloaded_at || m.added_at || '';
}

const lastFinished = computed(() => {
  const done = moviesStore.movies
    .filter(m => m.status === 'downloaded')
    .sort((a, b) => movieTs(b).localeCompare(movieTs(a)))[0];
  if (!done) return null;
  return {
    imdbId: done.imdb_id ?? null,
    title: done.title,
    year: done.year,
    when: movieTs(done) ? timeAgo(movieTs(done)) : '',
  };
});

// ── Recent shelf items ──────────────────────────────────────
const recentShelfItems = computed(() => {
  return moviesStore.movies
    .filter(m => m.status === 'downloaded')
    .sort((a, b) => movieTs(b).localeCompare(movieTs(a)))
    .slice(0, 12)
    .map(m => ({
      id: m.id,
      imdbId: m.imdb_id ?? null,
      title: m.title,
      year: m.year,
      when: movieTs(m) ? timeAgo(movieTs(m)) : '',
    }));
});

// ── Recent-shelf detail panel (library context) ─────────────
// Die Shelf-Titel SIND Mediathek-Einträge — also dieselbe Detailansicht wie
// in der Mediathek: openFromLibraryItem mit dem gematchten Media-Server-Item
// (deepLink, Overview) + dem Queue-Movie für Metadaten/Seasons/Activity.
const { movie: panelMovie, context: panelContext, close: closePanel, openFromLibraryItem } = useDetailPanel();
const confirmModal = useConfirm();

// Library lazily geladen + gecached: erst beim ersten Klick, nicht bei jedem
// Dashboard-Mount einen Media-Server-Roundtrip.
const libraryItems = ref<LibraryItem[] | null>(null);
async function ensureLibrary(): Promise<LibraryItem[]> {
  if (libraryItems.value) return libraryItems.value;
  try {
    const res = await getLibrary();
    libraryItems.value = res.data.items || [];
  } catch {
    libraryItems.value = [];
  }
  return libraryItems.value!;
}

// Umkehrung von LibraryViews matchMovie(): Movie → LibraryItem.
function matchLibraryItem(m: Movie, items: LibraryItem[]): LibraryItem | null {
  if (m.imdb_id) {
    const byImdb = items.find(i => i.imdbId === m.imdb_id);
    if (byImdb) return byImdb;
  }
  return items.find(i => i.name === m.title && i.year === m.year)
    || items.find(i => i.name === m.title)
    || null;
}

async function openRecent(id: number) {
  const movie = moviesStore.movies.find(m => m.id === id);
  if (!movie) return;
  const items = await ensureLibrary();
  // Fallback-Item aus dem Movie, wenn der Media-Server den Titel (noch) nicht
  // listet — Panel öffnet trotzdem, nur ohne Direktlink/Overview.
  const item = matchLibraryItem(movie, items) ?? {
    id: String(movie.id),
    name: movie.title,
    year: movie.year,
    mediaType: (movie.media_type === 'show' ? 'show' : 'movie') as 'movie' | 'show',
    imdbId: movie.imdb_id ?? null,
  };
  openFromLibraryItem(item, movie);
}

function onOpenInMediaServer(pm: { deepLinkUrl?: string | null }) {
  if (pm.deepLinkUrl) {
    window.open(pm.deepLinkUrl, '_blank', 'noopener');
  } else {
    toast.value?.add('Direktlink zum Mediaserver ist nicht verfügbar', 'info');
  }
}

async function onPanelDelete(pm: { id: number | string }) {
  const item = (libraryItems.value || []).find(i => i.id === String(pm.id));
  if (!item) {
    toast.value?.add('Eintrag nicht in der Mediathek gefunden — bitte dort löschen', 'info');
    return;
  }
  const ok = await confirmModal.value?.show({
    title: 'Aus Bibliothek löschen',
    message: `"${item.name} (${item.year})" wirklich löschen? Die Dateien werden ebenfalls entfernt.`,
    confirmText: 'Löschen',
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteLibraryItem(item.id);
    libraryItems.value = (libraryItems.value || []).filter(i => i.id !== item.id);
    toast.value?.add('Erfolgreich gelöscht', 'success');
    closePanel();
  } catch {
    toast.value?.add('Löschen fehlgeschlagen', 'error');
  }
}

async function onSetSeasonCutoff(id: number | string, cutoff: number | null) {
  try {
    await setSeasonCutoff(Number(id), cutoff);
    toast.value?.add(cutoff == null ? 'Alle Staffeln werden geladen' : `Download ab Staffel ${cutoff}`, 'success');
  } catch {
    toast.value?.add('Staffel-Auswahl konnte nicht gespeichert werden', 'error');
  }
}

async function onPanelQualityOverride(id: number | string, mode: 'relaxed' | 'any' | null) {
  try {
    await setQualityOverride(Number(id), mode);
    toast.value?.add(
      mode == null ? 'Globaler Qualitätsfilter aktiv'
        : mode === 'relaxed' ? 'Filter gelockert — beste Version in gewünschter Sprache'
        : 'Filter aufgehoben — jedes Release wird akzeptiert',
      'success',
    );
  } catch {
    toast.value?.add('Filter-Auswahl konnte nicht gespeichert werden', 'error');
  }
}

// ── Mini stats helpers ──────────────────────────────────────
// "Diese Woche" comes straight from the server (counted over the full
// activity_log), NOT from syncStore.logs — that feed is capped at the last 20
// rows, which made the delta cap out far below reality.
const weekDelta = computed(() => {
  const d = syncStore.status.weekDelta;
  if (!d || (d.added === 0 && d.completed === 0)) return null;
  return d;
});

const lastSyncRelative = computed(() => {
  // Pick the most recent log entry — proxy for "last sync activity"
  const log = syncStore.logs[0];
  return log ? timeAgo(log.created_at) : null;
});

// ── Service config detection ────────────────────────────────
// Watchlist = either Trakt OR Plex (both can drive the watchlist sync).
// We prefer Trakt as label when both are configured because it's the canonical
// watchlist source; Plex is treated as fallback here.
const watchlistProvider = computed<'trakt' | 'plex' | null>(() => {
  const s = health.value?.services;
  if (!s) return null;
  if (s.trakt && s.trakt.configured) return 'trakt';
  if (s.plex && s.plex.configured)   return 'plex';
  return null;
});
const watchlistConfigured = computed(() => watchlistProvider.value !== null);
const jdConfigured = computed(() => !!health.value?.services?.jdownloader?.configured);
const jdConnected = computed(() => !!health.value?.services?.jdownloader?.connected);
// JD reachable-but-not-responding: surfaced as an actionable banner so the owner
// (or a non-technical friend) knows to start JD again. The watchdog auto-resumes
// downloads once it's back.
const jdOffline = computed(() => jdConfigured.value && !jdConnected.value);
// jdUpdateDismissed gives instant feedback the moment the user clicks "JD
// aktualisieren" — the backend also clears + suppresses its cached flag, but the
// 30s health cache + 5min monitor would otherwise let the banner linger.
const jdUpdateDismissed = ref(false);
const jdUpdateAvailable = computed(() =>
  jdConnected.value && !jdUpdateDismissed.value && !!health.value?.services?.jdownloader?.updateAvailable,
);
const jdUpdating = ref(false);
const mediaServerConfigured = computed(() => {
  const s = health.value?.services;
  return !!(s && ((s.jellyfin && s.jellyfin.configured) || (s.plex && s.plex.configured)));
});

// ── Update banner + modal state (preserved from previous DashboardView) ──
const updateAvailable = ref(false);
const showUpdateModal = ref(false);
const commitHash = ref<string>('');

const shortCommit = computed(() => {
  const hash = commitHash.value;
  if (!hash) return '';
  if (/^v\d/.test(hash)) return hash;
  return hash.slice(0, 7);
});

const appVersion = ref<string>('');

// Prefer the human-facing version ("v0.3.0") in the badge, with the exact build
// commit kept in the tooltip. Falls back to the short commit until the version
// arrives (or in dev where there's no published version).
const versionLabel = computed(() => (appVersion.value ? `v${appVersion.value}` : shortCommit.value));

type UpdateState = 'idle' | 'running' | 'done' | 'error';
const updateState = ref<UpdateState>('idle');
const currentPhase = ref<string>('');
const logLines = ref<string[]>([]);
const errorMessage = ref<string>('');
const reconnecting = ref(false);
const canStartUpdate = ref(false);
const updateBlockedReason = ref<string>('');
const logBox = ref<HTMLElement | null>(null);

const errorHeadline = computed(() => {
  switch (errorMessage.value) {
    case 'docker_socket_unreachable': return 'Docker-Socket nicht erreichbar';
    case 'host_data_dir_missing':     return 'HOST_DATA_DIR fehlt';
    case 'missing_confirm_header':    return 'Schutz vor versehentlichem Update';
    case 'start_failed':               return 'Update konnte nicht gestartet werden';
    case 'rollback':                   return 'Update fehlgeschlagen — Container zurückgerollt';
    case '':                            return 'Update fehlgeschlagen';
    default:                            return `Update fehlgeschlagen: ${errorMessage.value.replace(/_/g, ' ')}`;
  }
});

const errorAction = computed(() => {
  switch (errorMessage.value) {
    case 'docker_socket_unreachable':
      return 'Bitte /var/run/docker.sock als Bind-Mount in deinem Container-Template hinzufügen. Danach Container neu starten.';
    case 'host_data_dir_missing':
      return 'Setze die HOST_DATA_DIR-Umgebungsvariable auf den Host-Pfad, den du auf /app/data mountest.';
    case 'rollback':
      return 'Der vorherige Container wurde automatisch wiederhergestellt. Siehe Log oben für Details.';
    case 'missing_confirm_header':
      return 'Bitte den Update-Button erneut klicken.';
    default:
      return '';
  }
});

const phaseSteps = [
  { key: 'pulling',    label: 'Image laden' },
  { key: 'inspecting', label: 'Container prüfen' },
  { key: 'restarting', label: 'Container ersetzen' },
  { key: 'health',     label: 'Health-Check' },
  { key: 'done',       label: 'Fertig' },
] as const;
const phaseOrder = phaseSteps.map(s => s.key);

function phaseStepDone(key: string): boolean {
  const cur = phaseOrder.indexOf(currentPhase.value as typeof phaseOrder[number]);
  const idx = phaseOrder.indexOf(key as typeof phaseOrder[number]);
  if (cur < 0 || idx < 0) return false;
  if (updateState.value === 'done') return true;
  return idx < cur;
}

let eventSource: EventSource | null = null;
let reconnectTimer: number | null = null;

async function refreshUpdateBlockState() {
  try {
    const { data } = await getUpdateState();
    canStartUpdate.value = !!data.canStart;
    if (!data.hostPathsConfigured) {
      updateBlockedReason.value = 'HOST_DATA_DIR-Umgebungsvariable fehlt — bitte beim Container-Start setzen (siehe README).';
    } else if (data.socketReachable === false) {
      updateBlockedReason.value = '/var/run/docker.sock ist nicht in den Container gemountet — Bind-Mount im Container-Template hinzufügen.';
    } else if (data.running) {
      updateBlockedReason.value = 'Ein Update läuft bereits.';
      updateState.value = 'running';
      attachStream();
    } else {
      updateBlockedReason.value = '';
    }
  } catch {
    updateBlockedReason.value = 'Status nicht abrufbar.';
    canStartUpdate.value = false;
  }
}

function closeUpdateStream() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (reconnectTimer) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function attachStream() {
  closeUpdateStream();
  reconnecting.value = false;
  const src = new EventSource(updateStreamUrl());
  src.addEventListener('connected', () => { reconnecting.value = false; });
  src.addEventListener('phase', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { phase: string; line?: string };
      const ph = data.phase || '';
      if (ph.startsWith('error:')) {
        errorMessage.value = ph.slice('error:'.length).replace(/_/g, ' ');
        updateState.value = 'error';
        closeUpdateStream();
        return;
      }
      if (ph === 'done') {
        currentPhase.value = 'done';
        updateState.value = 'done';
        closeUpdateStream();
        return;
      }
      currentPhase.value = ph;
      if (data.line) appendLog(data.line);
    } catch { /* ignore */ }
  });
  src.addEventListener('log', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line: string };
      if (data.line) appendLog(data.line);
    } catch { /* ignore */ }
  });
  src.onerror = () => {
    if (updateState.value === 'running' || updateState.value === 'idle') {
      reconnecting.value = true;
      if (!reconnectTimer) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          if (updateState.value === 'running') attachStream();
        }, 2000);
      }
    }
  };
  eventSource = src;
}

function appendLog(line: string) {
  logLines.value.push(line);
  if (logLines.value.length > 200) {
    logLines.value.splice(0, logLines.value.length - 200);
  }
  nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  });
}

async function beginUpdate() {
  logLines.value = [];
  errorMessage.value = '';
  currentPhase.value = 'pulling';
  updateState.value = 'running';
  try {
    await startUpdate();
    attachStream();
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string; hint?: string } } };
    errorMessage.value = e.response?.data?.error || 'start_failed';
    if (e.response?.data?.hint) appendLog(e.response.data.hint);
    updateState.value = 'error';
  }
}

function closeUpdateModal() {
  if (updateState.value === 'running') {
    showUpdateModal.value = false;
    return;
  }
  closeUpdateStream();
  showUpdateModal.value = false;
  setTimeout(() => {
    if (!showUpdateModal.value) {
      updateState.value = 'idle';
      currentPhase.value = '';
      logLines.value = [];
      errorMessage.value = '';
    }
  }, 300);
}

function reloadPage() { window.location.reload(); }

watch(showUpdateModal, (open) => {
  if (open && updateState.value === 'idle') refreshUpdateBlockState();
});

onBeforeUnmount(closeUpdateStream);

// ── Sync action ─────────────────────────────────────────────
async function triggerSync() {
  const result = await syncStore.triggerSync();
  if (result.ok) {
    toast.value?.add('Sync gestartet!', 'success');
  } else {
    toast.value?.add(result.error || 'Sync fehlgeschlagen', 'error');
  }
}

// ── Data loading ────────────────────────────────────────────
async function loadHealth(force = false) {
  try {
    const res = await getHealthDetailed(force);
    health.value = res.data;
    // Once the backend confirms no JD update is pending, drop the local dismissal
    // so a genuinely new future update will show again.
    if (!res.data?.services?.jdownloader?.updateAvailable) jdUpdateDismissed.value = false;
  } catch { /* ignore */ }
}

async function triggerJdUpdate() {
  if (jdUpdating.value) return;
  jdUpdating.value = true;
  // Hide the banner immediately — don't make the user wait for the next poll.
  jdUpdateDismissed.value = true;
  try {
    await triggerJDUpdate();
    toast.value?.add('JDownloader wird aktualisiert und neu gestartet …', 'success');
    // JD drops offline for a minute or two during the restart — re-probe health
    // (force, skipping the 30s cache) once it's back so state stays in sync.
    setTimeout(() => { loadHealth(true); }, 8000);
  } catch (e: any) {
    jdUpdateDismissed.value = false; // request failed — let the banner come back
    toast.value?.add(e?.response?.data?.error || 'JD-Update fehlgeschlagen', 'error');
  } finally {
    jdUpdating.value = false;
  }
}

async function loadBlocklist() {
  try { const res = await getBlocklist(); blocklist.value = res.data; }
  catch { /* ignore */ }
}

// ── Manual intervention (quality_mismatch bucket) ───────────
const interventionItems = computed(() =>
  moviesStore.movies.filter(m => m.status === 'not_found' && m.not_found_reason === 'quality_mismatch')
);
const relaxing = ref<Set<number>>(new Set());

// Quick action: persist the 'relaxed' per-title override, then re-search. The
// detail panel offers the finer choices (reset / 'any' incl. foreign language).
async function relaxAndRetry(m: Movie) {
  relaxing.value.add(m.id);
  try {
    await setQualityOverride(m.id, 'relaxed');
    await moviesStore.retry(m.id);
    toast.value?.add(`${m.title}: Filter gelockert — neue Suche läuft`, 'success');
  } catch (e: any) {
    toast.value?.add(e?.response?.data?.message || 'Aktion fehlgeschlagen', 'error');
  } finally {
    relaxing.value.delete(m.id);
  }
}

async function removeBlocklistItem(id: number) {
  try {
    await removeFromBlocklist(id);
    blocklist.value = blocklist.value.filter(b => b.id !== id);
    toast.value?.add('Eintrag entfernt', 'success');
  } catch {
    toast.value?.add('Fehler beim Entfernen', 'error');
  }
}

onMounted(() => {
  syncStore.fetchAll();
  moviesStore.fetch();
  downloadsStore.fetch();
  loadHealth();
  loadBlocklist();

  checkForUpdate().then(({ data }) => {
    if (data.updateAvailable) updateAvailable.value = true;
    if (data.current && data.current !== 'dev') commitHash.value = data.current;
    if (data.version && data.version !== 'dev') appVersion.value = data.version;
  }).catch(() => {});

  getUpdateState().then(({ data }) => {
    if (data.running) {
      updateState.value = 'running';
      showUpdateModal.value = true;
      attachStream();
    }
  }).catch(() => {});
});
</script>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 4px;
  flex-wrap: wrap;
  gap: 12px;
}
.section-header h1 {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.02em;
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin: 0;
}
.section-header h1 .serif {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: var(--accent-2);
  letter-spacing: -0.01em;
}
.section-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.last-sync {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
.dash-sync-short { display: none; }
@media (max-width: 768px) {
  .section-actions { gap: 8px; row-gap: 6px; }
  /* Override the global `.section-header .btn-primary { flex: 1 }` — keep the
     sync button compact and right-aligned, not a full-width slab. */
  .section-actions .dash-sync { flex: 0 0 auto; margin-left: auto; }
  .dash-sync-full { display: none; }
  .dash-sync-short { display: inline; }
}

.version-badge {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--surface-2);
  border: 1px solid var(--line);
  padding: 2px 7px;
  border-radius: 999px;
  margin-left: 6px;
  letter-spacing: 0.02em;
}

.two-col {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
  gap: var(--gap-lg);
}
@media (max-width: 1100px) {
  .two-col { grid-template-columns: 1fr; }
}

.health-skeleton {
  display: grid;
  place-items: center;
  min-height: 200px;
}

/* Update banner */
.update-banner {
  background: linear-gradient(135deg, rgba(240, 107, 130, 0.15), rgba(93, 173, 226, 0.1));
  border: 1px solid var(--accent);
  color: var(--text-primary);
  padding: 14px 18px;
  border-radius: var(--r-md);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  font-size: var(--fs-sm);
}
.update-btn {
  background: var(--accent);
  color: white;
  font-weight: 600;
  padding: 6px 16px;
  white-space: nowrap;
}
.update-btn:hover { background: var(--accent-hover); }
.update-btn:disabled { opacity: 0.6; cursor: default; }

/* JDownloader status banners — same shape as the host-update banner, distinct tone. */
.jd-banner {
  padding: 14px 18px;
  border-radius: var(--r-md);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  font-size: var(--fs-sm);
  color: var(--text-primary);
}
.jd-banner span { display: inline-flex; align-items: center; gap: 8px; }
.jd-banner-warn {
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  border: 1px solid var(--warn);
}
.jd-banner-warn :deep(svg) { color: var(--warn); flex-shrink: 0; }
.jd-banner-info {
  background: color-mix(in srgb, var(--accent-2, var(--accent)) 12%, transparent);
  border: 1px solid var(--accent-2, var(--accent));
}
.jd-banner-info :deep(svg) { color: var(--accent-2, var(--accent)); flex-shrink: 0; }

/* Update modal */
.update-overlay {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.update-modal {
  background: var(--bg-card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 28px;
  max-width: 520px;
  width: calc(100% - 32px);
}
.update-modal h3 { font-size: 1.15rem; margin-bottom: 8px; }
.update-modal h3 code {
  background: rgba(255, 255, 255, 0.08);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.85em;
  color: var(--accent);
}
.update-steps {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: 16px;
}
.update-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
.update-error {
  background: rgba(231, 76, 60, 0.12);
  border: 1px solid rgba(231, 76, 60, 0.4);
  color: var(--text-primary);
  padding: 10px 12px;
  border-radius: 8px;
  font-size: var(--fs-sm);
  margin: 12px 0;
}
.phase-stepper {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 16px 0 12px;
  padding: 10px 0;
  font-size: var(--fs-xs);
}
.phase-step { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); opacity: 0.55; transition: all 0.2s; }
.phase-step.done { color: var(--ok); opacity: 1; }
.phase-step.active { color: var(--accent); opacity: 1; font-weight: 600; }
.phase-step.error { color: var(--err); opacity: 1; }
.phase-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.phase-step.active .phase-dot { animation: phase-pulse 1.2s ease-in-out infinite; }
@keyframes phase-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50%      { transform: scale(1.4); opacity: 0.6; }
}
.phase-label { white-space: nowrap; }
.update-log {
  background: var(--bg-primary);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 10px 12px;
  height: 180px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.45;
  color: var(--text-secondary);
  margin: 8px 0 4px;
}
.log-line { white-space: pre-wrap; word-break: break-all; }
.log-line.reconnect { color: var(--warn); font-style: italic; margin-top: 4px; }

/* Blocklist (legacy section kept) */
.blocklist-section { padding: 22px; }
.blocklist-section .card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.blocklist-section h2 { margin: 0; font-size: 16px; }
.card-link-btn {
  background: none;
  border: none;
  font-size: var(--fs-sm);
  color: var(--accent);
  cursor: pointer;
  font-weight: 500;
}
.intervention-section { padding: 22px; }
.intervention-section .card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.intervention-section h2 { margin: 0; font-size: 16px; }
.intervention-hint {
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin: 0 0 8px;
}
.intervention-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}
.intervention-item:last-child { border-bottom: none; }
.intervention-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.intervention-title {
  font-size: 0.8rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.intervention-reason { font-size: 0.7rem; color: var(--text-secondary); }
.intervention-action {
  flex-shrink: 0;
  padding: 5px 10px;
  background: var(--surface-3, transparent);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--accent);
  font-size: var(--fs-sm);
  font-weight: 500;
  cursor: pointer;
}
.intervention-action:hover:not(:disabled) { border-color: var(--accent); }
.intervention-action:disabled { opacity: 0.5; cursor: default; }

.blocklist-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}
.blocklist-item:last-child { border-bottom: none; }
.blocklist-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.blocklist-release {
  font-size: 0.8rem;
  font-weight: 500;
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.blocklist-reason { font-size: 0.7rem; color: var(--text-secondary); }

/* Animations */
.slide-down-enter-active, .slide-down-leave-active { transition: all 0.3s ease; }
.slide-down-enter-from, .slide-down-leave-to { opacity: 0; transform: translateY(-10px); }
.wizard-fade-enter-active { transition: opacity 0.2s ease; }
.wizard-fade-leave-active { transition: opacity 0.15s ease; }
.wizard-fade-enter-from, .wizard-fade-leave-to { opacity: 0; }

@media (max-width: 768px) {
  .section-header { flex-direction: column; align-items: stretch; }
  .section-header h1 { font-size: 22px; }
}
</style>
