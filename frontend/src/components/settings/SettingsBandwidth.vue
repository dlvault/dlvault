<template>
  <details class="card settings-section" open>
    <summary class="card-toggle"><h2>Bandbreiten-Zeitplan</h2></summary>
    <p class="section-hint">
      Download-Geschwindigkeit nach Tageszeit begrenzen.
    </p>
    <div class="form-grid">
      <div class="form-group">
        <label class="toggle-row">
          <span>Zeitplan aktiv</span>
          <span class="toggle-switch" :class="{ active: settings['bandwidth.schedule_enabled'] === 'true' }" @click="settings['bandwidth.schedule_enabled'] = settings['bandwidth.schedule_enabled'] === 'true' ? 'false' : 'true'" tabindex="0" @keydown.enter.prevent="settings['bandwidth.schedule_enabled'] = settings['bandwidth.schedule_enabled'] === 'true' ? 'false' : 'true'" role="switch" :aria-checked="settings['bandwidth.schedule_enabled'] === 'true'">
            <span class="toggle-knob" />
          </span>
        </label>
      </div>
      <div class="form-group">
        <label for="bw-day-limit">Tageslimit (KB/s) <small class="text-secondary">0 = unbegrenzt</small></label>
        <input
          id="bw-day-limit"
          v-model="settings['bandwidth.day_limit_kbps']"
          type="number"
          min="0"
          placeholder="z.B. 5000"
          :disabled="settings['bandwidth.schedule_enabled'] !== 'true'"
        />
      </div>
      <div class="form-group">
        <label for="bw-night-limit">Nachtlimit (KB/s) <small class="text-secondary">0 = unbegrenzt</small></label>
        <input
          id="bw-night-limit"
          v-model="settings['bandwidth.night_limit_kbps']"
          type="number"
          min="0"
          placeholder="z.B. 0"
          :disabled="settings['bandwidth.schedule_enabled'] !== 'true'"
        />
      </div>
      <div class="form-group">
        <label for="bw-day-start">Tag beginnt um</label>
        <input
          id="bw-day-start"
          v-model="settings['bandwidth.day_start_hour']"
          type="number"
          min="0"
          max="23"
          placeholder="8"
          :disabled="settings['bandwidth.schedule_enabled'] !== 'true'"
        />
      </div>
      <div class="form-group">
        <label for="bw-night-start">Nacht beginnt um</label>
        <input
          id="bw-night-start"
          v-model="settings['bandwidth.night_start_hour']"
          type="number"
          min="0"
          max="23"
          placeholder="23"
          :disabled="settings['bandwidth.schedule_enabled'] !== 'true'"
        />
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { useSettingsContext } from '../../composables/useSettingsContext';

const { settings } = useSettingsContext();
</script>

<style scoped>
.text-secondary {
  color: var(--text-secondary);
}
</style>
