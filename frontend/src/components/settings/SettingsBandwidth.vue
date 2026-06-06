<template>
  <SettingsSection label="Zeitplan">
    <SettingsRow
      label="Zeitplan aktiv"
      hint="Wenn aus, läuft JDownloader ohne Geschwindigkeitsbegrenzung."
      toggle
    >
      <Toggle :model-value="enabled" @update:model-value="setEnabled" />
    </SettingsRow>
  </SettingsSection>

  <SettingsSection label="Limits">
    <SettingsRow
      label="Tageslimit"
      hint="In KB/s. <code>0</code> = unbegrenzt."
    >
      <div class="num-with-unit">
        <input
          class="sx-input"
          type="number"
          min="0"
          placeholder="z.B. 5000"
          v-model="settings['bandwidth.day_limit_kbps']"
          :disabled="!enabled"
        />
        <span class="unit">KB/s</span>
      </div>
    </SettingsRow>
    <SettingsRow
      label="Nachtlimit"
      hint="In KB/s. <code>0</code> = unbegrenzt."
    >
      <div class="num-with-unit">
        <input
          class="sx-input"
          type="number"
          min="0"
          placeholder="z.B. 0"
          v-model="settings['bandwidth.night_limit_kbps']"
          :disabled="!enabled"
        />
        <span class="unit">KB/s</span>
      </div>
    </SettingsRow>
  </SettingsSection>

  <SettingsSection label="Tag/Nacht-Wechsel">
    <SettingsRow label="Tag beginnt um" hint="Stunde (0–23) — ab dann gilt das Tageslimit.">
      <div class="num-with-unit">
        <input
          class="sx-input mono"
          type="number"
          min="0"
          max="23"
          placeholder="8"
          v-model="settings['bandwidth.day_start_hour']"
          :disabled="!enabled"
        />
        <span class="unit">Uhr</span>
      </div>
    </SettingsRow>
    <SettingsRow label="Nacht beginnt um" hint="Stunde (0–23) — ab dann gilt das Nachtlimit.">
      <div class="num-with-unit">
        <input
          class="sx-input mono"
          type="number"
          min="0"
          max="23"
          placeholder="23"
          v-model="settings['bandwidth.night_start_hour']"
          :disabled="!enabled"
        />
        <span class="unit">Uhr</span>
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

const { settings } = useSettingsContext();

const enabled = computed(() => settings.value['bandwidth.schedule_enabled'] === 'true');
function setEnabled(v: boolean) {
  settings.value['bandwidth.schedule_enabled'] = v ? 'true' : 'false';
}
</script>

<style scoped>
.num-with-unit {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 200px;
}
.num-with-unit .sx-input { flex: 1; }
.unit {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-3);
}
</style>
