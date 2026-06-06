<template>
  <Transition name="wizard-fade">
    <div v-if="visible" class="wizard-overlay">
      <div class="wizard-container">
        <!-- Progress bar -->
        <div class="wizard-progress">
          <div class="wizard-progress-bar" :style="{ width: ((step + 1) / steps.length * 100) + '%' }"></div>
        </div>
        <div class="wizard-step-label">{{ step + 1 }} / {{ steps.length }} &mdash; {{ steps[step] }}</div>

        <!-- Step 0: Welcome -->
        <div v-if="step === 0" class="wizard-step">
          <div class="wizard-welcome">
            <img class="wizard-logo" src="/icon-192.png" alt="dlvault" aria-hidden="true" />
            <h1>Willkommen bei <em class="wizard-italic">dlvault</em></h1>
            <p>
              Automatische Downloads von deiner Trakt/Plex Watchlist direkt in deine Mediathek.
            </p>
            <p class="text-secondary">
              Dieses Setup richtet die wichtigsten Verbindungen ein. Dauert etwa 2 Minuten.
            </p>
          </div>
        </div>

        <!-- Step 1: Reference Plugin (Internet Archive) -->
        <div v-if="step === 1" class="wizard-step">
          <h2>Erstes Quell-Plugin</h2>
          <p class="section-hint">
            dlvault ist ein Plugin-Host — du installierst die Quellen die du nutzen willst.
            Als Einstieg empfehlen wir das offizielle Reference-Plugin für das
            <strong>Internet Archive</strong> (archive.org).
          </p>

          <div class="setup-guide">
            <strong>Was du bekommst:</strong>
            <ul>
              <li>~6000 gemeinfreie Spielfilme (Klassiker, Schwarz-Weiss-Filme, Government-Reels)</li>
              <li>Direkte Downloads via JDownloader — keine Captchas, keine Wartezeiten</li>
              <li>Komplett legal: archive.org's kuratierte <code>feature_films</code>-Collection</li>
            </ul>
          </div>

          <div v-if="iaInstall.status === 'idle'" class="settings-action-row" style="margin-top: 16px;">
            <button class="btn btn-primary" @click="installReferencePlugin">
              Internet Archive Plugin installieren
            </button>
            <span class="text-secondary" style="font-size: 0.9em;">
              Du kannst diesen Schritt auch überspringen und Plugins später unter Einstellungen verwalten.
            </span>
          </div>
          <div v-else-if="iaInstall.status === 'installing'" class="settings-action-row" style="margin-top: 16px;">
            <LoadingSpinner inline /> Installiere...
          </div>
          <div v-else-if="iaInstall.status === 'success'" class="alert alert-success" style="margin-top: 16px;">
            <p><strong>Erfolgreich installiert.</strong> Internet Archive ist jetzt als Quelle aktiv.</p>
          </div>
          <div v-else-if="iaInstall.status === 'error'" class="alert alert-error" style="margin-top: 16px;">
            <p><strong>Installation fehlgeschlagen:</strong> {{ iaInstall.error }}</p>
            <p style="margin-top: 4px; font-size: 0.9em;">
              Du kannst es später unter Einstellungen &rarr; Plugins manuell installieren.
            </p>
          </div>
        </div>

        <!-- Step 2: Watchlist -->
        <div v-if="step === 2" class="wizard-step">
          <h2>Watchlist-Quelle</h2>
          <p class="section-hint">Woher sollen die Filme kommen?</p>

          <div class="form-group">
            <label>Provider</label>
            <select v-model="settings['watchlist.provider']">
              <option value="seerr">Seerr</option>
              <option value="trakt">Trakt.tv</option>
              <option value="plex">Plex</option>
              <option value="both">Beide (Trakt + Plex)</option>
            </select>
          </div>

          <!-- Seerr -->
          <template v-if="settings['watchlist.provider'] === 'seerr'">
            <div class="setup-guide">
              <strong>Seerr einrichten:</strong>
              <ol>
                <li>In Seerr (auch Jellyseerr/Overseerr) unter <em>Einstellungen &rarr; Allgemein</em> den API-Key kopieren</li>
                <li>URL und Key hier eintragen</li>
                <li>Radarr/Sonarr wird <strong>nicht</strong> gebraucht &mdash; dlvault übernimmt das</li>
              </ol>
            </div>
            <div class="form-grid">
              <div class="form-group">
                <label>Server-URL <span class="required">*</span></label>
                <input v-model="settings['seerr.url']" placeholder="http://192.168.x.x:5055" />
              </div>
              <div class="form-group">
                <label>API-Key <span class="required">*</span></label>
                <SecretInput v-model="settings['seerr.api_key']" placeholder="API-Key" />
              </div>
            </div>
            <!-- Seerr is the recommended provider — and was the only one a wrong
                 key could not be checked for before the summary. -->
            <div class="settings-action-row">
              <button class="btn btn-secondary" @click="testSeerrConnection" :disabled="!!busy || !settings['seerr.url'] || !settings['seerr.api_key']">Verbindung testen</button>
              <span v-if="seerrConnected" class="badge badge-found">Verbunden{{ seerrVersion ? ` · ${seerrVersion}` : '' }}</span>
              <span v-else class="badge badge-not_found">Nicht verbunden</span>
            </div>
          </template>

          <!-- Trakt -->
          <template v-if="settings['watchlist.provider'] === 'trakt' || settings['watchlist.provider'] === 'both'">
            <div class="setup-guide">
              <strong>Trakt einrichten:</strong>
              <ol>
                <li>Erstelle eine API-App auf <a href="https://trakt.tv/oauth/applications/new" target="_blank" rel="noopener">trakt.tv/oauth/applications/new</a></li>
                <li>Redirect URI: <code>urn:ietf:wg:oauth:2.0:oob</code></li>
                <li>Client ID und Secret hier einfügen</li>
              </ol>
            </div>
            <div class="form-grid">
              <div class="form-group">
                <label>Client ID <span class="required">*</span></label>
                <input v-model="settings['trakt.client_id']" placeholder="Client ID" />
              </div>
              <div class="form-group">
                <label>Client Secret <span class="required">*</span></label>
                <SecretInput v-model="settings['trakt.client_secret']" placeholder="Client Secret" />
              </div>
            </div>
            <div class="settings-action-row">
              <button class="btn btn-secondary" @click="startTraktAuth" :disabled="!!busy || !settings['trakt.client_id'] || !settings['trakt.client_secret']">Trakt autorisieren</button>
              <span v-if="traktStatus.authenticated" class="badge badge-found">Verbunden{{ traktStatus.username ? ' (' + traktStatus.username + ')' : '' }}</span>
              <span v-else-if="traktStatus.configured" class="badge badge-pending">Nicht autorisiert</span>
              <span v-else class="badge badge-not_found">Nicht konfiguriert</span>
            </div>
            <div v-if="showTraktAuth" class="trakt-auth-flow">
              <div class="alert alert-info">
                <p>1. Öffne diesen Link und autorisiere die App:</p>
                <p><a :href="traktAuthUrl" target="_blank" rel="noopener">{{ traktAuthUrl }}</a></p>
                <p style="margin-top: 8px;">2. Gib den Code hier ein:</p>
              </div>
              <div class="settings-action-row">
                <input v-model="traktCode" placeholder="Pin/Code eingeben" style="max-width: 300px;" />
                <button class="btn btn-primary" @click="exchangeCode" :disabled="!!busy || !traktCode">Code einlösen</button>
              </div>
            </div>
          </template>

          <!-- Plex Watchlist -->
          <template v-if="settings['watchlist.provider'] === 'plex' || settings['watchlist.provider'] === 'both'">
            <div class="settings-action-row" style="margin-top: 16px;">
              <button class="btn btn-primary" @click="startPlexAuth" :disabled="plexAuthPolling">
                <LoadingSpinner v-if="plexAuthPolling" inline />
                {{ plexAuthPolling ? 'Warte auf Autorisierung…' : 'Mit Plex verbinden' }}
              </button>
              <span v-if="plexStatus.connected" class="badge badge-found">
                Verbunden{{ plexStatus.username ? ' (' + plexStatus.username + ')' : '' }}
              </span>
              <span v-else class="badge badge-not_found">Nicht verbunden</span>
            </div>
            <div v-if="plexAuthUrl" class="alert alert-info" style="margin-top: 12px;">
              <p>Ein neues Fenster wurde geöffnet. Melde dich bei Plex an und erlaube den Zugriff.</p>
              <p style="margin-top: 6px;">Falls das Fenster nicht geöffnet wurde: <a :href="plexAuthUrl" target="_blank" rel="noopener">Hier klicken</a></p>
            </div>
          </template>
        </div>

        <!-- Step 3: Mediaserver -->
        <div v-if="step === 3" class="wizard-step">
          <h2>Mediathek-Server</h2>
          <p class="section-hint">Titel, die schon in deiner Mediathek sind, werden automatisch übersprungen.</p>

          <div class="form-group">
            <label>Mediaserver</label>
            <select v-model="settings['library.provider']">
              <option value="jellyfin">Jellyfin</option>
              <option value="plex">Plex</option>
            </select>
          </div>

          <!-- Jellyfin -->
          <template v-if="settings['library.provider'] !== 'plex'">
            <p class="section-hint">API Key unter Jellyfin Dashboard &rarr; API-Schlüssel erstellen.</p>
            <div class="form-grid">
              <div class="form-group">
                <label>Server URL <span class="required">*</span></label>
                <input v-model="settings['jellyfin.url']" placeholder="http://192.168.1.100:8096" />
              </div>
              <div class="form-group">
                <label>API Key <span class="required">*</span></label>
                <SecretInput v-model="settings['jellyfin.api_key']" placeholder="API Key" />
              </div>
            </div>
            <div class="settings-action-row">
              <button class="btn btn-secondary" @click="testJellyfinConnection" :disabled="!!busy || !settings['jellyfin.url'] || !settings['jellyfin.api_key']">Verbindung testen</button>
              <span v-if="jellyfinStatus.connected" class="badge badge-found">
                {{ jellyfinStatus.serverName }} ({{ jellyfinStatus.movieCount }} Filme)
              </span>
              <span v-else class="badge badge-not_found">Nicht konfiguriert</span>
            </div>
          </template>

          <!-- Plex Library -->
          <template v-if="settings['library.provider'] === 'plex'">
            <p class="section-hint">Plex Server URL und Token eingeben.</p>
            <div class="form-grid">
              <div class="form-group">
                <label>Server URL <span class="required">*</span></label>
                <input v-model="settings['plex.server_url']" placeholder="http://192.168.1.100:32400" />
              </div>
              <div class="form-group">
                <label>Plex Token <span class="required">*</span></label>
                <SecretInput v-model="settings['plex.token']" placeholder="Plex Token" />
              </div>
            </div>
            <div class="settings-action-row">
              <button class="btn btn-secondary" @click="testPlexLibConnection" :disabled="!!busy || !settings['plex.server_url'] || !settings['plex.token']">Verbindung testen</button>
              <span v-if="plexLibStatus.connected" class="badge badge-found">
                {{ plexLibStatus.serverName }} ({{ plexLibStatus.movieCount }} Filme)
              </span>
              <span v-else class="badge badge-not_found">Nicht konfiguriert</span>
            </div>
          </template>
        </div>

        <!-- Step 4: JDownloader -->
        <div v-if="step === 4" class="wizard-step">
          <h2>MyJDownloader</h2>
          <p class="section-hint">JDownloader lädt die Dateien herunter und entpackt sie automatisch.</p>

          <div class="form-grid">
            <div class="form-group">
              <label>E-Mail <span class="required">*</span></label>
              <input v-model="settings['jdownloader.email']" type="email" placeholder="myjdownloader@email.com" />
            </div>
            <div class="form-group">
              <label>Passwort <span class="required">*</span></label>
              <SecretInput v-model="settings['jdownloader.password']" placeholder="Passwort" />
            </div>
            <div class="form-group">
              <label>Gerätename <small class="text-secondary">(leer = erstes Gerät)</small></label>
              <input v-model="settings['jdownloader.device_name']" list="jd-devices-wiz" placeholder="JDownloader@server" />
              <datalist id="jd-devices-wiz">
                <option v-for="d in jdStatus.devices" :key="d.name" :value="d.name" />
              </datalist>
            </div>
          </div>
          <div class="settings-action-row">
            <button class="btn btn-secondary" @click="testJDConnection" :disabled="!!busy || !settings['jdownloader.email'] || !settings['jdownloader.password']">Verbindung testen</button>
            <span v-if="jdStatus.connected" class="badge badge-found">
              Verbunden ({{ jdStatus.devices.length }} Gerät{{ jdStatus.devices.length !== 1 ? 'e' : '' }})
            </span>
            <span v-else class="badge badge-not_found">Nicht konfiguriert</span>
          </div>
          <p
            v-if="jdStatus.connected && jdStatus.deviceNameConfigured && !jdStatus.selectedDevice"
            class="section-hint"
            style="color: var(--err);"
          >
            Achtung: Gerät '{{ jdStatus.deviceNameConfigured }}' passt zu keiner der {{ jdStatus.devices.length }} gefundenen Instanzen - Downloads kämen NICHT an. Verfügbar: {{ jdStatus.devices.map(d => d.name).join(', ') }}
          </p>
        </div>

        <!-- Step 5: Paths (read-only) -->
        <div v-if="step === 5" class="wizard-step">
          <h2>Verzeichnisse</h2>
          <p class="section-hint">
            Die Pfade werden über Docker Volume-Mounts beim Container-Start gesetzt und sind in der Weboberfläche nicht änderbar.
          </p>

          <div class="path-summary" :class="!pathsCheckedYet ? 'path-checking' : pathsConfigured ? 'path-ok' : 'path-error'">
            <span class="status-icon">{{ !pathsCheckedYet ? '…' : pathsConfigured ? '✓' : '⚠' }}</span>
            <div>
              <div class="path-summary-title">
                {{ !pathsCheckedYet ? 'Prüfe Mounts…' : pathsConfigured ? 'Korrekt konfiguriert' : 'Handlungsbedarf' }}
              </div>
              <div v-if="pathsCheckedYet && !pathsConfigured" class="path-summary-detail">
                Nicht gemountet: {{ unmountedLabels }}. Prüfe die Docker Volume-Mounts.
              </div>
            </div>
          </div>

          <ul class="path-mounts">
            <li v-for="p in pathDefs" :key="p.key">
              <span class="path-mounts-label">{{ p.label }}</span>
              <span class="path-mounts-value">{{ settings[p.key] || p.fallback }}</span>
            </li>
          </ul>
        </div>

        <!-- Step 6: Done -->
        <div v-if="step === 6" class="wizard-step">
          <div class="wizard-welcome">
            <div class="wizard-logo wizard-logo-done" aria-hidden="true"><Rocket :size="32" /></div>
            <h1>Setup <em class="wizard-italic">abgeschlossen!</em></h1>
            <p v-if="allOk">Alle wichtigen Verbindungen sind eingerichtet.</p>
            <p v-else>Einige Verbindungen fehlen noch — du kannst sie jederzeit in den Einstellungen nachholen.</p>

            <div class="wizard-summary">
              <div class="summary-item" v-for="s in summary" :key="s.label">
                <span class="summary-icon" :class="s.ok ? 'text-success' : 'text-error'">{{ s.ok ? '\u2713' : '\u2717' }}</span>
                <span>{{ s.label }}</span>
                <span class="badge" :class="s.ok ? 'badge-found' : 'badge-not_found'">{{ s.badge }}</span>
              </div>
            </div>

            <p class="text-secondary" style="margin-top: 16px;">
              {{ allOk ? 'Starte jetzt den ersten Sync — oder pass die Einstellungen weiter an.' : 'Der Sync kann trotzdem schon laufen; was fehlt, wird übersprungen.' }}
            </p>
          </div>
        </div>

        <!-- Navigation -->
        <div class="wizard-nav">
          <button v-if="step > 0" class="btn btn-secondary" @click="prev">Zurück</button>
          <div class="wizard-nav-spacer"></div>
          <button v-if="step < steps.length - 1" class="btn btn-secondary btn-skip" @click="skip">Überspringen</button>
          <button v-if="step < steps.length - 1" class="btn btn-primary" :disabled="!!busy" @click="next()">
            {{ step === 0 ? 'Los geht\'s' : 'Weiter' }}
          </button>
          <button v-if="step === steps.length - 1" class="btn btn-secondary" @click="finish">
            Setup beenden
          </button>
          <button v-if="step === steps.length - 1" class="btn btn-primary" :disabled="!!busy" @click="finishAndSync">
            Beenden und ersten Sync starten
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { safeStorage } from '../utils/storage';
import { apiMessage } from '../utils/apiError';
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import {
  getSeerrStatus, testSeerr_api, authRequired, listPlugins,
  getSettings, updateSettings, validatePaths,
  getTraktAuthUrl, exchangeTraktCode, getTraktStatus,
  getPlexStatus, getPlexAuthPin, checkPlexAuthPin,
  getJellyfinStatus, testJellyfin,
  getPlexLibraryStatus, testPlexLibrary,
  getJDownloaderStatus, testJDownloader,
  runSync, installPluginFromUrl,
} from '../api/index';
import type { TraktStatus, ServiceStatus, JDStatus } from '../types/index';
import { useToast } from '../composables/useApp';
import LoadingSpinner from './LoadingSpinner.vue';
import SecretInput from './settings/SecretInput.vue';
import { Rocket } from 'lucide-vue-next';

