<template>
  <ConnectionHero
    v-if="isJellyfin"
    name="Jellyfin"
    mark="JF"
    mark-color="#aa5cc3"
    :tint="jfTint"
    :pill-state="jfPillState"
    :pill-label="jfPillLabel"
    :meta="jfMeta"
    :open-url="settings['jellyfin.url']"
    testable
    @test="testJellyfinConnection"
  />
  <ConnectionHero
    v-else
    name="Plex"
    mark="PX"
    mark-color="#e5a00d"
    :tint="plexTint"
    :pill-state="plexPillState"
    :pill-label="plexPillLabel"
    :meta="plexMeta"
    :open-url="settings['plex.server_url']"
    testable
    @test="testPlexLibraryConnection"
  />

  <SettingsSection label="Media-Server">
    <SettingsRow
      label="Provider"
      hint="dlvault prüft hier nur, was du schon hast — um Duplikate zu vermeiden."
    >
      <Segments
        :model-value="settings['library.provider'] || 'jellyfin'"
        @update:model-value="settings['library.provider'] = $event"
        :options="[
          { value: 'jellyfin', label: 'Jellyfin' },
          { value: 'plex',     label: 'Plex' },
        ]"
      />
    </SettingsRow>
  </SettingsSection>

  <SettingsSection v-if="isJellyfin" label="Jellyfin Authentication">
    <SettingsRow
      label="Server URL"
      required
      hint="z.B. <code>http://192.168.1.100:8096</code>"
      :error="errors['jellyfin.url']"
    >
      <input
        class="sx-input mono"
        type="text"
        placeholder="http://192.168.1.100:8096"
        v-model="settings['jellyfin.url']"
        @blur="validateUrl('jellyfin.url')"
        :class="{ error: errors['jellyfin.url'] }"
      />
    </SettingsRow>
    <SettingsRow
      label="API Key"
      required
      hint="Jellyfin Dashboard → API-Schlüssel erstellen."
    >
      <input
        class="sx-input mono"
        type="password"
        placeholder="API Key"
        v-model="settings['jellyfin.api_key']"
      />
    </SettingsRow>
  </SettingsSection>

  <SettingsSection v-else label="Plex Server Authentication">
    <div class="info-note">
      Token findest du unter <a href="https://www.plex.tv/claim/" target="_blank" rel="noopener">plex.tv/claim</a>
      oder in den XML-Einstellungen deines Servers.
    </div>
    <SettingsRow
      label="Server URL"
      required
      hint="z.B. <code>http://192.168.1.100:32400</code>"
      :error="errors['plex.server_url']"
    >
      <input
        class="sx-input mono"
        type="text"
        placeholder="http://192.168.1.100:32400"
        v-model="settings['plex.server_url']"
        @blur="validateUrl('plex.server_url')"
        :class="{ error: errors['plex.server_url'] }"
      />
    </SettingsRow>
    <SettingsRow
      label="Plex Token"
      required
      hint="Wird verschlüsselt gespeichert."
    >
      <input
        class="sx-input mono"
        type="password"
        placeholder="Plex Token"
        v-model="settings['plex.token']"
      />
    </SettingsRow>
  </SettingsSection>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { getJellyfinStatus, testJellyfin, getPlexLibraryStatus, testPlexLibrary } from '../../api/index';
import type { ServiceStatus } from '../../types/index';
import { useSettingsContext } from '../../composables/useSettingsContext';
import { useToast } from '../../composables/useApp';
import ConnectionHero from './ConnectionHero.vue';
import SettingsSection from './SettingsSection.vue';
import SettingsRow from './SettingsRow.vue';
import Segments from './Segments.vue';

const { settings, errors, saveAll, validateUrl } = useSettingsContext();
const toast = useToast();

const jellyfinStatus = ref<ServiceStatus>({ connected: false, serverName: '', movieCount: 0 });
const plexLibraryStatus = ref<ServiceStatus>({ connected: false, serverName: '', movieCount: 0 });
const jfTesting = ref(false);
const plexTesting = ref(false);

const isJellyfin = computed(() => settings.value['library.provider'] !== 'plex');

