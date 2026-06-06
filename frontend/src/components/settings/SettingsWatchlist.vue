<template>
  <ConnectionHero
    v-if="primaryProvider === 'trakt'"
    name="Trakt.tv"
    mark="T"
    mark-color="#ed1c24"
    :tint="traktTint"
    :pill-state="traktPillState"
    :pill-label="traktPillLabel"
    :meta="traktMeta"
    open-url="https://trakt.tv/users/me"
  />
  <ConnectionHero
    v-else-if="primaryProvider === 'seerr'"
    name="Seerr"
    mark="JS"
    mark-color="#6366f1"
    :tint="seerrTint"
    :pill-state="seerrPillState"
    :pill-label="seerrPillLabel"
    :meta="seerrMeta"
    :open-url="settings['seerr.url'] || undefined"
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
  />

  <SettingsSection label="Quelle">
    <SettingsRow
      label="Watchlist-Provider"
      hint="<strong>Seerr</strong> empfohlen — Anfragen mit eigenen Benutzerkonten, Freigabe-Workflow, und als einziger Provider ohne Fremdkonto. Funktioniert unverändert auch mit den Vorgängern <em>Jellyseerr</em> und <em>Overseerr</em>. <strong>Trakt</strong> und <strong>Plex</strong> lesen deine dortige Watchlist. <strong>Beide</strong> nutzt Trakt und Plex parallel."
    >
      <Segments
        :model-value="settings['watchlist.provider'] || 'trakt'"
        @update:model-value="settings['watchlist.provider'] = $event"
        :options="[
          { value: 'seerr', label: 'Seerr' },
          { value: 'trakt', label: 'Trakt' },
          { value: 'plex',  label: 'Plex' },
          { value: 'both',  label: 'Beide' },
        ]"
      />
    </SettingsRow>
  </SettingsSection>

  <SettingsSection v-if="primaryProvider === 'trakt' || primaryProvider === 'both'" label="Trakt Authentication">
    <div class="setup-guide">
      <strong>Einrichtung:</strong>
      <ol>
        <li>Erstelle eine API-App auf <a href="https://trakt.tv/oauth/applications/new" target="_blank" rel="noopener">trakt.tv/oauth/applications/new</a></li>
        <li>Name frei wählbar. Redirect URI: <code>urn:ietf:wg:oauth:2.0:oob</code></li>
        <li>Client ID + Secret hier einfügen, speichern, dann „Autorisieren" klicken.</li>
      </ol>
    </div>

    <SettingsRow label="Client ID" required hint="Aus der API-App auf trakt.tv.">
      <input class="sx-input mono" type="text" placeholder="Client ID" v-model="settings['trakt.client_id']" />
    </SettingsRow>
    <SettingsRow label="Client Secret" required hint="Wird verschlüsselt gespeichert.">
      <SecretInput v-model="settings['trakt.client_secret']" setting-key="trakt.client_secret" placeholder="Client Secret" />
    </SettingsRow>
    <SettingsRow
      label="Autorisierung"
      hint="Nach dem Speichern hier den Pin-Flow starten."
    >
      <div class="auth-row">
        <button class="btn btn-secondary" type="button" @click="startTraktAuth">
          <ExternalLink :size="14" />
          <span>{{ traktStatus.authenticated ? 'Neu autorisieren' : 'Trakt autorisieren' }}</span>
        </button>
        <span v-if="traktStatus.authenticated" class="status-tag ok">
          <span class="dot"></span>{{ traktStatus.username ? '@' + traktStatus.username : 'verbunden' }}
        </span>
        <button
          v-if="traktStatus.configured"
          class="btn btn-ghost danger"
          type="button"
          :disabled="disconnecting === 'trakt'"
          @click="disconnect('trakt')"
        >
          <LoadingSpinner v-if="disconnecting === 'trakt'" inline />
          <Unplug v-else :size="14" />
          <span>Trennen</span>
        </button>
      </div>

      <div v-if="showTraktAuth" class="auth-flow">
        <p class="auth-flow-step">1. Öffne diesen Link und autorisiere die App:</p>
        <p class="auth-link">
          <a :href="traktAuthUrl" target="_blank" rel="noopener">{{ traktAuthUrl }}</a>
        </p>
        <p class="auth-flow-step">2. Gib den erhaltenen Pin-Code hier ein:</p>
        <div class="auth-row">
          <input
            class="sx-input mono"
            type="text"
            placeholder="Pin-Code"
            v-model="traktCode"
            style="max-width: 200px;"
          />
          <button class="btn btn-primary" type="button" @click="exchangeCode">
            <Check :size="14" />
            <span>Code einlösen</span>
          </button>
        </div>
      </div>
    </SettingsRow>
  </SettingsSection>

  <SettingsSection v-if="primaryProvider === 'plex' || primaryProvider === 'both'" label="Plex Authentication">
    <SettingsRow
      label="Plex-Konto verbinden"
      hint="Öffnet plex.tv im neuen Tab. Polling läuft, bis du den Zugriff bestätigt hast."
    >
      <div class="auth-row">
        <button class="btn btn-secondary" type="button" :disabled="plexAuthPolling" @click="startPlexAuth">
          <LoadingSpinner v-if="plexAuthPolling" inline />
          <ExternalLink v-else :size="14" />
          <span>{{ plexAuthPolling ? 'Warte auf Plex…' : (plexStatus.connected ? 'Neu verbinden' : 'Mit Plex verbinden') }}</span>
        </button>
        <span v-if="plexStatus.connected" class="status-tag ok">
          <span class="dot"></span>{{ plexStatus.username ? '@' + plexStatus.username : 'verbunden' }}
        </span>
        <button
          v-if="plexStatus.connected"
          class="btn btn-ghost danger"
          type="button"
          :disabled="disconnecting === 'plex'"
          @click="disconnect('plex')"
        >
          <LoadingSpinner v-if="disconnecting === 'plex'" inline />
          <Unplug v-else :size="14" />
          <span>Trennen</span>
        </button>
      </div>
      <div v-if="plexAuthUrl" class="auth-flow">
        <p class="auth-flow-step">Falls das Fenster nicht aufging:</p>
        <p class="auth-link"><a :href="plexAuthUrl" target="_blank" rel="noopener">{{ plexAuthUrl }}</a></p>
      </div>
    </SettingsRow>
  </SettingsSection>

  <SettingsSection v-if="primaryProvider === 'seerr'" label="Seerr">
    <div class="setup-guide">
      <strong>Einrichtung:</strong>
      <ol>
        <li>In Seerr (bzw. Jellyseerr/Overseerr) unter <em>Einstellungen &rarr; Allgemein</em> den API-Key kopieren.</li>
        <li>URL und Key hier eintragen, speichern, dann „Verbindung testen".</li>
        <li>Radarr/Sonarr braucht Seerr <strong>nicht</strong> — dlvault übernimmt diese Rolle.</li>
      </ol>
    </div>

    <SettingsRow label="Server-URL" required hint="Erreichbar aus dem dlvault-Container heraus, z.B. http://192.168.x.x:5055">
      <input class="sx-input mono" type="text" placeholder="http://seerr:5055" v-model="settings['seerr.url']" />
    </SettingsRow>
    <SettingsRow label="API-Key" required hint="Wird verschlüsselt gespeichert.">
      <SecretInput v-model="settings['seerr.api_key']" setting-key="seerr.api_key" placeholder="API-Key" />
    </SettingsRow>
    <SettingsRow label="Verbindung" hint="Bestätigte Anfragen werden übernommen; der Fortschritt wird nach Seerr zurückgemeldet.">
      <div class="auth-row">
        <button class="btn btn-secondary" type="button" :disabled="seerrTesting" @click="testSeerr">
          <LoadingSpinner v-if="seerrTesting" inline />
          <Check v-else :size="14" />
          <span>Verbindung testen</span>
        </button>
        <span v-if="seerrStatus.connected" class="status-tag ok">
          <span class="dot"></span>Version {{ seerrStatus.version }}
        </span>
        <button
          v-if="settings['seerr.url']"
          class="btn btn-ghost danger"
          type="button"
          :disabled="disconnecting === 'seerr'"
          @click="disconnect('seerr')"
        >
          <LoadingSpinner v-if="disconnecting === 'seerr'" inline />
          <Unplug v-else :size="14" />
          <span>Trennen</span>
        </button>
      </div>
    </SettingsRow>
  </SettingsSection>

  <SettingsSection v-if="primaryProvider === 'seerr'" label="Direktanbindung (Radarr/Sonarr-Ersatz)">
    <div class="setup-guide">
      <strong>Was das bringt:</strong>
      <ol>
        <li>Seerr <em>schiebt</em> Anfragen sofort zu dlvault, statt bis zu 2 Minuten auf den Abruf zu warten</li>
        <li>Eine Freigabe loest den Abgleich <strong>binnen einer Sekunde</strong> aus (Webhook)</li>
        <li>Du kannst pro Anfrage die <strong>Qualität</strong> wählen (2160p/1080p/720p/480p)</li>
        <li><strong>Override Rules</strong> funktionieren — z.B. Genre „Animation" in die Kinder-Bibliothek</li>
        <li>Der Fortschritt erscheint in Seerrs eigener Anzeige</li>
      </ol>
    </div>

    <SettingsRow
      label="dlvault-Adresse"
      hint="So erreicht <em>Seerr</em> den dlvault-Container — nicht die Adresse aus deinem Browser. Bei beiden im selben Docker-Netz z.B. http://dlvault:3000"
    >
      <input class="sx-input mono" type="text" placeholder="http://192.168.x.x:3000" v-model="arrBaseUrl" />
    </SettingsRow>

    <SettingsRow
      label="Eintragen"
      hint="dlvault traegt sich selbst als Radarr- und Sonarr-Server in Seerr ein. Ein erneuter Klick ersetzt die Eintraege, statt sie zu verdoppeln."
    >
      <div class="auth-row">
        <button
          class="btn btn-primary"
          type="button"
          :disabled="arrBusy || !arrBaseUrl || !seerrStatus.connected"
          @click="registerArr"
        >
          <LoadingSpinner v-if="arrBusy" inline />
          <Check v-else :size="14" />
          <span>In Seerr eintragen</span>
        </button>
        <span v-if="settings['arr.enabled'] === 'true'" class="status-tag ok">
          <span class="dot"></span>aktiv
        </span>
        <span v-if="settings['seerr.webhook_enabled'] === 'true'" class="status-tag ok">
          <span class="dot"></span>Sofortmeldung
        </span>
      </div>
      <p v-if="!seerrStatus.connected" class="auth-flow-step">
        Erst oben die Seerr-Verbindung testen.
      </p>
    </SettingsRow>

    <SettingsRow
      label="Problemmeldungen bearbeiten"
      hint="Meldet jemand in Seerr <em>Bild</em>, <em>Ton</em> oder <em>Untertitel</em> als fehlerhaft, sperrt dlvault das vorhandene Release und sucht ein anderes. Betrifft genau die gemeldete Staffel bzw. Episode. Antwort und Abschluss erfolgen in der Meldung selbst. <strong>Lädt Dateien neu herunter</strong> — daher standardmäßig aus."
    >
      <Toggle
        :model-value="settings['seerr.issues_enabled'] === 'true'"
        @update:model-value="settings['seerr.issues_enabled'] = $event ? 'true' : 'false'"
      />
    </SettingsRow>
  </SettingsSection>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  getTraktAuthUrl, exchangeTraktCode, getTraktStatus,
  getPlexStatus, getPlexAuthPin, checkPlexAuthPin,
  getSeerrStatus, testSeerr_api, disconnectWatchlistProvider, registerArrInSeerr,
} from '../../api/index';
import type { TraktStatus, ServiceStatus } from '../../types/index';
import { useSettingsContext } from '../../composables/useSettingsContext';
import { useToast } from '../../composables/useApp';
import LoadingSpinner from '../LoadingSpinner.vue';
import ConnectionHero from './ConnectionHero.vue';
import SettingsSection from './SettingsSection.vue';
import SecretInput from './SecretInput.vue';
import SettingsRow from './SettingsRow.vue';
import Segments from './Segments.vue';
import Toggle from './Toggle.vue';
import { ExternalLink, Check, Unplug } from 'lucide-vue-next';

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