const STORAGE_KEY = 'dlvault_setup_completed';

const emit = defineEmits<{ (e: 'close'): void }>();
const toast = useToast();

const visible = ref(false);
const step = ref(0);
const settings = ref<Record<string, string>>({});

const steps = ['Willkommen', 'Quell-Plugin', 'Watchlist', 'Mediaserver', 'JDownloader', 'Verzeichnisse', 'Fertig'];

const IA_REFERENCE_PLUGIN_URL = 'https://github.com/dlvault/plugin-archive-org/releases/latest/download/internet-archive.dlvault.js';

const iaInstall = ref<{ status: 'idle' | 'installing' | 'success' | 'error'; error?: string }>({ status: 'idle' });

async function installReferencePlugin() {
  iaInstall.value = { status: 'installing' };
  try {
    await installPluginFromUrl(IA_REFERENCE_PLUGIN_URL, true);
    iaInstall.value = { status: 'success' };
  } catch (err: any) {
    iaInstall.value = { status: 'error', error: apiMessage(err, 'Unbekannter Fehler') };
  }
}

// --- Trakt ---
const traktStatus = ref<TraktStatus>({ configured: false, authenticated: false, username: '' });
const showTraktAuth = ref(false);
const traktAuthUrl = ref('');
const traktCode = ref('');

