<template>
  <div class="sx-shell">
    <SkeletonLoader v-if="settingsLoading" variant="table" :count="8" />

    <div v-else class="sx-grid">
      <!-- Settings sub-sidebar -->
      <aside class="sx-side">
        <div class="sx-side-header">
          <div class="sx-side-title">
            Einstellungen <span class="serif">verwalten</span>
          </div>
          <div class="sx-search">
            <Search :size="14" class="sx-search-icon" />
            <input
              type="text"
              placeholder="Suche…"
              v-model="query"
              aria-label="Einstellungen durchsuchen"
            />
          </div>
        </div>

        <div v-for="group in visibleGroups" :key="group.label" class="sx-group">
          <div class="sx-group-label">{{ group.label }}</div>
          <ul class="sx-tabs" role="tablist">
            <li v-for="tab in group.tabs" :key="tab.id">
              <button
                :class="['sx-tab', { active: activeTab === tab.id }]"
                role="tab"
                :aria-selected="activeTab === tab.id"
                @click="activeTab = tab.id"
              >
                <span class="icon"><component :is="tab.icon" :size="15" /></span>
                <span class="label">{{ tab.label }}</span>
              </button>
            </li>
          </ul>
        </div>
      </aside>

      <!-- Content -->
      <main class="sx-content">
        <header class="sx-content-header">
          <div>
            <div class="sx-breadcrumb">Einstellungen · {{ activeGroupLabel }}</div>
            <h1 class="sx-title">
              {{ activeTabLabel }} <span class="serif">konfigurieren</span>
            </h1>
            <p class="sx-subtitle">{{ tabSubtitle(activeTab) }}</p>
          </div>
          <button class="btn btn-ghost" type="button" @click="restartSetup">
            <Wand2 :size="14" />
            <span>Setup-Wizard</span>
          </button>
        </header>

        <SettingsWatchlist     v-if="activeTab === 'watchlist'" />
        <SettingsQuality       v-else-if="activeTab === 'quality'" />
        <SettingsKids          v-else-if="activeTab === 'kids'" />
        <SettingsPlugins       v-else-if="activeTab === 'plugins'" />
        <SettingsPluginSecrets v-else-if="activeTab === 'plugin-secrets'" />
        <SettingsMetadata      v-else-if="activeTab === 'metadata'" />
        <SettingsMediaServer   v-else-if="activeTab === 'media-server'" />
        <SettingsJDownloader   v-else-if="activeTab === 'jdownloader'" />
        <SettingsRename        v-else-if="activeTab === 'rename'" />
        <SettingsScheduler     v-else-if="activeTab === 'scheduler'" />
        <SettingsTelegram      v-else-if="activeTab === 'telegram'" />
        <SettingsBandwidth     v-else-if="activeTab === 'bandwidth'" />
        <SettingsBackup        v-else-if="activeTab === 'backup'" />

        <DisclaimerFooter />
      </main>
    </div>

    <SaveBar
      :changes="changeCount"
      :saving="saving"
      @save="saveAll"
      @discard="discardChanges"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, provide, inject, watch, type Ref, type Component } from 'vue';
import { getSettings, updateSettings, listPlugins } from '../api/index';
import type SetupWizard from '../components/SetupWizard.vue';
import { useToast } from '../composables/useApp';
import { SETTINGS_KEY, ERRORS_KEY, SAVE_KEY, RELOAD_KEY } from '../composables/useSettingsContext';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import SaveBar from '../components/settings/SaveBar.vue';
import SettingsWatchlist from '../components/settings/SettingsWatchlist.vue';
import SettingsQuality from '../components/settings/SettingsQuality.vue';
import SettingsPluginSecrets from '../components/settings/SettingsPluginSecrets.vue';
import SettingsMediaServer from '../components/settings/SettingsMediaServer.vue';
import SettingsJDownloader from '../components/settings/SettingsJDownloader.vue';
import SettingsRename from '../components/settings/SettingsRename.vue';
import SettingsScheduler from '../components/settings/SettingsScheduler.vue';
import SettingsTelegram from '../components/settings/SettingsTelegram.vue';
import SettingsMetadata from '../components/settings/SettingsMetadata.vue';
import SettingsKids from '../components/settings/SettingsKids.vue';
import SettingsBandwidth from '../components/settings/SettingsBandwidth.vue';
import SettingsBackup from '../components/settings/SettingsBackup.vue';
import SettingsPlugins from '../components/settings/SettingsPlugins.vue';
import DisclaimerFooter from '../components/DisclaimerFooter.vue';
import {
  ListChecks, Puzzle, ShieldCheck, Download, Activity, Type,
  Library, Sliders, Clock, Send, Save, Search, Wand2, Film, Baby,
} from 'lucide-vue-next';