// ── Jellyfin hero state ────────────────────────────────────
const jfPillState = computed<'ok' | 'err' | 'na' | 'testing'>(() => {
  if (jfTesting.value) return 'testing';
  if (jellyfinStatus.value.connected) return 'ok';
  if (settings.value['jellyfin.url']) return 'err';
  return 'na';
});
const jfPillLabel = computed(() => {
  if (jfTesting.value) return 'Teste…';
  if (jellyfinStatus.value.connected) return 'Verbunden';
  if (settings.value['jellyfin.url']) return 'Nicht verbunden';
  return 'Nicht konfiguriert';
});
const jfTint = computed(() => {
  if (jfTesting.value) return 'var(--info)';
  if (jellyfinStatus.value.connected) return 'var(--ok)';
  if (settings.value['jellyfin.url']) return 'var(--err)';
  return 'var(--text-3)';
});
const jfMeta = computed(() => {
  const out: { lbl: string; val: string }[] = [];
  if (jellyfinStatus.value.serverName) out.push({ lbl: 'Server', val: jellyfinStatus.value.serverName });
  if (jellyfinStatus.value.movieCount) out.push({ lbl: 'Filme', val: String(jellyfinStatus.value.movieCount) });
  return out;
});

// ── Plex hero state ────────────────────────────────────────
const plexPillState = computed<'ok' | 'err' | 'na' | 'testing'>(() => {
  if (plexTesting.value) return 'testing';
  if (plexLibraryStatus.value.connected) return 'ok';
  if (settings.value['plex.server_url']) return 'err';
  return 'na';
});
const plexPillLabel = computed(() => {
  if (plexTesting.value) return 'Teste…';
  if (plexLibraryStatus.value.connected) return 'Verbunden';
  if (settings.value['plex.server_url']) return 'Nicht verbunden';
  return 'Nicht konfiguriert';
});
const plexTint = computed(() => {
  if (plexTesting.value) return 'var(--info)';
  if (plexLibraryStatus.value.connected) return 'var(--ok)';
  if (settings.value['plex.server_url']) return 'var(--err)';
  return 'var(--text-3)';
});
const plexMeta = computed(() => {
  const out: { lbl: string; val: string }[] = [];
  if (plexLibraryStatus.value.serverName) out.push({ lbl: 'Server', val: plexLibraryStatus.value.serverName });
  if (plexLibraryStatus.value.movieCount) out.push({ lbl: 'Filme', val: String(plexLibraryStatus.value.movieCount) });
  return out;
});

async function testJellyfinConnection() {
  jfTesting.value = true;
  await saveAll();
  try {
    const res = await testJellyfin();
    if (res.data.success) {
      jellyfinStatus.value = {
        connected: true,
        serverName: res.data.serverName || 'Jellyfin',
        movieCount: res.data.movieCount || 0,
      };
      toast.value?.add(`Jellyfin verbunden! ${res.data.movieCount} Filme gefunden.`, 'success');
    }
  } catch (e: unknown) {
    jellyfinStatus.value = { connected: false, serverName: '', movieCount: 0 };
    const axiosErr = e as { response?: { data?: { error?: string } } };
    toast.value?.add(axiosErr.response?.data?.error || 'Jellyfin Verbindung fehlgeschlagen', 'error');
  } finally {
    jfTesting.value = false;
  }
}

async function testPlexLibraryConnection() {
  plexTesting.value = true;
  await saveAll();
  try {
    const res = await testPlexLibrary();
    if (res.data.success) {
      plexLibraryStatus.value = {
        connected: true,
        serverName: res.data.serverName || 'Plex',
        movieCount: res.data.movieCount || 0,
      };
      toast.value?.add(`Plex Server verbunden! ${res.data.movieCount} Filme gefunden.`, 'success');
    }
  } catch (e: unknown) {
    plexLibraryStatus.value = { connected: false, serverName: '', movieCount: 0 };
    const axiosErr = e as { response?: { data?: { error?: string } } };
    toast.value?.add(axiosErr.response?.data?.error || 'Plex Server Verbindung fehlgeschlagen', 'error');
  } finally {
    plexTesting.value = false;
  }
}

onMounted(async () => {
  const [jfRes, plexLibRes] = await Promise.all([
    getJellyfinStatus().catch(() => ({ data: { connected: false, serverName: '', movieCount: 0 } })),
    getPlexLibraryStatus().catch(() => ({ data: { connected: false, serverName: '', movieCount: 0 } })),
  ]);
  jellyfinStatus.value = jfRes.data;
  plexLibraryStatus.value = plexLibRes.data;
});
</script>

<style scoped>
.info-note {
  font-size: 12.5px;
  color: var(--text-secondary);
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 10px 14px;
  margin-bottom: 12px;
  line-height: 1.55;
}
.info-note a { color: var(--accent); text-decoration: none; }
.info-note a:hover { text-decoration: underline; }
</style>