// --- Plex Watchlist ---
const plexStatus = ref<ServiceStatus>({ connected: false, username: '', movieCount: 0 });
const plexAuthUrl = ref('');
const plexAuthPolling = ref(false);
let plexPollTimer: ReturnType<typeof setInterval> | null = null;

// --- Media Server ---
const jellyfinStatus = ref<ServiceStatus>({ connected: false, serverName: '', movieCount: 0 });
const plexLibStatus = ref<ServiceStatus>({ connected: false, serverName: '', movieCount: 0 });

// --- JDownloader ---
const jdStatus = ref<JDStatus>({ configured: false, connected: false, devices: [] });

// --- Paths ---
interface PathResult { exists: boolean; writable: boolean; empty: boolean; error?: string; }
const pathStatus = ref<Record<string, PathResult>>({});
const pathDefs = [
  { key: 'paths.downloads', label: 'Downloads', fallback: '/downloads' },
  { key: 'paths.movies', label: 'Filme', fallback: '/movies' },
  { key: 'paths.series', label: 'Serien', fallback: '/series' },
];

// Configured-status, not a writability probe: a mounted volume "exists" even when
// the temp-file writability test trips on Windows bind-mount uid mapping (which
// made correctly-set paths show orange). Base the wizard status on existence.
const pathsCheckedYet = computed(() => pathDefs.every(p => pathStatus.value[p.key]));
const pathsConfigured = computed(() => pathDefs.every(p => pathStatus.value[p.key]?.exists));
const unmountedLabels = computed(() =>
  pathDefs.filter(p => pathStatus.value[p.key] && !pathStatus.value[p.key]?.exists).map(p => p.label).join(', ')
);

