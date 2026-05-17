<template>
  <div>
    <div class="section-header">
      <h2>Einstellungen</h2>
      <div class="flex-row">
        <button class="btn btn-secondary btn-sm" @click="restartSetup" aria-label="Setup-Wizard starten">Setup-Wizard</button>
        <span v-if="hasUnsavedChanges" class="unsaved-indicator">Ungespeicherte Änderungen</span>
        <button class="btn btn-primary" @click="saveAll" :disabled="saving || settingsLoading" aria-label="Einstellungen speichern">
          <LoadingSpinner v-if="saving" inline />
          {{ saving ? 'Speichern...' : 'Speichern' }}
        </button>
      </div>
    </div>

    <SkeletonLoader v-if="settingsLoading" variant="table" :count="8" />
    <div v-else class="settings-layout">
      <aside class="settings-tabs" role="tablist" aria-label="Einstellungen-Bereiche">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          :class="['settings-tab', { 'is-active': activeTab === tab.id }]"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :aria-controls="'settings-panel-' + tab.id"
          @click="activeTab = tab.id"
        >
          <span class="settings-tab-icon" aria-hidden="true">
            <component :is="tab.icon" :size="16" />
          </span>
          <span class="settings-tab-label">{{ tab.label }}</span>
        </button>
      </aside>

      <section class="settings-panel" role="tabpanel" :id="'settings-panel-' + activeTab" :aria-labelledby="activeTab">
        <SettingsWatchlist v-if="activeTab === 'watchlist'" />
        <SettingsQuality v-else-if="activeTab === 'quality'" />
        <SettingsPlugins v-else-if="activeTab === 'plugins'" />
        <SettingsPluginSecrets v-else-if="activeTab === 'plugin-secrets'" />
        <SettingsMediaServer v-else-if="activeTab === 'media-server'" />
        <SettingsJDownloader v-else-if="activeTab === 'jdownloader'" />
        <SettingsPaths v-else-if="activeTab === 'paths'" />
        <SettingsRename v-else-if="activeTab === 'rename'" />
        <SettingsScheduler v-else-if="activeTab === 'scheduler'" />
        <SettingsTelegram v-else-if="activeTab === 'telegram'" />
        <SettingsBandwidth v-else-if="activeTab === 'bandwidth'" />
        <SettingsBackup v-else-if="activeTab === 'backup'" />
      </section>
    </div>

    <DisclaimerFooter />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, provide, inject, type Ref, type Component } from 'vue';
import { getSettings, updateSettings, listPlugins } from '../api/index';
import type SetupWizard from '../components/SetupWizard.vue';
import { useToast } from '../composables/useApp';
import { SETTINGS_KEY, ERRORS_KEY, SAVE_KEY, RELOAD_KEY } from '../composables/useSettingsContext';
import LoadingSpinner from '../components/LoadingSpinner.vue';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import SettingsWatchlist from '../components/settings/SettingsWatchlist.vue';
import SettingsQuality from '../components/settings/SettingsQuality.vue';
import SettingsPluginSecrets from '../components/settings/SettingsPluginSecrets.vue';
import SettingsMediaServer from '../components/settings/SettingsMediaServer.vue';
import SettingsJDownloader from '../components/settings/SettingsJDownloader.vue';
import SettingsPaths from '../components/settings/SettingsPaths.vue';
import SettingsRename from '../components/settings/SettingsRename.vue';
import SettingsScheduler from '../components/settings/SettingsScheduler.vue';
import SettingsTelegram from '../components/settings/SettingsTelegram.vue';
import SettingsBandwidth from '../components/settings/SettingsBandwidth.vue';
import SettingsBackup from '../components/settings/SettingsBackup.vue';
import SettingsPlugins from '../components/settings/SettingsPlugins.vue';
import DisclaimerFooter from '../components/DisclaimerFooter.vue';
import {
  ListChecks, Sliders, ShieldCheck, Library, Download, FolderOpen,
  Type, Clock, Send, Activity, Save, Puzzle,
} from 'lucide-vue-next';

interface Tab { id: string; label: string; icon: Component }

// "Plugin-Secrets" tab is gated: only shown if any enabled plugin declares
// requiredSecrets in its manifest, or if the user already has some
// `secret-store.*` value saved (legacy / pre-clear state).
const pluginsRequestSecrets = ref(false);

