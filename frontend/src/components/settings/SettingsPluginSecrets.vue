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
        <input
          class="sx-input mono"
          type="password"
          autocomplete="off"
          placeholder="API key / token"
          v-model="settings[storageKey(s.key)]"
        />
        <div v-if="statusTag(s)" :class="['status-tag', statusTag(s)!.tone]">
          <span class="dot"></span>{{ statusTag(s)!.label }}
        </div>
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

const { settings } = useSettingsContext();

const secrets = ref<AggregatedSecret[]>([]);
const loading = ref(true);

const STORAGE_PREFIX = 'secret-store.';

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

function isPlaceholder(value: string | undefined): boolean {
  return !value || /^[•]+$/.test(value);
}

function hintFor(s: AggregatedSecret): string {
  const requested = s.requestedBy.map(p => p.name).join(', ');
  const desc = s.description ? `${s.description}<br />` : '';
  return `${desc}<strong>Angefordert von:</strong> ${requested}`;
}

function statusTag(s: AggregatedSecret): { tone: 'ok' | 'warn'; label: string } | null {
  if (s.configured && !isPlaceholder(settings.value[storageKey(s.key)])) {
    return { tone: 'ok', label: 'Konfiguriert' };
  }
  if (!s.configured) {
    return { tone: 'warn', label: 'Fehlt' };
  }
  return null;
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
.status-tag.warn {
  color: var(--warn);
  border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
  background: color-mix(in srgb, var(--warn) 8%, transparent);
}
</style>