// --- Summary ---
const seerrConnected = ref(false);
const seerrVersion = ref('');

async function testSeerrConnection() {
  if (busy.value || !(await saveSettings())) return;
  busy.value = 'seerr';
  try {
    const res = await testSeerr_api();
    seerrConnected.value = true;
    seerrVersion.value = res.data?.version || '';
  } catch (e) {
    seerrConnected.value = false;
    toast.value?.add(errMsg(e, 'Seerr nicht erreichbar'), 'error');
  } finally {
    busy.value = null;
  }
}
const summary = computed(() => {
  const provider = settings.value['watchlist.provider'] || 'trakt';
  const watchlistOk = provider === 'seerr' ? seerrConnected.value
    : provider === 'plex' ? plexStatus.value.connected
    : provider === 'both' ? traktStatus.value.authenticated && plexStatus.value.connected
    : traktStatus.value.authenticated;
  const libProvider = settings.value['library.provider'] || 'jellyfin';
  const mediaOk = libProvider === 'plex' ? plexLibStatus.value.connected : jellyfinStatus.value.connected;
  const pathsOk = pathDefs.every(p => pathStatus.value[p.key]?.exists);

  return [
    { label: 'Watchlist', ok: watchlistOk, badge: watchlistOk ? 'Verbunden' : 'Nicht verbunden' },
    { label: 'Mediaserver', ok: mediaOk, badge: mediaOk ? 'Verbunden' : 'Nicht verbunden' },
    { label: 'JDownloader', ok: jdStatus.value.connected, badge: jdStatus.value.connected ? 'Verbunden' : 'Nicht verbunden' },
    { label: 'Verzeichnisse', ok: pathsOk, badge: pathsOk ? 'OK' : 'Problem' },
    // Without a source plugin every title ends as "Kein Release bei der Quelle".
    { label: 'Quell-Plugin', ok: hasSourcePlugin.value, badge: hasSourcePlugin.value ? 'Installiert' : 'Fehlt' },
  ];
});
const allOk = computed(() => summary.value.every(s => s.ok));