const primaryProvider = computed(() => settings.value['watchlist.provider'] || 'trakt');

const LABELS: Record<string, string> = { trakt: 'Trakt', plex: 'Plex', seerr: 'Seerr' };
const disconnecting = ref('');

// ── Direktanbindung ────────────────────────────────────────
const arrBaseUrl = ref('');
const arrBusy = ref(false);

async function registerArr() {
  arrBusy.value = true;
  try {
    const res = await registerArrInSeerr(arrBaseUrl.value.trim());
    await loadSettings();
    // The webhook is a bonus, not a precondition — say so rather than implying
    // the whole registration failed when only the push channel did.
    toast.value?.add(
      res.data?.webhook
        ? 'dlvault ist in Seerr eingetragen — Anfragen kommen ab jetzt sofort an'
        : `In Seerr eingetragen. Sofortmeldung nicht eingerichtet${res.data?.webhookError ? ': ' + res.data.webhookError : ''} — der 2-Minuten-Abruf greift weiterhin.`,
      res.data?.webhook ? 'success' : 'warning',
    );
  } catch (e: any) {
    toast.value?.add(e?.response?.data?.error || 'Eintragen fehlgeschlagen', 'error');
  } finally {
    arrBusy.value = false;
  }
}

/**
 * Clears a provider's stored credentials. Switching the provider selector only
 * decides which one runs — the tokens stay behind, which is how a dead Trakt app
 * kept its credentials in the database.
 */
