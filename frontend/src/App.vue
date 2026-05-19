<template>
  <div class="app">
    <a href="#main-content" class="skip-link">Zum Inhalt springen</a>
    <Transition name="slide-down">
      <div v-if="!serverReachable" class="connection-banner" role="alert">
        <span><AlertTriangle :size="14" /> Server nicht erreichbar</span>
      </div>
    </Transition>
    <nav class="sidebar" aria-label="Hauptnavigation">
      <div class="logo">
        <div class="brand">
          <img class="brand-mark" src="/icon-192.png" alt="dlvault" aria-hidden="true" />
          <span class="brand-name">dlvault</span>
          <span class="brand-status" :class="sseConnected ? 'is-live' : 'is-offline'">
            <span class="brand-status-dot"></span>{{ sseConnected ? 'Live' : 'Offline' }}
          </span>
        </div>
      </div>

      <div class="nav-section-label nav-desktop-only">Übersicht</div>
      <ul class="nav-links">
        <li>
          <router-link to="/" exact-active-class="active" aria-label="Dashboard">
            <span class="icon" aria-hidden="true"><LayoutDashboard /></span>
            <span class="nav-label">Dashboard</span>
          </router-link>
        </li>
        <li>
          <router-link to="/movies" active-class="active" aria-label="Warteschlange">
            <span class="icon" aria-hidden="true"><ListVideo /></span>
            <span class="nav-label"><span class="nav-full">Warteschlange</span><span class="nav-short">Queue</span></span>
            <span v-if="queueCount > 0" class="nav-count">{{ queueCount }}</span>
          </router-link>
        </li>
        <li>
          <router-link to="/library" active-class="active" aria-label="Mediathek">
            <span class="icon" aria-hidden="true"><Library /></span>
            <span class="nav-label">Mediathek</span>
            <span v-if="libraryCount > 0" class="nav-count">{{ libraryDisplay }}</span>
          </router-link>
        </li>
        <li>
          <router-link to="/downloads" active-class="active" aria-label="Downloads">
            <span class="icon" aria-hidden="true"><Download /></span>
            <span class="nav-label">Downloads</span>
            <span v-if="downloadingCount > 0" class="nav-count">{{ downloadingCount }}</span>
          </router-link>
        </li>

        <li class="nav-mobile-only">
          <button class="nav-more-btn" :class="{ active: moreMenuOpen || isMoreRoute }" @click="moreMenuOpen = !moreMenuOpen" aria-label="Mehr">
            <span class="icon" aria-hidden="true"><MoreHorizontal /></span>
            <span class="nav-label">Mehr</span>
          </button>
        </li>
      </ul>

      <div class="nav-section-label nav-desktop-only">Mehr</div>
      <ul class="nav-links nav-desktop-only">
        <li>
          <router-link to="/settings" active-class="active" aria-label="Einstellungen">
            <span class="icon" aria-hidden="true"><Settings /></span>
            <span class="nav-label">Einstellungen</span>
          </router-link>
        </li>
        <li>
          <router-link to="/logs" active-class="active" aria-label="Logs">
            <span class="icon" aria-hidden="true"><FileText /></span>
            <span class="nav-label">Logs</span>
          </router-link>
        </li>
      </ul>

      <div class="sidebar-footer">
        <button class="sidebar-search" @click="commandPalette?.toggle()" :title="'Suche (' + shortcutHint + ')'">
          <Search :size="14" class="sidebar-search-icon" />
          <span class="sidebar-search-label">Suche oder springe…</span>
          <kbd class="sidebar-search-kbd">{{ shortcutHint }}</kbd>
        </button>
        <div v-if="healthSummary.length > 0" class="health-strip" role="status" aria-label="Service-Status">
          <span
            v-for="svc in healthSummary"
            :key="svc.key"
            class="health-strip-dot"
            :class="'health-' + svc.tone"
            :title="svc.label + ' · ' + svc.statusText"
          ></span>
          <span class="health-strip-label">Dienste</span>
        </div>
      </div>
    </nav>

    <!-- Mobile "Mehr" overlay -->
    <Transition name="more-menu">
      <div v-if="moreMenuOpen" class="more-overlay" @click="moreMenuOpen = false">
        <div class="more-sheet" @click.stop>
          <div class="more-handle"></div>
          <router-link to="/settings" class="more-item" @click="moreMenuOpen = false">
            <span class="more-icon"><Settings :size="20" /></span> Einstellungen
          </router-link>
          <router-link to="/logs" class="more-item" @click="moreMenuOpen = false">
            <span class="more-icon"><FileText :size="20" /></span> Logs
          </router-link>
        </div>
      </div>
    </Transition>
    <main id="main-content" class="content">
      <router-view v-slot="{ Component }">
        <transition name="page" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
    <ToastContainer ref="toast" />
    <ConfirmModal ref="confirmModal" />
    <CommandPalette ref="commandPalette" />
    <InstallBanner />
    <ScrollTop />
    <SetupWizard ref="setupWizard" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, provide, defineAsyncComponent, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import {
  LayoutDashboard, ListVideo, Library, Download,
  Settings, FileText, MoreHorizontal, Search, AlertTriangle,
} from 'lucide-vue-next';
import ToastContainer from './components/ToastContainer.vue';
import ConfirmModal from './components/ConfirmModal.vue';
import CommandPalette from './components/CommandPalette.vue';
import InstallBanner from './components/InstallBanner.vue';
import ScrollTop from './components/ScrollTop.vue';
import type SetupWizardCmp from './components/SetupWizard.vue';
const SetupWizard = defineAsyncComponent(() => import('./components/SetupWizard.vue'));
import { useSSE, sseConnected } from './composables/useSSE';
import { serverReachable, getHealthDetailed } from './api/index';
import { useSyncStore } from './stores/sync';