// --- Lifecycle ---
// What the server holds — the wizard saves only what differs from it. Sending
// the whole object wrote a stale copy back over changes made in Settings since,
// and restarted every service on each "Weiter".
let savedSnapshot: Record<string, string> = {};

async function loadWizardSettings(): Promise<boolean> {
  try {
    const res = await getSettings();
    savedSnapshot = { ...res.data };
    settings.value = res.data;
    if (!settings.value['library.provider']) settings.value['library.provider'] = 'jellyfin';
    if (!settings.value['watchlist.provider']) settings.value['watchlist.provider'] = 'seerr';   // same recommendation as Settings
    return true;
  } catch {
    return false;
  }
}

onMounted(async () => {
  if (safeStorage.get(STORAGE_KEY)) return;
  // A failed load (token login pending, server down) is not "nothing set up":
  // the wizard used to open over the login prompt with every field empty.
  if (!(await loadWizardSettings()) || authRequired.value) return;
  // Show wizard if no critical settings configured
  const hasWatchlist = settings.value['trakt.client_id'] || settings.value['plex.token'] || settings.value['seerr.url'];
  const hasMedia = settings.value['jellyfin.url'] || settings.value['plex.server_url'];
  const hasJD = settings.value['jdownloader.email'];
  if (!hasWatchlist && !hasMedia && !hasJD) {
    visible.value = true;
  }
});

