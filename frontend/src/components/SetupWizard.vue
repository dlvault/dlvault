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

        <!-- Step 1: Watchlist -->
        <div v-if="step === 1" class="wizard-step">
          <h2>Watchlist-Quelle</h2>
          <p class="section-hint">Woher sollen die Filme kommen?</p>

          <div class="form-group">
            <label>Provider</label>
            <select v-model="settings['watchlist.provider']">
              <option value="trakt">Trakt.tv</option>
              <option value="plex">Plex</option>
              <option value="both">Beide (Trakt + Plex)</option>
            </select>
          </div>

          <!-- Trakt -->
          <template v-if="settings['watchlist.provider'] !== 'plex'">
            <div class="setup-guide">
              <strong>Trakt einrichten:</strong>
              <ol>
                <li>Erstelle eine API-App auf <a href="https://trakt.tv/oauth/applications/new" target="_blank" rel="noopener">trakt.tv/oauth/applications/new</a></li>
                <li>Redirect URI: <code>urn:ietf:wg:oauth:2.0:oob</code></li>
                <li>Client ID und Secret hier einfuegen</li>
              </ol>
            </div>
            <div class="form-grid">
              <div class="form-group">
                <label>Client ID <span class="required">*</span></label>
                <input v-model="settings['trakt.client_id']" placeholder="Client ID" />
              </div>
              <div class="form-group">
                <label>Client Secret <span class="required">*</span></label>
                <input v-model="settings['trakt.client_secret']" type="password" placeholder="Client Secret" />
              </div>
            </div>
            <div class="settings-action-row">
              <button class="btn btn-secondary" @click="startTraktAuth" :disabled="!settings['trakt.client_id'] || !settings['trakt.client_secret']">Trakt autorisieren</button>
              <span v-if="traktStatus.authenticated" class="badge badge-found">Verbunden{{ traktStatus.username ? ' (' + traktStatus.username + ')' : '' }}</span>
              <span v-else-if="traktStatus.configured" class="badge badge-pending">Nicht autorisiert</span>
              <span v-else class="badge badge-not_found">Nicht konfiguriert</span>
            </div>
            <div v-if="showTraktAuth" class="trakt-auth-flow">
              <div class="alert alert-info">
                <p>1. Oeffne diesen Link und autorisiere die App:</p>
                <p><a :href="traktAuthUrl" target="_blank" rel="noopener">{{ traktAuthUrl }}</a></p>
                <p style="margin-top: 8px;">2. Gib den Code hier ein:</p>
              </div>
              <div class="settings-action-row">
                <input v-model="traktCode" placeholder="Pin/Code eingeben" style="max-width: 300px;" />
                <button class="btn btn-primary" @click="exchangeCode" :disabled="!traktCode">Code einloesen</button>
              </div>
            </div>
          </template>

          <!-- Plex Watchlist -->
          <template v-if="settings['watchlist.provider'] !== 'trakt'">
            <div class="settings-action-row" style="margin-top: 16px;">
              <button class="btn btn-primary" @click="startPlexAuth" :disabled="plexAuthPolling">
                <LoadingSpinner v-if="plexAuthPolling" inline />
                {{ plexAuthPolling ? 'Warte auf Autorisierung...' : 'Mit Plex verbinden' }}
              </button>
              <span v-if="plexStatus.connected" class="badge badge-found">
                Verbunden{{ plexStatus.username ? ' (' + plexStatus.username + ')' : '' }}
              </span>
              <span v-else class="badge badge-not_found">Nicht verbunden</span>
            </div>
            <div v-if="plexAuthUrl" class="alert alert-info" style="margin-top: 12px;">
              <p>Ein neues Fenster wurde geoeffnet. Melde dich bei Plex an und erlaube den Zugriff.</p>
              <p style="margin-top: 6px;">Falls das Fenster nicht geoeffnet wurde: <a :href="plexAuthUrl" target="_blank" rel="noopener">Hier klicken</a></p>
            </div>
          </template>
        </div>

        <!-- Step 2: Media Server -->
        <div v-if="step === 2" class="wizard-step">
          <h2>Mediathek-Server</h2>
          <p class="section-hint">Filme die bereits in deiner Bibliothek sind werden automatisch uebersprungen.</p>

          <div class="form-group">
            <label>Media Server</label>
            <select v-model="settings['library.provider']">
              <option value="jellyfin">Jellyfin</option>
              <option value="plex">Plex</option>
            </select>
          </div>

          <!-- Jellyfin -->
          <template v-if="settings['library.provider'] !== 'plex'">
            <p class="section-hint">API Key unter Jellyfin Dashboard &rarr; API-Schluessel erstellen.</p>
            <div class="form-grid">
              <div class="form-group">
                <label>Server URL <span class="required">*</span></label>
                <input v-model="settings['jellyfin.url']" placeholder="http://192.168.1.100:8096" />
              </div>
              <div class="form-group">
                <label>API Key <span class="required">*</span></label>
                <input v-model="settings['jellyfin.api_key']" type="password" placeholder="API Key" />
              </div>
            </div>
            <div class="settings-action-row">
              <button class="btn btn-secondary" @click="testJellyfinConnection" :disabled="!settings['jellyfin.url'] || !settings['jellyfin.api_key']">Verbindung testen</button>
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
                <input v-model="settings['plex.token']" type="password" placeholder="Plex Token" />
              </div>
            </div>
            <div class="settings-action-row">
              <button class="btn btn-secondary" @click="testPlexLibConnection" :disabled="!settings['plex.server_url'] || !settings['plex.token']">Verbindung testen</button>
              <span v-if="plexLibStatus.connected" class="badge badge-found">
                {{ plexLibStatus.serverName }} ({{ plexLibStatus.movieCount }} Filme)
              </span>
              <span v-else class="badge badge-not_found">Nicht konfiguriert</span>
            </div>
          </template>
        </div>

        <!-- Step 3: JDownloader -->
        <div v-if="step === 3" class="wizard-step">
          <h2>MyJDownloader</h2>
          <p class="section-hint">JDownloader laedt die Dateien herunter und entpackt sie automatisch.</p>

          <div class="form-grid">
            <div class="form-group">
              <label>E-Mail <span class="required">*</span></label>
              <input v-model="settings['jdownloader.email']" type="email" placeholder="myjdownloader@email.com" />
            </div>
            <div class="form-group">
              <label>Passwort <span class="required">*</span></label>
              <input v-model="settings['jdownloader.password']" type="password" placeholder="Passwort" />
            </div>
            <div class="form-group">
              <label>Geraetename <small class="text-secondary">(leer = erstes Geraet)</small></label>
              <input v-model="settings['jdownloader.device_name']" placeholder="JDownloader@Unraid" />
            </div>
          </div>
          <div class="settings-action-row">
            <button class="btn btn-secondary" @click="testJDConnection" :disabled="!settings['jdownloader.email'] || !settings['jdownloader.password']">Verbindung testen</button>
            <span v-if="jdStatus.connected" class="badge badge-found">
              Verbunden ({{ jdStatus.devices.length }} Geraet{{ jdStatus.devices.length !== 1 ? 'e' : '' }})
            </span>
            <span v-else class="badge badge-not_found">Nicht konfiguriert</span>
          </div>
        </div>

        <!-- Step 4: 2Captcha -->
        <div v-if="step === 4" class="wizard-step">
          <h2>2Captcha</h2>
          <p class="section-hint">
            Wird benoetigt wenn ein installiertes Plugin Captchas zum Aufloesen
            von Quellen verwendet. Falls keine deiner Plugins Captchas anfordern,
            kannst du diesen Schritt ueberspringen.
          </p>
          <div class="setup-guide">
            <strong>Einrichtung:</strong>
            <ol>
              <li>Account erstellen auf <a href="https://2captcha.com" target="_blank" rel="noopener">2captcha.com</a></li>
              <li>Guthaben aufladen (ab $3, reicht fuer hunderte Captchas)</li>
              <li>API Key aus dem Dashboard kopieren</li>
            </ol>
          </div>
          <div class="form-group">
            <label>2Captcha API Key <span class="required">*</span></label>
            <input v-model="settings['secret-store.2captcha-api-key']" type="password" placeholder="API Key" />
            <span v-if="settings['secret-store.2captcha-api-key']" class="badge badge-found badge-mt">Konfiguriert</span>
            <span v-else class="badge badge-not_found badge-mt">Fehlt</span>
          </div>
        </div>

        <!-- Step 5: Paths (read-only) -->
        <div v-if="step === 5" class="wizard-step">
          <h2>Verzeichnisse</h2>
          <p class="section-hint">
            Die Pfade werden ueber Docker Volume-Mounts gesetzt. Hier siehst du ob alles korrekt gemountet ist.
          </p>

          <div class="path-check-grid">
            <div v-for="p in pathDefs" :key="p.key" class="path-check-item">
              <div class="path-check-label">{{ p.label }}</div>
              <div class="path-check-value">{{ settings[p.key] || p.fallback }}</div>
              <div v-if="pathStatus[p.key]" class="path-status" :class="pathStatus[p.key]?.error ? 'path-error' : 'path-ok'">
                <span class="status-icon">{{ pathStatus[p.key]?.error ? '\u26A0' : '\u2713' }}</span>
                <span>{{ pathStatus[p.key]?.error || 'OK — Pfad existiert und ist beschreibbar' }}</span>
              </div>
              <div v-else class="path-status path-checking">
                <LoadingSpinner inline /> Pruefe...
              </div>
            </div>
          </div>
        </div>

        <!-- Step 6: Done -->
        <div v-if="step === 6" class="wizard-step">
          <div class="wizard-welcome">
            <div class="wizard-logo wizard-logo-done" aria-hidden="true"><Rocket :size="32" /></div>
            <h1>Setup <em class="wizard-italic">abgeschlossen!</em></h1>
            <p>Alle wichtigen Verbindungen sind eingerichtet.</p>

            <div class="wizard-summary">
              <div class="summary-item" v-for="s in summary" :key="s.label">
                <span class="summary-icon" :class="s.ok ? 'text-success' : 'text-error'">{{ s.ok ? '\u2713' : '\u2717' }}</span>
                <span>{{ s.label }}</span>
                <span class="badge" :class="s.ok ? 'badge-found' : 'badge-not_found'">{{ s.badge }}</span>
              </div>
            </div>

            <p class="text-secondary" style="margin-top: 16px;">
              Du kannst jetzt den ersten Sync starten oder die Einstellungen weiter anpassen.
            </p>
          </div>
        </div>

        <!-- Navigation -->
        <div class="wizard-nav">
          <button v-if="step > 0" class="btn btn-secondary" @click="prev">Zurueck</button>
          <div class="wizard-nav-spacer"></div>
          <button v-if="step < steps.length - 1" class="btn btn-secondary btn-skip" @click="skip">Ueberspringen</button>
          <button v-if="step < steps.length - 1" class="btn btn-primary" @click="next">
            {{ step === 0 ? 'Los geht\'s' : 'Weiter' }}
          </button>
          <button v-if="step === steps.length - 1" class="btn btn-primary" @click="finish">
            Setup beenden
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import {
  getSettings, updateSettings, validatePaths,
  getTraktAuthUrl, exchangeTraktCode, getTraktStatus,
  getPlexStatus, getPlexAuthPin, checkPlexAuthPin,
  getJellyfinStatus, testJellyfin,
  getPlexLibraryStatus, testPlexLibrary,
  getJDownloaderStatus, testJDownloader,
  runSync,
} from '../api/index';
import type { TraktStatus, ServiceStatus, JDStatus } from '../types/index';
import LoadingSpinner from './LoadingSpinner.vue';
import { Rocket } from 'lucide-vue-next';