// Global SSE connection — stays alive while app is mounted
useSSE();

const route = useRoute();
const syncStore = useSyncStore();
const toast = ref<InstanceType<typeof ToastContainer>>();
const confirmModal = ref<InstanceType<typeof ConfirmModal>>();
const commandPalette = ref<InstanceType<typeof CommandPalette>>();
const setupWizard = ref<InstanceType<typeof SetupWizardCmp>>();
const moreMenuOpen = ref(false);
const isMoreRoute = computed(() => ['/settings', '/logs'].includes(route.path));

// Sidebar count badges — derived from sync store
const queueCount = computed(() => (syncStore.status.pending || 0) + (syncStore.status.searching || 0));
const libraryCount = computed(() => syncStore.status.downloaded || 0);
const downloadingCount = computed(() => syncStore.status.downloading || 0);
const libraryDisplay = computed(() => {
  const n = libraryCount.value;
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.0', '') + 'k';
  return String(n);
});

// Cmd/Ctrl-K hint based on platform
const shortcutHint = computed(() => {
  if (typeof navigator === 'undefined') return '⌘K';
  return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K';
});

// Health strip — 4 mini service dots in sidebar footer
interface HealthSummaryItem { key: string; label: string; tone: 'ok' | 'err' | 'na'; statusText: string }
const healthSummary = ref<HealthSummaryItem[]>([]);
const SERVICE_LABELS: Record<string, string> = {
  jdownloader: 'JDownloader', trakt: 'Trakt', telegram: 'Telegram',
  jellyfin: 'Jellyfin', plex: 'Plex',
};
const SERVICE_ORDER = ['jdownloader', 'trakt', 'telegram', 'jellyfin', 'plex'];
let healthTimer: number | undefined;
async function fetchHealth() {
  try {
    const res = await getHealthDetailed();
    const services = res.data?.services || {};
    healthSummary.value = SERVICE_ORDER
      .filter(k => services[k] !== undefined)
      .map(k => {
        const info = services[k];
        let tone: 'ok' | 'err' | 'na' = 'na';
        let statusText = 'Nicht konfiguriert';
        if (info.configured) {
          tone = info.connected ? 'ok' : 'err';
          statusText = info.connected ? 'OK' : 'Fehler';
        }
        return { key: k, label: SERVICE_LABELS[k] || k, tone, statusText };
      });
  } catch { /* ignore */ }
}

provide('toast', toast);
provide('confirm', confirmModal);
provide('commandPalette', commandPalette);
provide('setupWizard', setupWizard);

onMounted(() => {
  // Pull status numbers for sidebar counters
  if (!syncStore.status.totalMovies && !syncStore.loading) {
    syncStore.fetchStatus();
  }
  fetchHealth();
  healthTimer = window.setInterval(fetchHealth, 60_000);

  // PWA app-shortcut handler — manifest.shortcuts dispatch to /?action=sync etc.
  if (route.query.action === 'sync' && !syncStore.syncing) {
    syncStore.triggerSync().then(res => {
      if (res.ok) toast.value?.add('Sync gestartet!', 'success');
      else toast.value?.add(res.error || 'Sync fehlgeschlagen', 'error');
    });
  }
});

onBeforeUnmount(() => {
  if (healthTimer !== undefined) window.clearInterval(healthTimer);
});
</script>

<style scoped>
.connection-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9998;
  background: var(--err);
  color: white;
  text-align: center;
  padding: 8px 16px;
  font-size: 0.85rem;
  font-weight: 600;
}

