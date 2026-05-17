<template>
  <details class="card settings-section" open>
    <summary class="card-toggle"><h2>Qualitätseinstellungen</h2></summary>
    <div class="quality-settings">
      <div class="form-group full-col">
        <label class="toggle-row">
          <span>Qualitäts-Upgrade</span>
          <span class="toggle-switch" :class="{ active: settings['quality.auto_upgrade'] === 'true' }" @click="settings['quality.auto_upgrade'] = settings['quality.auto_upgrade'] === 'true' ? 'false' : 'true'" tabindex="0" @keydown.enter.prevent="settings['quality.auto_upgrade'] = settings['quality.auto_upgrade'] === 'true' ? 'false' : 'true'" role="switch" :aria-checked="settings['quality.auto_upgrade'] === 'true'">
            <span class="toggle-knob" />
          </span>
        </label>
        <small class="form-hint">Automatisch nach besserer Qualität suchen wenn bereits heruntergeladen</small>
      </div>

      <div v-if="settings['quality.auto_upgrade'] === 'true'" class="form-group">
        <label for="quality-cutoff">Upgrade-Cutoff <small class="text-secondary">(zufrieden ab)</small></label>
        <select id="quality-cutoff" v-model="settings['quality.cutoff']">
          <option value="2160p">2160p / 4K UHD</option>
          <option value="1080p">1080p Full HD</option>
          <option value="720p">720p HD</option>
        </select>
        <small class="form-hint">Kein Upgrade mehr wenn diese Qualität erreicht ist</small>
      </div>

      <div class="quality-row-3">
        <div class="form-group">
          <label for="quality-min">Mindest-Videoqualität</label>
          <select id="quality-min" v-model="settings['quality.minimum']">
            <option value="">Beste verfügbare</option>
            <option value="480p">480p oder höher</option>
            <option value="720p">720p oder höher</option>
            <option value="1080p">1080p oder höher</option>
            <option value="2160p">Nur 2160p / 4K UHD</option>
          </select>
          <small class="form-hint">Releases unterhalb dieser Schwelle werden ausgeblendet</small>
        </div>
        <div class="form-group">
          <label for="quality-max">Maximale Videoqualität</label>
          <select id="quality-max" v-model="settings['quality.maximum']">
            <option value="">Unbegrenzt</option>
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
            <option value="2160p">2160p / 4K UHD</option>
          </select>
          <small class="form-hint">Höhere Auflösungen werden ignoriert (z.B. zur Bandbreite-Schonung)</small>
        </div>
        <div class="form-group">
          <label for="quality-audio">Mindest-Audio</label>
          <select id="quality-audio" v-model="settings['quality.audio_minimum']">
            <option value="">Beste verfügbare</option>
            <option value="2.0">2.0 oder höher</option>
            <option value="5.1">5.1 oder höher</option>
            <option value="7.1">Nur 7.1 / Atmos</option>
          </select>
          <small class="form-hint">Wird ignoriert wenn die Audio-Spur nicht erkannt wird</small>
        </div>
      </div>

      <div class="quality-row-bottom">
        <div class="form-group quality-exclude">
          <label>Release-Typen ausschließen</label>
          <div class="checkbox-list-horizontal">
            <label class="chip-checkbox" :class="{ checked: excludeTypes.includes('complete') }">
              <input type="checkbox" :checked="excludeTypes.includes('complete')" @change="toggleExcludeType('complete')">
              <span>Complete BluRay (ISO/Disc)</span>
            </label>
            <label class="chip-checkbox" :class="{ checked: excludeTypes.includes('remux') }">
              <input type="checkbox" :checked="excludeTypes.includes('remux')" @change="toggleExcludeType('remux')">
              <span>Remux (volle BluRay-Qualität)</span>
            </label>
            <label class="chip-checkbox" :class="{ checked: excludeTypes.includes('dolbyvision') }">
              <input type="checkbox" :checked="excludeTypes.includes('dolbyvision')" @change="toggleExcludeType('dolbyvision')">
              <span>Dolby Vision (DV/DoVi)</span>
            </label>
          </div>
        </div>
      </div>

      <p class="section-hint">
        Diese Filter werden nur von Plugins ausgewertet, die die jeweiligen
        Felder unterstützen. Welche Sprachen verfügbar sind, legen die
        aktiven Plugins fest.
      </p>
      <div class="form-group">
        <label for="quality-lang">Sprache</label>
        <select id="quality-lang" v-model="settings['quality.language']">
          <option value="german">Deutsch</option>
        </select>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsContext } from '../../composables/useSettingsContext';

const { settings } = useSettingsContext();

const excludeTypes = computed(() =>
  (settings.value['quality.exclude_types'] || '').split(',').map(s => s.trim()).filter(Boolean)
);

function toggleExcludeType(type: string) {
  const current = excludeTypes.value;
  const updated = current.includes(type)
    ? current.filter(t => t !== type)
    : [...current, type];
  settings.value['quality.exclude_types'] = updated.join(',');
}
</script>

<style scoped>
.quality-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.quality-row-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.quality-row-bottom {
  display: block;
}

.quality-settings .form-group {
  margin-bottom: 0;
}

.checkbox-list-horizontal {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}

.chip-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  cursor: pointer;
  font-weight: normal;
  font-size: 0.85rem;
  transition: border-color var(--duration-fast), background var(--duration-fast);
  user-select: none;
}

.chip-checkbox:hover {
  border-color: var(--accent);
}

.chip-checkbox.checked {
  border-color: var(--accent);
  background: rgba(240, 107, 130, 0.1);
}

.chip-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  min-width: 16px;
  accent-color: var(--accent);
  cursor: pointer;
  margin: 0;
}

@media (max-width: 768px) {
  .quality-row-3 {
    grid-template-columns: 1fr;
    gap: 10px;
  }
}
</style>
