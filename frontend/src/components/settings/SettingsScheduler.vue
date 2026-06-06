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
    <SettingsRow
      label="Suchen pro Stunde"
      hint="Höchstens so viele <strong>geplante</strong> Suchen starten innerhalb einer Stunde, über alle Titel. <code>0</code> = unbegrenzt. Eigene Anfragen (Bot, Oberfläche) zählen nicht dagegen."
    >
      <div class="num-with-unit">
        <input class="sx-input" type="number" min="0" max="120" placeholder="0" v-model="settings['scheduler.max_searches_per_hour']" />
        <span class="unit">pro Std.</span>
      </div>
    </SettingsRow>
    <SettingsRow
      label="Mindestabstand je Titel"
      hint="Ein schon gesuchter Titel wird frühestens nach so vielen Tagen wieder automatisch gesucht (plus bis zu 24 h Versatz je Titel). Neu hinzugefügte Titel (unter 2 Tage) sind ausgenommen. <code>0</code> = aus."
    >
      <div class="num-with-unit">
        <input class="sx-input" type="number" min="0" max="60" placeholder="0" v-model="settings['scheduler.min_days_between_searches']" />
        <span class="unit">Tage</span>
      </div>
    </SettingsRow>
    <SettingsRow
      label="Schleifen-Schutz"
      hint="Nicht erneut suchen, solange zu einem schon an JDownloader gesendeten Titel noch Dateien im Download-Ordner liegen (z. B. eine lose Datei, die nicht zugeordnet werden kann). Verhindert Endlos-Neuladen."
      toggle
    >
      <Toggle :model-value="loopGuard" @update:model-value="setLoopGuard" />
    </SettingsRow>
    <SettingsRow label="Gestartete Suchen" hint="Aus dem Aktivitätslog: so viele Suchen hat dlvault zuletzt bei den Quellen gestartet.">
      <div v-if="stats" class="req-stats">
        <span><strong>{{ stats.lastHour }}</strong> letzte Stunde</span>
        <span><strong>{{ stats.last24h }}</strong> 24 Std.</span>
        <span><strong>{{ stats.last7d }}</strong> 7 Tage</span>
      </div>
      <div v-else class="req-stats">–</div>
    </SettingsRow>
    <SettingsRow
      label="Auf Erscheinungstermin warten"
      hint="Braucht einen TMDb-Schlüssel oder eine Seerr-Verbindung. Filme werden erst ab dem deutschen Digital-/Disc-Termin gesucht (ohne den: Kinostart + 30 Tage), Serien erst ab dem Start; fertige Serien nur noch monatlich, laufende ohne angekündigte Folge wöchentlich. Neue Titel und alles, was du selbst anstößt, sucht sofort."
      toggle
    >
      <Toggle :model-value="releaseHold" @update:model-value="setReleaseHold" />
    </SettingsRow>
  </SettingsSection>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getRequestStats, type RequestStats } from '../../api';
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

const stats = ref<RequestStats | null>(null);
onMounted(async () => {
  try { stats.value = (await getRequestStats()).data; } catch { stats.value = null; }
});
const loopGuard = computed(() => settings.value['scheduler.loop_guard'] === 'true');
function setLoopGuard(v: boolean) {
  settings.value['scheduler.loop_guard'] = v ? 'true' : 'false';
}

const releaseHold = computed(() => settings.value['scheduler.release_hold'] !== 'false');
function setReleaseHold(v: boolean) {
  settings.value['scheduler.release_hold'] = v ? 'true' : 'false';
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
.num-with-unit { display: flex; align-items: center; gap: 8px; max-width: 220px; }
.num-with-unit .sx-input { flex: 1; }
.unit { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-3); }
.req-stats { display: flex; gap: 18px; flex-wrap: wrap; color: var(--text-secondary); font-size: 13px; }
</style>