const STORAGE_KEY = 'dlvault_setup_completed';

const emit = defineEmits<{ (e: 'close'): void }>();

const visible = ref(false);
const step = ref(0);
const settings = ref<Record<string, string>>({});

const steps = ['Willkommen', 'Watchlist', 'Media Server', 'JDownloader', '2Captcha', 'Verzeichnisse', 'Fertig'];

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

// --- Summary ---
const summary = computed(() => {
  const provider = settings.value['watchlist.provider'] || 'trakt';
  const watchlistOk = provider === 'plex' ? plexStatus.value.connected : traktStatus.value.authenticated;
  const libProvider = settings.value['library.provider'] || 'jellyfin';
  const mediaOk = libProvider === 'plex' ? plexLibStatus.value.connected : jellyfinStatus.value.connected;
  const captchaOk = !!settings.value['secret-store.2captcha-api-key'];
  const pathsOk = pathDefs.every(p => pathStatus.value[p.key] && !pathStatus.value[p.key]?.error);

  return [
    { label: 'Watchlist', ok: watchlistOk, badge: watchlistOk ? 'Verbunden' : 'Nicht verbunden' },
    { label: 'Media Server', ok: mediaOk, badge: mediaOk ? 'Verbunden' : 'Nicht verbunden' },
    { label: 'JDownloader', ok: jdStatus.value.connected, badge: jdStatus.value.connected ? 'Verbunden' : 'Nicht verbunden' },
    { label: '2Captcha', ok: captchaOk, badge: captchaOk ? 'Konfiguriert' : 'Optional' },
    { label: 'Verzeichnisse', ok: pathsOk, badge: pathsOk ? 'OK' : 'Problem' },
  ];
});

