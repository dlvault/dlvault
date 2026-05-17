<template>
  <details class="card settings-section" open>
    <summary class="card-toggle"><h2>Mediathek-Server</h2></summary>
    <p class="section-hint">
      Filme die bereits in deiner Bibliothek sind werden automatisch übersprungen.
    </p>
    <div class="form-grid">
      <div class="form-group">
        <label for="library-provider">Media Server</label>
        <select id="library-provider" v-model="settings['library.provider']">
          <option value="jellyfin">Jellyfin</option>
          <option value="plex">Plex</option>
        </select>
      </div>
    </div>

    <!-- Jellyfin Config -->
    <template v-if="settings['library.provider'] !== 'plex'">
      <p class="section-hint" style="margin: 12px 0 8px;">
        API Key unter Jellyfin Dashboard &rarr; API-Schlüssel erstellen.
      </p>
      <div class="form-grid">
        <div class="form-group">
          <label for="jellyfin-url">Server URL <span class="required">*</span></label>
          <input
            id="jellyfin-url"
            v-model="settings['jellyfin.url']"
            placeholder="http://192.168.1.100:8096"
            @blur="validateUrl('jellyfin.url')"
            :class="{ 'input-error': errors['jellyfin.url'] }"
          />
          <span v-if="errors['jellyfin.url']" class="field-error">{{ errors['jellyfin.url'] }}</span>
        </div>
        <div class="form-group">
          <label for="jellyfin-key">API Key <span class="required">*</span></label>
          <input id="jellyfin-key" v-model="settings['jellyfin.api_key']" type="password" placeholder="API Key" />
        </div>
      </div>
      <div class="settings-action-row">
        <button class="btn btn-secondary" @click="testJellyfinConnection">Verbindung testen</button>
        <span v-if="jellyfinStatus.connected" class="badge badge-found">
          {{ jellyfinStatus.serverName }} ({{ jellyfinStatus.movieCount }} Filme)
        </span>
        <span v-else-if="settings['jellyfin.url']" class="badge badge-not_found">Nicht verbunden</span>
        <span v-else class="badge badge-not_found">Nicht konfiguriert</span>
      </div>
    </template>

    <!-- Plex Library Config -->
    <template v-if="settings['library.provider'] === 'plex'">
      <p class="section-hint" style="margin: 12px 0 8px;">
        Plex Server URL und Token eingeben. Token findest du unter
        <a href="https://www.plex.tv/claim/" target="_blank" rel="noopener">plex.tv/claim</a>
        oder in den XML-Einstellungen deines Servers.
      </p>
      <div class="form-grid">
        <div class="form-group">
          <label for="plex-server-url">Server URL <span class="required">*</span></label>
          <input
            id="plex-server-url"
            v-model="settings['plex.server_url']"
            placeholder="http://192.168.1.100:32400"
            @blur="validateUrl('plex.server_url')"
            :class="{ 'input-error': errors['plex.server_url'] }"
          />
          <span v-if="errors['plex.server_url']" class="field-error">{{ errors['plex.server_url'] }}</span>
        </div>
        <div class="form-group">
          <label for="plex-lib-token">Plex Token <span class="required">*</span></label>
          <input id="plex-lib-token" v-model="settings['plex.token']" type="password" placeholder="Plex Token" />
        </div>
      </div>
      <div class="settings-action-row">
        <button class="btn btn-secondary" @click="testPlexLibraryConnection">Verbindung testen</button>
        <span v-if="plexLibraryStatus.connected" class="badge badge-found">
          {{ plexLibraryStatus.serverName }} ({{ plexLibraryStatus.movieCount }} Filme)
        </span>
        <span v-else-if="settings['plex.server_url']" class="badge badge-not_found">Nicht verbunden</span>
        <span v-else class="badge badge-not_found">Nicht konfiguriert</span>
      </div>
    </template>
  </details>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { getJellyfinStatus, testJellyfin, getPlexLibraryStatus, testPlexLibrary } from '../../api/index';
import type { ServiceStatus } from '../../types/index';
import { useSettingsContext } from '../../composables/useSettingsContext';
import { useToast } from '../../composables/useApp';

const { settings, errors, saveAll, validateUrl } = useSettingsContext();
const toast = useToast();

const jellyfinStatus = ref<ServiceStatus>({ connected: false, serverName: '', movieCount: 0 });
const plexLibraryStatus = ref<ServiceStatus>({ connected: false, serverName: '', movieCount: 0 });

async function testJellyfinConnection() {
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
  }
}

async function testPlexLibraryConnection() {
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
a {
  color: var(--accent);
}
</style>