async function disconnect(provider: string) {
  const label = LABELS[provider] || provider;
  if (!confirm(`${label} trennen? Die gespeicherten Zugangsdaten werden gelöscht.`)) return;
  disconnecting.value = provider;
  try {
    const res = await disconnectWatchlistProvider(provider);
    await loadSettings();
    await loadStatuses();
    const to = res.data?.switchedTo;
    toast.value?.add(
      to ? `${label} getrennt — aktiver Provider ist jetzt ${LABELS[to] || to}` : `${label} getrennt`,
      'success',
    );
  } catch (e: any) {
    toast.value?.add(e?.response?.data?.error || `${label} konnte nicht getrennt werden`, 'error');
  } finally {
    disconnecting.value = '';
  }
}

// ── Seerr ─────────────────────────────────────────────
interface SeerrStatus { connected: boolean; version: string; error?: string; authFailure?: { status: number } | null }
const seerrStatus = ref<SeerrStatus>({ connected: false, version: '' });
const seerrTesting = ref(false);

async function loadSeerrStatus() {
  if (primaryProvider.value !== 'seerr') return;
  try {
    const res = await getSeerrStatus();
    seerrStatus.value = res.data;
  } catch {
    seerrStatus.value = { connected: false, version: '' };
  }
}

async function testSeerr() {
  seerrTesting.value = true;
  try {
    // Save first — the backend tests what is stored, not what is typed.
    await saveAll();
    const res = await testSeerr_api();
    seerrStatus.value = { connected: true, version: res.data?.version || '' };
    toast.value?.add(`Seerr ${res.data?.version || ''} verbunden`, 'success');
  } catch (e: any) {
    seerrStatus.value = { connected: false, version: '' };
    toast.value?.add(e?.response?.data?.error || 'Seerr nicht erreichbar', 'error');
  } finally {
    seerrTesting.value = false;
  }
}