interface TabDef {
  id: string;
  label: string;
  icon: Component;
  service?: 'trakt' | 'plex' | 'jdownloader' | 'jellyfin' | 'telegram';
}
interface GroupDef { label: string; tabs: TabDef[] }

// Four grouped sections — replaces the previous 11-flat-tab `allTabs`.
const SERVICE_GROUPS: GroupDef[] = [
  { label: 'Quellen', tabs: [
    { id: 'watchlist',      label: 'Watchlist',      icon: ListChecks,  service: 'trakt' },
    { id: 'plugins',        label: 'Plugins',        icon: Puzzle },
    { id: 'plugin-secrets', label: 'Plugin-Secrets', icon: ShieldCheck },
    { id: 'metadata',       label: 'Metadaten',      icon: Film },
  ]},
  { label: 'Downloads', tabs: [
    { id: 'jdownloader', label: 'JDownloader', icon: Download, service: 'jdownloader' },
    { id: 'bandwidth',   label: 'Bandbreite',  icon: Activity },
    { id: 'rename',      label: 'Umbenennen',  icon: Type },
  ]},
  { label: 'Mediathek', tabs: [
    { id: 'media-server', label: 'Media Server', icon: Library, service: 'jellyfin' },
    { id: 'quality',      label: 'Qualität',     icon: Sliders },
    { id: 'kids',         label: 'Kinder',       icon: Baby },
  ]},
  { label: 'Automation', tabs: [
    { id: 'scheduler', label: 'Scheduler', icon: Clock },
    { id: 'telegram',  label: 'Telegram',  icon: Send, service: 'telegram' },
    { id: 'backup',    label: 'Backup',    icon: Save },
  ]},
];

const STORAGE_KEY = 'dlvault-settings-tab';
const validTabIds = new Set(SERVICE_GROUPS.flatMap(g => g.tabs.map(t => t.id)));

const initialTab = (() => {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored && validTabIds.has(stored) ? stored : 'watchlist';
})();
const activeTab = ref(initialTab);
const query = ref('');

const toast = useToast();
const setupWizardRef = inject<Ref<InstanceType<typeof SetupWizard> | undefined>>('setupWizard');

// ── Settings state ──────────────────────────────────────────
const settings = ref<Record<string, string>>({});
const errors = ref<Record<string, string>>({});
const savedSettings = ref('');
const saving = ref(false);
const settingsLoading = ref(true);

// changeCount: per-key diff count rather than a boolean — drives the SaveBar
// badge ("3 ungespeicherte Änderungen").
const changeCount = computed(() => {
  if (!savedSettings.value) return 0;
  let saved: Record<string, string> = {};
  try { saved = JSON.parse(savedSettings.value); } catch { return 0; }
  let n = 0;
  const keys = new Set([...Object.keys(settings.value), ...Object.keys(saved)]);
  for (const k of keys) if (settings.value[k] !== saved[k]) n++;
  return n;
});
const hasUnsavedChanges = computed(() => changeCount.value > 0);

// ── Plugin-Secrets tab gating (unchanged from previous behavior) ──
const pluginsRequestSecrets = ref(false);
const hasStoredSecrets = computed(() =>
  Object.keys(settings.value).some(k => k.startsWith('secret-store.') && settings.value[k]),
);

