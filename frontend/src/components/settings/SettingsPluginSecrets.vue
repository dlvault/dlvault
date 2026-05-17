<template>
  <details class="card settings-section" open>
    <summary class="card-toggle"><h2>Plugin-Secrets</h2></summary>
    <p class="section-hint">
      Geteilte Zugangsdaten für externe Dienste, die von einem oder mehreren
      installierten Plugins benötigt werden. Jeder Eintrag wird einmal
      konfiguriert und steht allen Plugins zur Verfügung, die ihn anfordern.
      Werte werden verschlüsselt gespeichert.
    </p>

    <div v-if="loading" class="muted">Lade…</div>
    <div v-else-if="secrets.length === 0" class="muted">
      Keine installierten Plugins fordern aktuell Secrets an.
    </div>

    <div v-else class="secrets-list">
      <div v-for="s in secrets" :key="s.key" class="form-group">
        <label :for="`secret-${s.key}`">{{ s.label }}</label>
        <input
          :id="`secret-${s.key}`"
          v-model="settings[storageKey(s.key)]"
          type="password"
          autocomplete="off"
          placeholder="API key / token"
        />
        <p v-if="s.description" class="hint-text">{{ s.description }}</p>
        <p class="requested-by">
          Angefordert von:
          <span v-for="(p, i) in s.requestedBy" :key="p.id">
            <strong>{{ p.name }}</strong><span v-if="i < s.requestedBy.length - 1">, </span>
          </span>
        </p>
        <span v-if="s.configured && !isPlaceholder(settings[storageKey(s.key)])" class="badge badge-found badge-mt">
          Konfiguriert
        </span>
        <span v-else-if="!s.configured" class="badge badge-not_found badge-mt">Fehlt</span>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { listPluginSecrets, type AggregatedSecret } from '../../api/index';
import { useSettingsContext } from '../../composables/useSettingsContext';

const { settings } = useSettingsContext();

const secrets = ref<AggregatedSecret[]>([]);
const loading = ref(true);

const STORAGE_PREFIX = 'secret-store.';

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

// The /api/settings GET endpoint masks sensitive values with bullets. Treat
// the masked placeholder as "not changed by the user" — saving it back would
// overwrite the real value with a string of bullets.
function isPlaceholder(value: string | undefined): boolean {
  return !value || /^[•]+$/.test(value);
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
.secrets-list .form-group + .form-group {
  margin-top: 1.25rem;
}
.hint-text {
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin-top: 0.25rem;
}
.requested-by {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-top: 0.25rem;
}
.muted {
  color: var(--text-secondary);
  font-style: italic;
}
</style>