const seerrPillState = computed<'ok' | 'err' | 'na'>(() => {
  if (seerrStatus.value.connected) return 'ok';
  if (settings.value['seerr.url']) return 'err';
  return 'na';
});
const seerrPillLabel = computed(() => {
  if (seerrStatus.value.connected) return 'Verbunden';
  if (seerrStatus.value.authFailure) return 'API-Key abgelehnt';
  if (settings.value['seerr.url']) return 'Nicht erreichbar';
  return 'Nicht konfiguriert';
});
const seerrTint = computed(() => {
  if (seerrStatus.value.connected) return 'var(--ok)';
  if (settings.value['seerr.url']) return 'var(--warn)';
  return 'var(--text-3)';
});
const seerrMeta = computed(() => {
  const out: { lbl: string; val: string }[] = [];
  if (seerrStatus.value.version) out.push({ lbl: 'Version', val: seerrStatus.value.version });
  if (seerrStatus.value.authFailure) out.push({ lbl: 'Fehler', val: `HTTP ${seerrStatus.value.authFailure.status}` });
  else if (seerrStatus.value.error) out.push({ lbl: 'Status', val: seerrStatus.value.error });
  return out;
});

// ── Trakt ConnectionHero state ─────────────────────────────
const traktPillState = computed<'ok' | 'err' | 'na'>(() => {
  if (traktStatus.value.authenticated) return 'ok';
  if (traktStatus.value.configured)    return 'err';
  return 'na';
});
const traktPillLabel = computed(() => {
  if (traktStatus.value.authenticated) return 'Verbunden';
  if (traktStatus.value.configured)    return 'Nicht autorisiert';
  return 'Nicht konfiguriert';
});
const traktTint = computed(() => {
  if (traktStatus.value.authenticated) return 'var(--ok)';
  if (traktStatus.value.configured)    return 'var(--warn)';
  return 'var(--text-3)';
});
const traktMeta = computed(() => {
  const out: { lbl: string; val: string }[] = [];
  if (traktStatus.value.username) out.push({ lbl: 'Benutzer', val: '@' + traktStatus.value.username });
  if (traktStatus.value.configured) out.push({ lbl: 'Client ID', val: 'gesetzt' });
  if (!traktStatus.value.configured) out.push({ lbl: 'Status', val: 'Client ID/Secret fehlt' });
  return out;
});