function stopPlexPolling() {
  if (plexPollTimer) {
    clearInterval(plexPollTimer);
    plexPollTimer = null;
  }
  plexAuthPolling.value = false;
  plexAuthUrl.value = '';
}

onBeforeUnmount(stopPlexPolling);

// Stop polling when wizard is hidden — finish() / close path doesn't unmount,
// so the interval would otherwise keep running and call APIs against a hidden component.
watch(visible, (isVisible) => {
  if (!isVisible) stopPlexPolling();
});

// --- Navigation ---
/** The server's own message (German), else the fallback — never axios' English. */
function errMsg(e: unknown, fallback: string): string {
  const d = (e as { response?: { data?: { error?: string; message?: string } } }).response?.data;
  return d?.error || d?.message || fallback;
}

async function saveSettings(): Promise<boolean> {
  const delta: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings.value)) {
    if (v === undefined || v === null) continue;
    if (String(v) !== (savedSnapshot[k] ?? '')) delta[k] = String(v);
  }
  if (Object.keys(delta).length === 0) return true;
  try {
    await updateSettings(delta);
    Object.assign(savedSnapshot, delta);
    return true;
  } catch (err: unknown) {
    // Don't swallow this: a silent failure means the next wizard step works
    // against unsaved config and the user finishes believing everything stuck.
    toast.value?.add(errMsg(err, 'Einstellungen konnten nicht gespeichert werden — Schritt ggf. wiederholen'), 'error');
    return false;
  }
}

// `force`: Überspringen moves on even when saving the partial input failed;
// "Weiter" stays on the step so the failure is not carried forward unnoticed.
async function next(force = false) {
  if (step.value > 0 && step.value < steps.length - 1) {
    if (!(await saveSettings()) && !force) return;
  }
  // Load statuses when entering specific steps
  if (step.value === 1) {
    loadWatchlistStatus();
  } else if (step.value === 2) {
    loadMediaStatus();
  } else if (step.value === 3) {
    loadJDStatus();
  } else if (step.value === 4) {
    checkPathsNow();
  } else if (step.value === 5) {
    await saveSettings();
    refreshAllStatuses();
  }
  step.value++;
}

function prev() {
  step.value--;
}

function skip() {
  // Moves on regardless; still tries to save any partial input.
  next(true);
}

function finish() {
  safeStorage.set(STORAGE_KEY, Date.now().toString());
  visible.value = false;
  emit('close');
}

async function finishAndSync() {
  try {
    await runSync();
    toast.value?.add('Erster Sync gestartet', 'success');
  } catch (e) {
    toast.value?.add(errMsg(e, 'Sync konnte nicht gestartet werden'), 'error');
  }
  finish();
}

// Public method to re-open wizard — with the CURRENT settings: the mount-time
// load is skipped once setup was completed, so every field showed empty.
async function open() {
  step.value = 0;
  visible.value = true;
  await loadWizardSettings();
  loadAllStatuses();
}

defineExpose({ open, visible });

// --- Trakt Auth ---
// Which test/auth is running — every one of them used to fail silently and
// could be clicked again while still in flight.
const busy = ref<string | null>(null);

async function startTraktAuth() {
  if (busy.value || !(await saveSettings())) return;
  busy.value = 'trakt';
  try {
    const res = await getTraktAuthUrl();
    traktAuthUrl.value = res.data.url;
    showTraktAuth.value = true;
  } catch (e) {
    toast.value?.add(errMsg(e, 'Trakt-Anmeldung konnte nicht gestartet werden'), 'error');
  } finally {
    busy.value = null;
  }
}