// --- Lifecycle ---
onMounted(async () => {
  if (localStorage.getItem(STORAGE_KEY)) return;
  try {
    const res = await getSettings();
    settings.value = res.data;
    if (!settings.value['library.provider']) settings.value['library.provider'] = 'jellyfin';
    if (!settings.value['watchlist.provider']) settings.value['watchlist.provider'] = 'trakt';
  } catch { /* empty */ }
  // Show wizard if no critical settings configured
  const hasWatchlist = settings.value['trakt.client_id'] || settings.value['plex.watchlist_token'];
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
async function saveSettings() {
  try {
    await updateSettings(settings.value);
  } catch { /* ignore */ }
}

async function next() {
  if (step.value > 0 && step.value < steps.length - 1) {
    await saveSettings();
  }
  // Load statuses when entering specific steps
  if (step.value === 0) {
    loadWatchlistStatus();
  } else if (step.value === 1) {
    loadMediaStatus();
  } else if (step.value === 2) {
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
  // Same as next but without save (except always save to preserve any partial input)
  next();
}

function finish() {
  localStorage.setItem(STORAGE_KEY, Date.now().toString());
  visible.value = false;
  emit('close');
}

// Public method to re-open wizard
function open() {
  step.value = 0;
  visible.value = true;
  loadAllStatuses();
}

defineExpose({ open });

// --- Trakt Auth ---
async function startTraktAuth() {
  await saveSettings();
  try {
    const res = await getTraktAuthUrl();
    traktAuthUrl.value = res.data.url;
    showTraktAuth.value = true;
  } catch { /* ignore */ }
}

async function exchangeCode() {
  try {
    await exchangeTraktCode(traktCode.value);
    showTraktAuth.value = false;
    traktCode.value = '';
    await loadWatchlistStatus();
  } catch { /* ignore */ }
}

// --- Plex Watchlist Auth ---
async function startPlexAuth() {
  try {
    const res = await getPlexAuthPin();
    const { pinId, authUrl } = res.data;
    if (plexPollTimer) clearInterval(plexPollTimer);
    plexAuthUrl.value = authUrl;
    plexAuthPolling.value = true;
    window.open(authUrl, '_blank');
    let attempts = 0;
    plexPollTimer = setInterval(async () => {
      attempts++;
      if (attempts > 40) {
        stopPlexPolling();
        return;
      }
      try {
        const check = await checkPlexAuthPin(pinId);
        if (check.data.success) {
          stopPlexPolling();
          const res = await getSettings();
          settings.value = res.data;
          await loadWatchlistStatus();
        }
      } catch { /* polling */ }
    }, 3000);
  } catch { /* ignore */ }
}

// --- Media Server Tests ---
async function testJellyfinConnection() {
  await saveSettings();
  try {
    const res = await testJellyfin();
    if (res.data.success) {
      jellyfinStatus.value = { connected: true, serverName: res.data.serverName || 'Jellyfin', movieCount: res.data.movieCount || 0 };
    }
  } catch {
    jellyfinStatus.value = { connected: false, serverName: '', movieCount: 0 };
  }
}

async function testPlexLibConnection() {
  await saveSettings();
  try {
    const res = await testPlexLibrary();
    if (res.data.success) {
      plexLibStatus.value = { connected: true, serverName: res.data.serverName || 'Plex', movieCount: res.data.movieCount || 0 };
    }
  } catch {
    plexLibStatus.value = { connected: false, serverName: '', movieCount: 0 };
  }
}

// --- JDownloader Test ---
async function testJDConnection() {
  await saveSettings();
  try {
    const res = await testJDownloader();
    if (res.data.success) {
      jdStatus.value = { configured: true, connected: true, devices: res.data.devices };
    }
  } catch {
    jdStatus.value = { configured: false, connected: false, devices: [] };
  }
}

// --- Paths ---
async function checkPathsNow() {
  try {
    const res = await validatePaths();
    pathStatus.value = res.data;
  } catch { /* ignore */ }
}

// --- Status loaders ---
async function loadWatchlistStatus() {
  const [traktRes, plexRes] = await Promise.all([
    getTraktStatus().catch(() => ({ data: { configured: false, authenticated: false, username: '' } })),
    getPlexStatus().catch(() => ({ data: { connected: false, username: '', movieCount: 0 } })),
  ]);
  traktStatus.value = traktRes.data;
  plexStatus.value = plexRes.data;
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

async function loadAllStatuses() {
  await Promise.all([loadWatchlistStatus(), loadMediaStatus(), loadJDStatus(), checkPathsNow()]);
}

async function refreshAllStatuses() {
  // Reload settings first to pick up any token changes
  try {
    const res = await getSettings();
    settings.value = res.data;
  } catch { /* ignore */ }
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
.path-check-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.path-check-item {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
}

.path-check-label {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  font-weight: 500;
  margin-bottom: 4px;
}

.path-check-value {
  font-family: monospace;
  font-size: var(--fs-base);
  color: var(--text-primary);
  margin-bottom: 6px;
}

.path-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
  padding: 4px 8px;
  border-radius: 4px;
}

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