// ── Plex ConnectionHero state ──────────────────────────────
const plexPillState = computed<'ok' | 'na'>(() => plexStatus.value.connected ? 'ok' : 'na');
const plexPillLabel = computed(() => plexStatus.value.connected ? 'Verbunden' : 'Nicht verbunden');
const plexTint = computed(() => plexStatus.value.connected ? 'var(--ok)' : 'var(--text-3)');
const plexMeta = computed(() => {
  const out: { lbl: string; val: string }[] = [];
  if (plexStatus.value.username) out.push({ lbl: 'Benutzer', val: '@' + plexStatus.value.username });
  if (plexStatus.value.movieCount) out.push({ lbl: 'Filme', val: String(plexStatus.value.movieCount) });
  return out;
});

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
  await loadSeerrStatus();
}

onMounted(loadStatuses);

onBeforeUnmount(() => {
  if (plexPollTimer) clearInterval(plexPollTimer);
});
</script>

<style scoped>
.setup-guide {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 12px 14px;
  margin-bottom: 14px;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.55;
}
.setup-guide strong { color: var(--text-primary); font-weight: 600; }
.setup-guide ol { margin: 6px 0 0 20px; padding: 0; }
.setup-guide a { color: var(--accent); text-decoration: none; }
.setup-guide a:hover { text-decoration: underline; }
.setup-guide code {
  font-family: var(--font-mono);
  background: var(--surface);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
  color: var(--text-secondary);
}

.auth-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent);
  background: color-mix(in srgb, var(--ok) 8%, transparent);
  color: var(--ok);
}
.status-tag .dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}

.auth-flow {
  margin-top: 10px;
  padding: 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}
.auth-flow-step {
  font-size: 12.5px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.auth-flow-step:not(:first-child) { margin-top: 10px; }
.auth-link {
  font-family: var(--font-mono);
  font-size: 11.5px;
  margin-bottom: 4px;
  word-break: break-all;
}
.auth-link a { color: var(--accent); text-decoration: none; }
.auth-link a:hover { text-decoration: underline; }
</style>
