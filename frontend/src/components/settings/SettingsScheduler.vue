<template>
  <details class="card settings-section" open>
    <summary class="card-toggle"><h2>Scheduler</h2></summary>
    <div class="form-grid">
      <div class="form-group">
        <label class="toggle-row">
          <span>Scheduler aktiv</span>
          <span class="toggle-switch" :class="{ active: settings['scheduler.enabled'] === 'true' }" @click="settings['scheduler.enabled'] = settings['scheduler.enabled'] === 'true' ? 'false' : 'true'" tabindex="0" @keydown.enter.prevent="settings['scheduler.enabled'] = settings['scheduler.enabled'] === 'true' ? 'false' : 'true'" role="switch" :aria-checked="settings['scheduler.enabled'] === 'true'">
            <span class="toggle-knob" />
          </span>
        </label>
      </div>
      <div class="form-group">
        <label for="scheduler-interval">Prüfintervall (Stunden) <small class="text-secondary">1-168</small></label>
        <input
          id="scheduler-interval"
          v-model="settings['scheduler.interval_hours']"
          type="number"
          min="1"
          max="168"
          @blur="validateInterval"
          :class="{ 'input-error': errors['scheduler.interval_hours'] }"
        />
        <span v-if="errors['scheduler.interval_hours']" class="field-error">{{ errors['scheduler.interval_hours'] }}</span>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { useSettingsContext } from '../../composables/useSettingsContext';

const { settings, errors } = useSettingsContext();

function validateInterval() {
  const val = Number(settings.value['scheduler.interval_hours']);
  if (val && (val < 1 || val > 168)) {
    errors.value['scheduler.interval_hours'] = 'Wert muss zwischen 1 und 168 liegen';
  } else {
    delete errors.value['scheduler.interval_hours'];
  }
}
</script>

<style scoped>
.text-secondary {
  color: var(--text-secondary);
}
</style>