const visibleGroups = computed<GroupDef[]>(() => {
  const q = query.value.trim().toLowerCase();
  const filterTab = (t: TabDef) => {
    // Hide plugin-secrets unless a plugin declares requiredSecrets or there
    // are legacy stored secrets.
    if (t.id === 'plugin-secrets' && !pluginsRequestSecrets.value && !hasStoredSecrets.value) {
      return false;
    }
    if (q && !t.label.toLowerCase().includes(q)) return false;
    return true;
  };
  return SERVICE_GROUPS
    .map(g => ({ ...g, tabs: g.tabs.filter(filterTab) }))
    .filter(g => g.tabs.length > 0);
});

const activeTabDef = computed<TabDef | null>(() => {
  for (const g of SERVICE_GROUPS) {
    const t = g.tabs.find(t => t.id === activeTab.value);
    if (t) return t;
  }
  return null;
});
const activeTabLabel = computed(() => activeTabDef.value?.label ?? 'Einstellungen');
const activeGroupLabel = computed(() => {
  for (const g of SERVICE_GROUPS) {
    if (g.tabs.some(t => t.id === activeTab.value)) return g.label;
  }
  return '';
});

// ── Subtitle per tab ────────────────────────────────────────
function tabSubtitle(id: string): string {
  switch (id) {
    case 'watchlist':      return 'Wähle deine Quelle (Trakt oder Plex) und wie häufig die Watchlist abgeglichen wird.';
    case 'plugins':        return 'Source-Plugins für tatsächliche Downloads. dlvault kommt ohne — du installierst, was zu deiner Welt passt.';
    case 'plugin-secrets': return 'API-Keys und Tokens, die deine Plugins benötigen. Werden verschlüsselt gespeichert.';
    case 'metadata':       return 'OMDb-API-Key für Film-Poster, Kalender-Releases und die Telegram-Filmsuche.';
    case 'jdownloader':    return 'Verbindung zu deinem MyJDownloader-Account und Captcha-Verhalten.';
    case 'bandwidth':      return 'Zeitabhängige Speed-Limits — z.B. nachts Vollgas, tagsüber gedrosselt.';
    case 'rename':         return 'Datei-Templates und Library-Struktur — wie dlvault Dateien beim Verschieben benennt.';
    case 'media-server':   return 'Plex oder Jellyfin als Library-Quelle. dlvault prüft hier, was du schon hast, um Duplikate zu vermeiden.';
    case 'quality':        return 'Qualitäts-Präferenzen pro Quelle und Profil — was bevorzugt geladen wird und was übersprungen.';
    case 'kids':           return 'Kinderfilme + -serien automatisch per Genre in eigene Verzeichnisse trennen.';
    case 'scheduler':      return 'Wann und wie oft dlvault deine Watchlist abgleicht — inklusive ruhiger Stunden für nachts.';
    case 'telegram':       return 'Optionaler Bot: Such-Befehle, Push-Notifications, Download-Trigger aus dem Chat.';
    case 'backup':         return 'SQLite-Snapshots auf einem Zeitplan — fürs Disaster-Recovery.';
    default:               return '';
  }
}

// ── API handlers (preserved from previous SettingsView) ─────
async function refreshPluginSecretNeed() {
  try {
    const res = await listPlugins();
    pluginsRequestSecrets.value = res.data.registered.some(
      p => p.enabled && (p.requiredSecrets?.length ?? 0) > 0,
    );
  } catch { /* leave previous */ }
}

async function loadSettings() {
  try {
    const res = await getSettings();
    settings.value = res.data;
    if (!settings.value['library.provider']) settings.value['library.provider'] = 'jellyfin';
    savedSettings.value = JSON.stringify(settings.value);
  } catch (e) {
    console.error('Failed to load settings', e);
  } finally {
    settingsLoading.value = false;
  }
}

async function saveAll() {
  if (Object.keys(errors.value).length > 0) {
    toast.value?.add('Bitte korrigiere die markierten Felder', 'warning');
    return;
  }
  saving.value = true;
  try {
    await updateSettings(settings.value);
    savedSettings.value = JSON.stringify(settings.value);
    toast.value?.add('Einstellungen gespeichert!', 'success');
    await loadSettings();
  } catch (e: unknown) {
    const axiosErr = e as { response?: { data?: { error?: string } } };
    toast.value?.add(axiosErr.response?.data?.error || 'Fehler beim Speichern', 'error');
  } finally {
    saving.value = false;
  }
}