const allTabs: Tab[] = [
  { id: 'watchlist', label: 'Watchlist', icon: ListChecks },
  { id: 'quality', label: 'Qualität', icon: Sliders },
  { id: 'plugins', label: 'Plugins', icon: Puzzle },
  { id: 'plugin-secrets', label: 'Plugin-Secrets', icon: ShieldCheck },
  { id: 'media-server', label: 'Mediathek', icon: Library },
  { id: 'jdownloader', label: 'JDownloader', icon: Download },
  { id: 'paths', label: 'Pfade', icon: FolderOpen },
  { id: 'rename', label: 'Umbenennen', icon: Type },
  { id: 'scheduler', label: 'Scheduler', icon: Clock },
  { id: 'telegram', label: 'Telegram', icon: Send },
  { id: 'bandwidth', label: 'Bandbreite', icon: Activity },
  { id: 'backup', label: 'Backup', icon: Save },
];

const STORAGE_KEY = 'dlvault-settings-tab';
const initial = (() => {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored && allTabs.some(t => t.id === stored) ? stored : 'watchlist';
})();
const activeTab = ref(initial);

const toast = useToast();
const setupWizardRef = inject<Ref<InstanceType<typeof SetupWizard> | undefined>>('setupWizard');

const settings = ref<Record<string, string>>({});
const errors = ref<Record<string, string>>({});
const savedSettings = ref('');
const saving = ref(false);
const settingsLoading = ref(true);

const hasUnsavedChanges = computed(() => JSON.stringify(settings.value) !== savedSettings.value);

const hasStoredSecrets = computed(() =>
  Object.keys(settings.value).some(k => k.startsWith('secret-store.') && settings.value[k]),
);

const tabs = computed<Tab[]>(() => {
  if (pluginsRequestSecrets.value || hasStoredSecrets.value) return allTabs;
  return allTabs.filter(t => t.id !== 'plugin-secrets');
});

async function refreshPluginSecretNeed() {
  try {
    const res = await listPlugins();
    pluginsRequestSecrets.value = res.data.registered.some(
      p => p.enabled && (p.requiredSecrets?.length ?? 0) > 0,
    );
  } catch {
    // If we can't tell, leave the previous value alone — better to keep an
    // already-visible tab than to flicker it away on a transient API hiccup.
  }
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

function restartSetup() {
  setupWizardRef?.value?.open();
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (hasUnsavedChanges.value) {
    e.preventDefault();
  }
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

// Persist tab choice
import { watch } from 'vue';
watch(activeTab, v => localStorage.setItem(STORAGE_KEY, v));

// If the plugin-secrets tab gets hidden while the user is on it, fall back to watchlist.
watch(tabs, (newTabs) => {
  if (!newTabs.some(t => t.id === activeTab.value)) {
    activeTab.value = 'watchlist';
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
});
</script>

<style scoped>
.unsaved-indicator {
  color: var(--warn);
  font-size: 0.85rem;
  font-weight: 500;
  animation: pulse-text 2s ease-in-out infinite;
}

@keyframes pulse-text {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.settings-layout {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 24px;
  align-items: start;
}

.settings-tabs {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  position: sticky;
  top: 16px;
}

.settings-tab {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  background: none;
  border: none;
  border-radius: var(--r-sm);
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background var(--duration-fast), color var(--duration-fast);
}

.settings-tab:hover {
  background: var(--surface-2);
  color: var(--text-primary);
}

.settings-tab.is-active {
  background: var(--accent-soft);
  color: var(--accent);
}

.settings-tab-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--text-3);
}

.settings-tab:hover .settings-tab-icon {
  color: var(--text-secondary);
}

.settings-tab.is-active .settings-tab-icon {
  color: var(--accent);
}

.settings-tab-label {
  flex: 1;
}

.settings-panel {
  min-width: 0;
}

/* Mobile: horizontal scroll tab bar */
@media (max-width: 768px) {
  .settings-layout {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .settings-tabs {
    position: static;
    flex-direction: row;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 6px;
    gap: 4px;
  }

  .settings-tabs::-webkit-scrollbar {
    display: none;
  }

  .settings-tab {
    flex-shrink: 0;
    white-space: nowrap;
    min-height: 40px;
  }
}
</style>
