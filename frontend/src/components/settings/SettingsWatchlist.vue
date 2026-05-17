<template>
  <!-- Watchlist Provider -->
  <details class="card settings-section" open>
    <summary class="card-toggle"><h2>Watchlist-Quelle</h2></summary>
    <div class="form-grid">
      <div class="form-group">
        <label for="watchlist-provider">Provider</label>
        <select id="watchlist-provider" v-model="settings['watchlist.provider']">
          <option value="trakt">Trakt.tv</option>
          <option value="plex">Plex</option>
          <option value="both">Beide (Trakt + Plex)</option>
        </select>
      </div>
    </div>
  </details>

  <!-- Trakt -->
  <details class="card settings-section" open v-if="settings['watchlist.provider'] !== 'plex'">
    <summary class="card-toggle"><h2>Trakt.tv</h2></summary>
    <div class="setup-guide">
      <strong>Einrichtung:</strong>
      <ol>
        <li>Erstelle eine API-App auf <a href="https://trakt.tv/oauth/applications/new" target="_blank" rel="noopener">trakt.tv/oauth/applications/new</a></li>
        <li>Name frei wählbar, als Redirect URI <code>urn:ietf:wg:oauth:2.0:oob</code> eintragen</li>
        <li>Client ID und Client Secret hier unten einfügen</li>
        <li>Auf "Trakt autorisieren" klicken und den Pin-Code eingeben</li>
      </ol>
    </div>
    <div class="form-grid">
      <div class="form-group">
        <label for="trakt-client-id">Client ID <span class="required">*</span></label>
        <input id="trakt-client-id" v-model="settings['trakt.client_id']" placeholder="Client ID von trakt.tv/oauth/applications" />
      </div>
      <div class="form-group">
        <label for="trakt-client-secret">Client Secret <span class="required">*</span></label>
        <input id="trakt-client-secret" v-model="settings['trakt.client_secret']" type="password" placeholder="Client Secret" />
      </div>
    </div>
    <div class="settings-action-row">
      <button class="btn btn-secondary" @click="startTraktAuth">Trakt autorisieren</button>
      <span v-if="traktStatus.authenticated" class="badge badge-found">Verbunden{{ traktStatus.username ? ' (' + traktStatus.username + ')' : '' }}</span>
      <span v-else-if="traktStatus.configured" class="badge badge-pending">Nicht autorisiert</span>
      <span v-else class="badge badge-not_found">Nicht konfiguriert</span>
    </div>

    <div v-if="showTraktAuth" class="trakt-auth-flow">
      <div class="alert alert-info">
        <p>1. Öffne diesen Link und autorisiere die App:</p>
        <p><a :href="traktAuthUrl" target="_blank" rel="noopener">{{ traktAuthUrl }}</a></p>
        <p style="margin-top: 8px;">2. Gib den erhaltenen Code hier ein:</p>
      </div>
      <div class="settings-action-row">
        <input v-model="traktCode" placeholder="Pin/Code eingeben" style="max-width: 300px;" aria-label="Trakt Pin-Code" />
        <button class="btn btn-primary" @click="exchangeCode">Code einlösen</button>
      </div>
    </div>
  </details>

  <!-- Plex Watchlist -->
  <details class="card settings-section" open v-if="settings['watchlist.provider'] !== 'trakt'">
    <summary class="card-toggle"><h2>Plex</h2></summary>
    <div class="settings-action-row" style="flex-wrap: wrap;">
      <button class="btn btn-primary" @click="startPlexAuth" :disabled="plexAuthPolling">
        <LoadingSpinner v-if="plexAuthPolling" inline />
        {{ plexAuthPolling ? 'Warte auf Autorisierung...' : 'Mit Plex verbinden' }}
      </button>
      <span v-if="plexStatus.connected" class="badge badge-found">
        Verbunden{{ plexStatus.username ? ' (' + plexStatus.username + ')' : '' }} - {{ plexStatus.movieCount }} Filme
      </span>
      <span v-else class="badge badge-not_found">Nicht verbunden</span>
    </div>

    <div v-if="plexAuthUrl" class="alert alert-info" style="margin-top: 12px;">
      <p>Ein neues Fenster wurde geoeffnet. Melde dich bei Plex an und erlaube den Zugriff.</p>
      <p style="margin-top: 6px;">Falls das Fenster nicht geoeffnet wurde:
        <a :href="plexAuthUrl" target="_blank" rel="noopener">Hier klicken</a>
      </p>
    </div>
  </details>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import {
  getTraktAuthUrl, exchangeTraktCode, getTraktStatus,
  getPlexStatus, getPlexAuthPin, checkPlexAuthPin,
} from '../../api/index';
import type { TraktStatus, ServiceStatus } from '../../types/index';
import { useSettingsContext } from '../../composables/useSettingsContext';
import { useToast } from '../../composables/useApp';
import LoadingSpinner from '../LoadingSpinner.vue';