async function exchangeCode() {
  if (busy.value) return;
  busy.value = 'trakt-code';
  try {
    await exchangeTraktCode(traktCode.value);
    showTraktAuth.value = false;
    traktCode.value = '';
    await loadWatchlistStatus();
    toast.value?.add('Trakt verbunden', 'success');
  } catch (e) {
    toast.value?.add(errMsg(e, 'Code ungültig oder abgelaufen — bitte neu autorisieren'), 'error');
  } finally {
    busy.value = null;
  }
}

// --- Plex Watchlist Auth ---
async function startPlexAuth() {
  try {
    const res = await getPlexAuthPin();
    const { pinId, authUrl } = res.data;
    if (plexPollTimer) clearInterval(plexPollTimer);
    plexAuthUrl.value = authUrl;
    plexAuthPolling.value = true;
    window.open(authUrl, '_blank', 'noopener');
    let attempts = 0;
    plexPollTimer = setInterval(async () => {
      attempts++;
      if (attempts > 40) {
        stopPlexPolling();
        toast.value?.add('Plex-Anmeldung nicht abgeschlossen — bitte erneut versuchen', 'warning');
        return;
      }
      try {
        const check = await checkPlexAuthPin(pinId);
        if (check.data.success) {
          stopPlexPolling();
          await loadWizardSettings();
          await loadWatchlistStatus();
          toast.value?.add('Plex verbunden', 'success');
        }
      } catch { /* keep polling */ }
    }, 3000);
  } catch (e) {
    toast.value?.add(errMsg(e, 'Plex-Anmeldung konnte nicht gestartet werden'), 'error');
  }
}

// --- Media Server Tests ---
async function testJellyfinConnection() {
  if (busy.value || !(await saveSettings())) return;
  busy.value = 'jellyfin';
  try {
    const res = await testJellyfin();
    jellyfinStatus.value = { connected: true, serverName: res.data.serverName || 'Jellyfin', movieCount: res.data.movieCount || 0 };
  } catch (e) {
    jellyfinStatus.value = { connected: false, serverName: '', movieCount: 0 };
    toast.value?.add(errMsg(e, 'Jellyfin nicht erreichbar'), 'error');
  } finally {
    busy.value = null;
  }
}

async function testPlexLibConnection() {
  if (busy.value || !(await saveSettings())) return;
  busy.value = 'plex';
  try {
    const res = await testPlexLibrary();
    plexLibStatus.value = { connected: true, serverName: res.data.serverName || 'Plex', movieCount: res.data.movieCount || 0 };
  } catch (e) {
    plexLibStatus.value = { connected: false, serverName: '', movieCount: 0 };
    toast.value?.add(errMsg(e, 'Plex nicht erreichbar'), 'error');
  } finally {
    busy.value = null;
  }
}

// --- JDownloader Test ---
async function testJDConnection() {
  if (busy.value || !(await saveSettings())) return;
  busy.value = 'jd';
  try {
    const res = await testJDownloader();
    jdStatus.value = {
      configured: true,
      connected: true,
      devices: res.data.devices,
      deviceNameConfigured: res.data.deviceNameConfigured,
      selectedDevice: res.data.selectedDevice,
    };
  } catch (e) {
    jdStatus.value = { configured: false, connected: false, devices: [] };
    toast.value?.add(errMsg(e, 'JDownloader nicht erreichbar'), 'error');
  } finally {
    busy.value = null;
  }
}

// --- Paths ---
async function checkPathsNow() {
  try {
    const res = await validatePaths();
    pathStatus.value = res.data;
  } catch (e) {
    toast.value?.add(errMsg(e, 'Verzeichnisse konnten nicht geprüft werden'), 'error');
  }
}

// --- Status loaders ---
async function loadWatchlistStatus() {
  const [traktRes, plexRes, seerrRes] = await Promise.all([
    getTraktStatus().catch(() => ({ data: { configured: false, authenticated: false, username: '' } })),
    getPlexStatus().catch(() => ({ data: { connected: false, username: '', movieCount: 0 } })),
    getSeerrStatus().catch(() => ({ data: { connected: false } })),
  ]);
  traktStatus.value = traktRes.data;
  plexStatus.value = plexRes.data;
  seerrConnected.value = !!seerrRes.data?.connected;
}

async function loadMediaStatus() {
  const [jfRes, plexLibRes] = await Promise.all([
    getJellyfinStatus().catch(() => ({ data: { connected: false, serverName: '', movieCount: 0 } })),
    getPlexLibraryStatus().catch(() => ({ data: { connected: false, serverName: '', movieCount: 0 } })),
  ]);
  jellyfinStatus.value = jfRes.data;
  plexLibStatus.value = plexLibRes.data;
}