.connection-banner span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.slide-down-enter-active { transition: transform 0.3s ease, opacity 0.3s ease; }
.slide-down-leave-active { transition: transform 0.2s ease, opacity 0.2s ease; }
.slide-down-enter-from { transform: translateY(-100%); opacity: 0; }
.slide-down-leave-to { transform: translateY(-100%); opacity: 0; }

/* Brand block in sidebar */
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-mark {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  flex-shrink: 0;
  object-fit: contain;
}

.brand-name {
  font-weight: 600;
  letter-spacing: -0.01em;
  font-size: 15px;
}

.brand-status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-3);
}

.brand-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.brand-status.is-live .brand-status-dot {
  background: var(--ok);
  box-shadow: 0 0 6px var(--ok);
}

.brand-status.is-offline .brand-status-dot {
  background: var(--err);
  animation: pulse-dot 1.5s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* Sidebar footer: search trigger + health strip */
.sidebar-footer {
  margin-top: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sidebar-search {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--text-3);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}

.sidebar-search:hover {
  border-color: var(--line-2);
  background: var(--surface-3);
  color: var(--text-secondary);
}

.sidebar-search:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.sidebar-search-icon {
  flex-shrink: 0;
  color: var(--text-3);
}

.sidebar-search-label {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar-search-kbd {
  background: var(--surface-3);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  color: var(--text-secondary);
  border: 1px solid var(--line-2);
  flex-shrink: 0;
}

/* Health live strip — compact dot row */
.health-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  border: 1px solid var(--line);
}

.health-strip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-3);
  opacity: 0.4;
}

.health-strip-dot.health-ok {
  background: var(--ok);
  opacity: 1;
  box-shadow: 0 0 4px var(--ok);
}

.health-strip-dot.health-err {
  background: var(--err);
  opacity: 1;
  animation: pulse-dot 1.5s ease-in-out infinite;
}

.health-strip-label {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

/* Desktop visibility helpers */
.nav-mobile-only { display: none; }
.nav-short { display: none; }

@media (max-width: 768px) {
  .sidebar-footer,
  .nav-section-label,
  .nav-desktop-only {
    display: none;
  }

  .nav-full { display: none; }
  .nav-short { display: inline; }

  .nav-mobile-only {
    display: block;
  }

  /* Mobile "Mehr" button */
  .nav-more-btn {
    display: flex;
    align-items: center;
    gap: 2px;
    white-space: nowrap;
    padding: 6px 4px 4px;
    font-size: 0.7rem;
    flex-direction: column;
    text-align: center;
    justify-content: center;
    min-height: 56px;
    width: 100%;
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), color var(--duration-fast);
    letter-spacing: 0.01em;
  }

  .nav-more-btn:hover,
  .nav-more-btn.active {
    color: var(--accent);
  }

  .nav-more-btn.active .icon {
    transform: scale(1.12);
  }
}

/* Mobile "Mehr" bottom sheet */
.more-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  z-index: 99;
  display: flex;
  align-items: flex-end;
}

.more-sheet {
  width: 100%;
  background: rgba(19, 20, 24, 0.92);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  border-radius: var(--r-xl) var(--r-xl) 0 0;
  padding: 6px 0 calc(72px + env(safe-area-inset-bottom, 0px));
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.5);
}

.more-handle {
  width: 40px;
  height: 5px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  margin: 8px auto 16px;
}

.more-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 28px;
  color: var(--text-primary);
  text-decoration: none;
  font-size: 1.05rem;
  font-weight: 500;
  transition: background var(--duration-fast);
  min-height: 56px;
}

.more-item:active {
  background: rgba(240, 107, 130, 0.12);
}

.more-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  color: var(--text-secondary);
}

.more-item.router-link-active {
  color: var(--accent);
}

.more-item.router-link-active .more-icon {
  color: var(--accent);
}

/* More-menu transitions */
.more-menu-enter-active { transition: opacity 0.2s ease; }
.more-menu-leave-active { transition: opacity 0.15s ease; }
.more-menu-enter-from { opacity: 0; }
.more-menu-leave-to { opacity: 0; }

.more-menu-enter-active .more-sheet {
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.more-menu-leave-active .more-sheet {
  transition: transform 0.15s ease;
}
.more-menu-enter-from .more-sheet {
  transform: translateY(100%);
}
.more-menu-leave-to .more-sheet {
  transform: translateY(100%);
}

/* Hide more overlay on desktop */
@media (min-width: 769px) {
  .more-overlay {
    display: none;
  }
}
</style>