const { settings, saveAll, loadSettings } = useSettingsContext();
const toast = useToast();

const traktStatus = ref<TraktStatus>({ configured: false, authenticated: false, username: '' });
const showTraktAuth = ref(false);
const traktAuthUrl = ref('');
const traktCode = ref('');

const plexStatus = ref<ServiceStatus>({ connected: false, username: '', movieCount: 0 });
const plexAuthUrl = ref('');
const plexAuthPolling = ref(false);
let plexPollTimer: ReturnType<typeof setInterval> | null = null;

async function startTraktAuth() {
  await saveAll();
  try {
    const res = await getTraktAuthUrl();
    traktAuthUrl.value = res.data.url;
    showTraktAuth.value = true;
  } catch {
    toast.value?.add('Speichere zuerst Client ID und Secret', 'error');
  }
}

async function exchangeCode() {
  try {
    await exchangeTraktCode(traktCode.value);
    toast.value?.add('Trakt erfolgreich verbunden!', 'success');
    showTraktAuth.value = false;
    traktCode.value = '';
    await loadSettings();
    await loadStatuses();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Code-Einlösung fehlgeschlagen';
    const axiosErr = e as { response?: { data?: { error?: string } } };
    toast.value?.add(axiosErr.response?.data?.error || msg, 'error');
  }
}

async function startPlexAuth() {
  try {
    const res = await getPlexAuthPin();
    const { pinId, authUrl } = res.data;
    plexAuthUrl.value = authUrl;
    plexAuthPolling.value = true;
    window.open(authUrl, '_blank');

    let attempts = 0;
    if (plexPollTimer) clearInterval(plexPollTimer);
    plexPollTimer = setInterval(async () => {
      attempts++;
      if (attempts > 40) {
        if (plexPollTimer) clearInterval(plexPollTimer);
        plexAuthPolling.value = false;
        plexAuthUrl.value = '';
        toast.value?.add('Plex-Autorisierung abgelaufen. Versuche es erneut.', 'warning');
        return;
      }
      try {
        const check = await checkPlexAuthPin(pinId);
        if (check.data.success) {
          if (plexPollTimer) { clearInterval(plexPollTimer); plexPollTimer = null; }
          plexAuthPolling.value = false;
          plexAuthUrl.value = '';
          toast.value?.add('Plex erfolgreich verbunden!', 'success');
          await loadSettings();
          await loadStatuses();
        }
      } catch { /* polling, ignore errors */ }
    }, 3000);
  } catch (e: unknown) {
    const axiosErr = e as { response?: { data?: { error?: string } } };
    toast.value?.add(axiosErr.response?.data?.error || 'Plex-Autorisierung fehlgeschlagen', 'error');
  }
}

async function loadStatuses() {
  const [traktRes, plexRes] = await Promise.all([
    getTraktStatus().catch(() => ({ data: { configured: false, authenticated: false, username: '' } })),
    getPlexStatus().catch(() => ({ data: { connected: false, username: '', movieCount: 0 } })),
  ]);
  traktStatus.value = traktRes.data;
  plexStatus.value = plexRes.data;
}

onMounted(loadStatuses);

onBeforeUnmount(() => {
  if (plexPollTimer) clearInterval(plexPollTimer);
});
</script>

<style scoped>
.setup-guide {
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 16px;
  font-size: 0.9em;
  line-height: 1.6;
}

.setup-guide ol {
  margin: 6px 0 0 18px;
  padding: 0;
}

.setup-guide a {
  color: var(--accent);
}

.setup-guide code {
  background: var(--bg-primary);
  padding: 2px 6px;
  border-radius: 4px;
}

.trakt-auth-flow {
  margin-top: 15px;
}

.trakt-auth-flow a {
  color: var(--accent);
}
</style>
