<template>
  <SettingsSection label="OMDb (Film-Metadaten)">
    <div class="info-note">
      Genutzt für Film-Poster, Kalender-Releases und Telegram-Filmsuche.
      Kostenlos auf <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener">omdbapi.com</a> registrieren.
    </div>
    <SettingsRow label="OMDb API Key" hint="Wird verschlüsselt gespeichert.">
      <div class="row-action">
        <SecretInput v-model="settings['omdb.api_key']" placeholder="OMDb API Key" optional />
        <button class="btn btn-ghost" type="button" :disabled="testingOmdb" @click="testOmdbConnection">
          <LoadingSpinner v-if="testingOmdb" inline />
          <RefreshCw v-else :size="14" />
          <span>{{ testingOmdb ? 'Teste…' : 'OMDb testen' }}</span>
        </button>
      </div>
      <div v-if="omdbStatus" :class="['status-tag', omdbStatus === 'ok' ? 'ok' : 'err']">
        <span class="dot"></span>
        {{ omdbStatus === 'ok' ? 'Verbunden' : 'Fehler' }}
      </div>
    </SettingsRow>
  </SettingsSection>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import api from '../../api/index';
import { useSettingsContext } from '../../composables/useSettingsContext';
import { useToast } from '../../composables/useApp';
import LoadingSpinner from '../LoadingSpinner.vue';
import SettingsSection from './SettingsSection.vue';
import SettingsRow from './SettingsRow.vue';
import SecretInput from './SecretInput.vue';
import { RefreshCw } from 'lucide-vue-next';

const { settings, saveAll } = useSettingsContext();
const toast = useToast();

const testingOmdb = ref(false);
const omdbStatus = ref<'ok' | 'error' | ''>('');

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
</script>

<style scoped>
.row-action {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.row-action .sx-input { flex: 1; min-width: 0; }

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

.status-tag {
  margin-top: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}
.status-tag .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.status-tag.ok {
  color: var(--ok);
  border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent);
  background: color-mix(in srgb, var(--ok) 8%, transparent);
}
.status-tag.ok .dot { box-shadow: 0 0 6px currentColor; }
.status-tag.err {
  color: var(--err);
  border: 1px solid color-mix(in srgb, var(--err) 30%, transparent);
  background: color-mix(in srgb, var(--err) 8%, transparent);
}
</style>