function discardChanges() {
  if (!savedSettings.value) return;
  try { settings.value = JSON.parse(savedSettings.value); }
  catch { /* leave as-is */ }
}

function restartSetup() {
  setupWizardRef?.value?.open();
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (hasUnsavedChanges.value) e.preventDefault();
}

provide(SETTINGS_KEY, settings);
provide(ERRORS_KEY, errors);
provide(SAVE_KEY, saveAll);
provide(RELOAD_KEY, loadSettings);

onMounted(() => {
  loadSettings();
  refreshPluginSecretNeed();
  window.addEventListener('beforeunload', onBeforeUnload);
});

watch(activeTab, v => localStorage.setItem(STORAGE_KEY, v));

// If the active tab gets filtered out (search) or hidden (plugin-secrets), fall back.
watch(visibleGroups, (groups) => {
  const stillVisible = groups.some(g => g.tabs.some(t => t.id === activeTab.value));
  if (!stillVisible && groups[0]?.tabs[0]) {
    activeTab.value = groups[0].tabs[0].id;
  }
});

onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));
</script>

<style scoped>
.sx-shell { min-height: 100%; }

.sx-grid {
  display: grid;
  grid-template-columns: 260px 1fr;
  min-width: 0;
  align-items: start;
  /* Negative margin pulls the sub-sidebar tight against the main app sidebar,
     overriding the global .content { padding: 30px } that wraps router-view.
     The breakpoint values must match the responsive overrides in style.css. */
  margin: -30px -30px 0;
}

/* ───── Settings sub-sidebar ───── */
.sx-side {
  border-right: 1px solid var(--line);
  background: var(--surface);
  padding: 22px 0;
  position: sticky;
  top: 0;
  align-self: start;
  max-height: 100vh;
  overflow-y: auto;
}
.sx-side-header {
  padding: 0 20px 14px;
  border-bottom: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.sx-side-title {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.sx-side-title .serif {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: var(--accent-2);
  font-size: 14px;
}
.sx-search {
  position: relative;
  display: flex;
  align-items: center;
}
.sx-search input {
  width: 100%;
  padding: 8px 12px 8px 32px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.sx-search input::placeholder { color: var(--text-3); }
.sx-search input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.sx-search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-3);
  pointer-events: none;
}

.sx-group { margin-top: 16px; }
.sx-group-label {
  padding: 6px 22px 6px;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
}
.sx-tabs {
  list-style: none;
  padding: 2px 12px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
}
.sx-tab {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 8px 10px;
  border-radius: var(--r-sm);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13.5px;
  font-weight: 500;
  border: none;
  background: transparent;
  text-align: left;
  width: 100%;
  font-family: inherit;
  transition: background 0.15s, color 0.15s;
}
.sx-tab:hover { background: var(--surface-2); color: var(--text-primary); }
.sx-tab.active { color: var(--accent); background: var(--accent-soft); }
.sx-tab .icon { display: inline-flex; align-items: center; flex-shrink: 0; opacity: 0.85; }
.sx-tab.active .icon { opacity: 1; }
.sx-tab .label { flex: 1; }

/* ───── Content ───── */
.sx-content {
  padding: 28px 36px 96px;
  min-width: 0;
  max-width: 880px;
}
.sx-content-header {
  margin-bottom: 26px;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 24px;
  flex-wrap: wrap;
}
.sx-breadcrumb {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
  margin-bottom: 6px;
}
.sx-title {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.02em;
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 0;
}
.sx-title .serif {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: var(--accent-2);
  letter-spacing: -0.01em;
}
.sx-subtitle {
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 14px;
  max-width: 620px;
  line-height: 1.55;
}

@media (max-width: 1100px) {
  .sx-grid { grid-template-columns: 240px 1fr; margin: -24px -24px 0; }
}
@media (max-width: 900px) {
  .sx-grid {
    grid-template-columns: 1fr;
    margin: -16px -16px 0;
  }
  .sx-side {
    position: relative;
    max-height: none;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }
  .sx-content { padding: 20px 16px 120px; }
  .sx-title { font-size: 22px; }
}
@media (max-width: 768px) {
  .sx-grid { margin: -12px -12px 0; }
}
</style>