async function loadJDStatus() {
  const res = await getJDownloaderStatus().catch(() => ({ data: { configured: false, connected: false, devices: [] } }));
  jdStatus.value = res.data;
}

const hasSourcePlugin = ref(false);
async function loadPluginStatus() {
  try {
    const res = await listPlugins();
    hasSourcePlugin.value = res.data.registered.some(p => p.enabled && p.mediaTypes.some(t => t === 'movie' || t === 'show'));
  } catch { /* keep */ }
}

async function loadAllStatuses() {
  loadPluginStatus();
  await Promise.all([loadWatchlistStatus(), loadMediaStatus(), loadJDStatus(), checkPathsNow()]);
}

async function refreshAllStatuses() {
  // Reload settings first to pick up any token changes
  await loadWizardSettings();
  await loadAllStatuses();
}
</script>

<style scoped>
.wizard-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: var(--bg-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
}

.wizard-container {
  width: 100%;
  max-width: 640px;
  padding: 32px;
  min-height: 0;
}

.wizard-progress {
  height: 4px;
  background: var(--border);
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 8px;
}

.wizard-progress-bar {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.4s ease;
}

.wizard-step-label {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  margin-bottom: 24px;
}

.wizard-step {
  animation: fadeSlideUp 0.25s ease;
}

.wizard-step h2 {
  font-size: 1.2rem;
  margin-bottom: 8px;
}

/* Welcome & Done screens */
.wizard-welcome {
  text-align: center;
  padding: 20px 0;
}

.wizard-logo {
  width: 56px;
  height: 56px;
  margin: 0 auto 16px;
  border-radius: 14px;
  display: block;
  object-fit: contain;
  background: none;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08), 0 12px 28px rgba(0, 0, 0, 0.3);
}

.wizard-logo-done {
  background: rgba(74, 222, 128, 0.18);
  color: var(--ok);
  box-shadow: 0 0 0 1px rgba(74, 222, 128, 0.25), 0 12px 28px rgba(74, 222, 128, 0.18);
}

.wizard-italic {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: var(--accent-2);
}

.wizard-welcome h1 {
  font-size: 1.6rem;
  color: var(--text-primary);
  margin-bottom: 12px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.wizard-welcome p {
  color: var(--text-secondary);
  font-size: var(--fs-base);
  max-width: 440px;
  margin: 0 auto 8px;
  line-height: 1.6;
}

/* Summary */
.wizard-summary {
  margin-top: 20px;
  text-align: left;
  max-width: 380px;
  margin-left: auto;
  margin-right: auto;
}

.summary-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-base);
}

.summary-item:last-child {
  border-bottom: none;
}

.summary-icon {
  font-size: 1.1rem;
  width: 20px;
  text-align: center;
  flex-shrink: 0;
}

.summary-item .badge {
  margin-left: auto;
}

/* Paths */
.path-summary {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px;
  border-radius: var(--radius);
}
.path-summary-title { font-weight: 600; font-size: var(--fs-base); }
.path-summary-detail { font-size: var(--fs-sm); margin-top: 2px; opacity: 0.9; }

.path-mounts {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.path-mounts li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: var(--fs-sm);
  padding: 8px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.path-mounts-label { color: var(--text-secondary); }
.path-mounts-value { font-family: monospace; color: var(--text-primary); }

.path-error {
  color: var(--warning);
  background: rgba(230, 162, 60, 0.1);
}

.path-ok {
  color: var(--success);
  background: rgba(103, 194, 58, 0.1);
}

.path-checking {
  color: var(--text-secondary);
}

.status-icon {
  font-weight: bold;
  font-size: 0.95rem;
}

/* Navigation */
.wizard-nav {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 32px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
}

.wizard-nav-spacer {
  flex: 1;
}

.btn-skip {
  opacity: 0.6;
  font-size: var(--fs-sm);
}

.btn-skip:hover {
  opacity: 1;
}

/* Setup guide & auth flow reuse */
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

.setup-guide a,
.trakt-auth-flow a {
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

/* Transitions */
.wizard-fade-enter-active { transition: opacity 0.3s ease; }
.wizard-fade-leave-active { transition: opacity 0.2s ease; }
.wizard-fade-enter-from { opacity: 0; }
.wizard-fade-leave-to { opacity: 0; }

/* Mobile */
@media (max-width: 768px) {
  .wizard-overlay {
    align-items: flex-start;
  }

  .wizard-container {
    padding: 20px 16px;
    max-width: 100%;
  }

  .wizard-welcome h1 {
    font-size: 1.3rem;
  }

  .wizard-logo {
    width: 48px;
    height: 48px;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }

  .form-group input,
  .form-group select {
    font-size: 16px;
  }
}
</style>
