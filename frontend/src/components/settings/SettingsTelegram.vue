<template>
  <!-- Telegram Bot -->
  <details class="card settings-section" open>
    <summary class="card-toggle"><h2>Telegram Film-Bot</h2></summary>
    <p class="section-hint">
      Freunde und Familie koennen per Telegram-Chat Filme anfragen.
      Einfach dem Bot den Filmnamen schreiben - fertig.
    </p>
    <div class="form-grid">
      <div class="form-group full-col">
        <label class="toggle-row">
          <span>Telegram-Bot aktiv</span>
          <span class="toggle-switch" :class="{ active: settings['telegram.enabled'] === 'true' }" @click="settings['telegram.enabled'] = settings['telegram.enabled'] === 'true' ? 'false' : 'true'" tabindex="0" @keydown.enter.prevent="settings['telegram.enabled'] = settings['telegram.enabled'] === 'true' ? 'false' : 'true'" role="switch" :aria-checked="settings['telegram.enabled'] === 'true'">
            <span class="toggle-knob" />
          </span>
        </label>
      </div>
      <div class="form-group full-col">
        <label for="telegram-token">Bot Token <span class="required">*</span></label>
        <input id="telegram-token" v-model="settings['telegram.bot_token']" type="password" placeholder="123456:ABC-DEF..." />
        <small class="form-hint">
          Erstelle einen Bot bei <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> auf Telegram.
          Schreibe ihm <code>/newbot</code>, vergib einen Namen, und kopiere den Token hier rein.
        </small>
      </div>
      <div class="form-group full-col">
        <label for="telegram-chat-ids">Erlaubte Chat-IDs <small class="text-secondary">(optional - Zugriffsbeschraenkung)</small></label>
        <input id="telegram-chat-ids" v-model="settings['telegram.allowed_chat_ids']" placeholder="123456789, 987654321" />
        <small class="form-hint">
          Kommagetrennte Liste von Telegram Chat-IDs, die den Bot nutzen duerfen.
          Eigene Chat-ID findest du bei <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a>.
        </small>
      </div>
      <div class="form-group full-col">
        <label for="omdb-key">OMDb API Key <small class="text-secondary">(fuer Poster, Kalender &amp; Filmsuche)</small></label>
        <input id="omdb-key" v-model="settings['omdb.api_key']" type="password" placeholder="OMDb API Key" />
        <small class="form-hint">
          Kostenlos auf <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener">omdbapi.com</a> registrieren.
          Wird fuer Film-Poster, Kalender-Release-Daten und Telegram-Filmsuche verwendet.
        </small>
      </div>
    </div>
    <div class="settings-action-row">
      <button class="btn btn-secondary" @click="testOmdbConnection" :disabled="testingOmdb">
        <LoadingSpinner v-if="testingOmdb" inline />
        {{ testingOmdb ? 'Teste...' : 'OMDb testen' }}
      </button>
      <span v-if="omdbStatus === 'ok'" class="badge badge-found">Verbunden</span>
      <span v-else-if="omdbStatus === 'error'" class="badge badge-not_found">Fehler</span>
      <span v-else-if="settings['omdb.api_key'] && settings['omdb.api_key'] !== '' && settings['omdb.api_key'] !== '••••••••'" class="badge badge-pending">Nicht getestet</span>
      <span v-else class="badge badge-not_found">Nicht konfiguriert</span>
    </div>
    <div v-if="telegramUnrestricted" class="warning-banner">
      ⚠️ <strong>Achtung:</strong> Der Bot ist oeffentlich zugaenglich — jeder der den Bot findet kann Downloads ausloesen.
      Trage oben erlaubte Chat-IDs ein um den Zugriff einzuschraenken.
    </div>
    <div class="settings-action-row">
      <button class="btn btn-secondary" @click="testTelegramConnection" :disabled="testingTelegram">
        <LoadingSpinner v-if="testingTelegram" inline />
        {{ testingTelegram ? 'Teste...' : 'Verbindung testen' }}
      </button>
      <span v-if="telegramStatus === 'ok'" class="badge badge-found">Verbunden ({{ telegramBotName }})</span>
      <span v-else-if="telegramStatus === 'error'" class="badge badge-not_found">Fehler</span>
      <span v-else-if="settings['telegram.bot_token'] && settings['telegram.bot_token'] !== '' && settings['telegram.bot_token'] !== '••••••••'" class="badge badge-pending">Nicht getestet</span>
      <span v-else class="badge badge-not_found">Nicht konfiguriert</span>
    </div>
  </details>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import api from '../../api/index';
import { useSettingsContext } from '../../composables/useSettingsContext';
import { useToast } from '../../composables/useApp';
import LoadingSpinner from '../LoadingSpinner.vue';

const { settings, saveAll } = useSettingsContext();
const toast = useToast();

const testingTelegram = ref(false);
const telegramStatus = ref<'ok' | 'error' | ''>('');
const telegramBotName = ref('');

const testingOmdb = ref(false);
const omdbStatus = ref<'ok' | 'error' | ''>('');

const telegramUnrestricted = computed(() =>
  settings.value['telegram.enabled'] === 'true' &&
  settings.value['telegram.bot_token'] &&
  settings.value['telegram.bot_token'] !== '' &&
  !settings.value['telegram.allowed_chat_ids']
);

async function testOmdbConnection() {
  await saveAll();
  testingOmdb.value = true;
  omdbStatus.value = '';
  try {
    const res = await api.post('/settings/omdb/test');
    if (res.data.success) {
      omdbStatus.value = 'ok';
      toast.value?.add('OMDb Verbindung erfolgreich', 'success');
    } else {
      omdbStatus.value = 'error';
      toast.value?.add(res.data.error || 'OMDb Verbindung fehlgeschlagen', 'error');
    }
  } catch (e: unknown) {
    omdbStatus.value = 'error';
    const axiosErr = e as { response?: { data?: { error?: string } } };
    toast.value?.add(axiosErr.response?.data?.error || 'OMDb Verbindung fehlgeschlagen', 'error');
  } finally {
    testingOmdb.value = false;
  }
}

async function testTelegramConnection() {
  await saveAll();
  testingTelegram.value = true;
  telegramStatus.value = '';
  try {
    const res = await api.post('/settings/telegram/test');
    if (res.data.success) {
      telegramStatus.value = 'ok';
      telegramBotName.value = '@' + res.data.botName;
      toast.value?.add(`Telegram Bot verbunden: @${res.data.botName}`, 'success');
    } else {
      telegramStatus.value = 'error';
    }
  } catch (e: unknown) {
    telegramStatus.value = 'error';
    const axiosErr = e as { response?: { data?: { error?: string } } };
    toast.value?.add(axiosErr.response?.data?.error || 'Telegram Verbindung fehlgeschlagen', 'error');
  } finally {
    testingTelegram.value = false;
  }
}
</script>

<style scoped>
.text-secondary {
  color: var(--text-secondary);
}

a {
  color: var(--accent);
}

code {
  background: var(--bg-primary);
  padding: 2px 6px;
  border-radius: 4px;
}

.warning-banner {
  background: rgba(255, 170, 0, 0.12);
  border: 1px solid rgba(255, 170, 0, 0.3);
  border-radius: 8px;
  padding: 10px 14px;
  margin: 8px 0;
  font-size: 0.9rem;
  color: var(--text-primary);
  line-height: 1.5;
}
</style>
