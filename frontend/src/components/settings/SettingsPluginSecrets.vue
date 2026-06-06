<template>
  <SettingsSection label="Plugin-Secrets">
    <p class="intro">
      Geteilte Zugangsdaten für externe Dienste, die von einem oder mehreren installierten Plugins benötigt werden.
      Jeder Eintrag wird einmal konfiguriert und steht allen Plugins zur Verfügung, die ihn anfordern.
      Werte werden verschlüsselt gespeichert.
    </p>

    <p v-if="loading" class="empty-hint">Lade…</p>
    <p v-else-if="secrets.length === 0" class="empty-hint">
      Keine installierten Plugins fordern aktuell Secrets an.
    </p>

    <template v-else>
      <SettingsRow
        v-for="s in secrets"
        :key="s.key"
        :label="s.label"
        :hint="hintFor(s)"
      >
        <SecretInput v-model="settings[storageKey(s.key)]" />
      </SettingsRow>
    </template>
  </SettingsSection>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { listPluginSecrets, type AggregatedSecret } from '../../api/index';
import { useSettingsContext } from '../../composables/useSettingsContext';
import SettingsSection from './SettingsSection.vue';
import SettingsRow from './SettingsRow.vue';
import SecretInput from './SecretInput.vue';

const { settings } = useSettingsContext();

const secrets = ref<AggregatedSecret[]>([]);
const loading = ref(true);

const STORAGE_PREFIX = 'secret-store.';

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

function hintFor(s: AggregatedSecret): string {
  const requested = s.requestedBy.map(p => p.name).join(', ');
  const desc = s.description ? `${s.description}<br />` : '';
  return `${desc}<strong>Angefordert von:</strong> ${requested}`;
}

async function load() {
  try {
    const res = await listPluginSecrets();
    secrets.value = res.data.secrets;
  } catch (err) {
    console.error('Failed to load plugin secrets:', err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.intro {
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.55;
  margin-bottom: 12px;
}
.empty-hint {
  font-size: 13px;
  color: var(--text-3);
  font-style: italic;
  padding: 12px 0;
}

</style>
