<template>
  <SettingsSection label="Auto-Sync">
    <SettingsRow
      label="Aktiviert"
      hint="Wenn aus, läuft kein automatischer Sync — du musst manuell auslösen."
      toggle
    >
      <Toggle :model-value="enabled" @update:model-value="setEnabled" />
    </SettingsRow>
    <SettingsRow
      label="Intervall"
      hint="Wie oft soll dlvault die Watchlist abgleichen?"
    >
      <div class="interval-field">
        <Segments
          :model-value="intervalSegment"
          @update:model-value="setIntervalSegment"
          :options="INTERVAL_PRESETS"
        />
        <div v-if="customInterval" class="custom-hint">
          Aktuell <strong>{{ customInterval }}h</strong> — wähle ein Preset oder lass den Wert wie er ist.
        </div>
      </div>
    </SettingsRow>
  </SettingsSection>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsContext } from '../../composables/useSettingsContext';
import SettingsSection from './SettingsSection.vue';
import SettingsRow from './SettingsRow.vue';
import Toggle from './Toggle.vue';
import Segments from './Segments.vue';

const { settings } = useSettingsContext();

const INTERVAL_PRESETS: { value: string; label: string }[] = [
  { value: '1',  label: '1 h' },
  { value: '3',  label: '3 h' },
  { value: '6',  label: '6 h' },
  { value: '12', label: '12 h' },
  { value: '24', label: '24 h' },
];

const enabled = computed(() => settings.value['scheduler.enabled'] === 'true');
function setEnabled(v: boolean) {
  settings.value['scheduler.enabled'] = v ? 'true' : 'false';
}

const intervalSegment = computed<string>(() => {
  const v = settings.value['scheduler.interval_hours'] || '24';
  return INTERVAL_PRESETS.some(p => p.value === v) ? v : '';
});
function setIntervalSegment(v: string) {
  settings.value['scheduler.interval_hours'] = v;
}

// If saved value isn't one of the presets, show a "currently X" hint so the
// user knows the segment row isn't broken — their custom value is intact.
const customInterval = computed(() => {
  const v = settings.value['scheduler.interval_hours'];
  return v && !INTERVAL_PRESETS.some(p => p.value === v) ? v : null;
});
</script>

<style scoped>
.interval-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.custom-hint {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
}
.custom-hint strong { color: var(--text-secondary); font-weight: 600; }
</style>
