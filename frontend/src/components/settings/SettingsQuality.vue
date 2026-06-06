<template>
  <SettingsSection label="Auflösung">
    <SettingsRow label="Mindest-Videoqualität" hint="Releases unterhalb dieser Schwelle werden ausgeblendet.">
      <select class="sx-select" v-model="settings['quality.minimum']">
        <option value="">Beste verfügbare</option>
        <option value="480p">480p oder höher</option>
        <option value="720p">720p oder höher</option>
        <option value="1080p">1080p oder höher</option>
        <option value="2160p">Nur 2160p / 4K UHD</option>
      </select>
    </SettingsRow>
    <SettingsRow label="Maximale Videoqualität" hint="Höhere Auflösungen werden ignoriert (z.B. zur Bandbreite-Schonung).">
      <select class="sx-select" v-model="settings['quality.maximum']">
        <option value="">Unbegrenzt</option>
        <option value="720p">720p</option>
        <option value="1080p">1080p</option>
        <option value="2160p">2160p / 4K UHD</option>
      </select>
    </SettingsRow>
    <SettingsRow label="Mindest-Audio" hint="Wird ignoriert, wenn die Audio-Spur nicht erkannt wird.">
      <select class="sx-select" v-model="settings['quality.audio_minimum']">
        <option value="">Beste verfügbare</option>
        <option value="2.0">2.0 oder höher</option>
        <option value="5.1">5.1 oder höher</option>
        <option value="7.1">Nur 7.1 / Atmos</option>
      </select>
    </SettingsRow>

    <SettingsRow
      label="Für Serien abweichend"
      hint="Eigene Auflösungs-Schwellen für Serien. Aus = Serien nutzen dieselben Werte wie Filme."
      toggle
    >
      <Toggle :model-value="seriesOverride" @update:model-value="setSeriesOverride" />
    </SettingsRow>
    <template v-if="seriesOverride">
      <SettingsRow label="Mindest-Videoqualität (Serien)" hint="Releases unterhalb dieser Schwelle werden ausgeblendet.">
        <select class="sx-select" v-model="settings['quality.series_minimum']">
          <option value="">Beste verfügbare</option>
          <option value="480p">480p oder höher</option>
          <option value="720p">720p oder höher</option>
          <option value="1080p">1080p oder höher</option>
          <option value="2160p">Nur 2160p / 4K UHD</option>
        </select>
      </SettingsRow>
      <SettingsRow label="Maximale Videoqualität (Serien)" hint="Höhere Auflösungen werden ignoriert (z.B. zur Bandbreite-Schonung).">
        <select class="sx-select" v-model="settings['quality.series_maximum']">
          <option value="">Unbegrenzt</option>
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
          <option value="2160p">2160p / 4K UHD</option>
        </select>
      </SettingsRow>
      <SettingsRow label="Mindest-Audio (Serien)" hint="Wird ignoriert, wenn die Audio-Spur nicht erkannt wird.">
        <select class="sx-select" v-model="settings['quality.series_audio_minimum']">
          <option value="">Beste verfügbare</option>
          <option value="2.0">2.0 oder höher</option>
          <option value="5.1">5.1 oder höher</option>
          <option value="7.1">Nur 7.1 / Atmos</option>
        </select>
      </SettingsRow>
    </template>
  </SettingsSection>

  <SettingsSection label="Bild">
    <SettingsRow
      label="HDR bevorzugen"
      hint="Bei gleicher Auflösung zählt HDR vor dem Ton. Dolby Vision ohne HDR-Basis zeigt auf Fernsehern ohne Dolby Vision falsche Farben – dann „ohne reines Dolby Vision“ wählen."
    >
      <select class="sx-select" v-model="settings['quality.hdr_preference']">
        <option value="hdr">HDR vor SDR</option>
        <option value="hdr_no_dv">HDR vor SDR, reines Dolby Vision zuletzt</option>
        <option value="none">Egal</option>
      </select>
    </SettingsRow>
    <SettingsRow
      label="Größe vor Ton"
      hint="Bei gleicher Auflösung und gleichem HDR gewinnt die größere Datei (mehr Bitrate) vor der besseren Tonangabe. Hilft, wenn ein Release in der NFO „Atmos 5.1“ trägt, ein größeres aber das bessere Bild hat."
      toggle
    >
      <Toggle :model-value="settings['quality.size_before_audio'] === 'true'" @update:model-value="v => settings['quality.size_before_audio'] = v ? 'true' : 'false'" />
    </SettingsRow>
  </SettingsSection>

  <SettingsSection label="Hoster">
    <SettingsRow
      label="Bevorzugter Hoster vor Qualität"
      hint="Liegt das beste Release nicht beim ersten Hoster aus den Plugin-Einstellungen, ein anderes passendes aber schon, wird das andere geladen – auch in niedrigerer Auflösung. Die Mindestqualität gilt weiter."
      toggle
    >
      <Toggle :model-value="preferHoster" @update:model-value="setPreferHoster" />
    </SettingsRow>
  </SettingsSection>

  <SettingsSection label="Qualitäts-Upgrade">
    <SettingsRow
      label="Automatisch upgraden"
      hint="Suche nach besserer Qualität für Filme, die schon heruntergeladen wurden."
      toggle
    >
      <Toggle :model-value="autoUpgrade" @update:model-value="setAutoUpgrade" />
    </SettingsRow>
    <SettingsRow
      v-if="autoUpgrade"
      label="Upgrade-Cutoff"
      hint="Kein Upgrade mehr, wenn diese Qualität erreicht ist."
    >
      <select class="sx-select" v-model="settings['quality.cutoff']">
        <option value="2160p">2160p / 4K UHD</option>
        <option value="1080p">1080p Full HD</option>
        <option value="720p">720p HD</option>
      </select>
    </SettingsRow>
  </SettingsSection>

  <SettingsSection label="Release-Typen ausschließen">
    <SettingsRow
      label="Ausgeschlossen"
      hint="Wähle aus, was du nicht haben willst. Wird nur von Plugins ausgewertet, die diese Felder unterstützen."
    >
      <Chips
        :model-value="excludeTypes"
        @update:model-value="updateExcludes"
        :options="EXCLUDE_OPTIONS"
      />
    </SettingsRow>
  </SettingsSection>

  <SettingsSection label="Sprache">
    <SettingsRow
      label="Bevorzugte Sprache"
      hint="Welche Sprachen verfügbar sind, legen die aktiven Plugins fest."
    >
      <select class="sx-select" v-model="settings['quality.language']" style="max-width: 200px;">
        <option value="german">Deutsch</option>
      </select>
    </SettingsRow>
    <SettingsRow
      label="Strikt: nur Deutsch"
      hint="Lädt nur eindeutig deutsche Releases. Releases ohne Sprach-Markierung im Titel werden abgelehnt – dlvault wartet, bis ein deutsches Release verfügbar ist, statt ersatzweise ein englisches zu laden. Achtung: deutsche Releases ohne Marker können dabei mit abgelehnt werden."
      toggle
    >
      <Toggle :model-value="strictLanguage" @update:model-value="setStrictLanguage" />
    </SettingsRow>
    <SettingsRow
      label="Tonspur-Sprache prüfen"
      hint="Prüft fertige Downloads per ffprobe darauf, ob überhaupt eine als deutsch markierte Tonspur vorhanden ist, und warnt (Telegram + Verlauf), wenn ein Release falsch deklariert wurde. Löscht oder lädt nichts neu. Hinweis: prüft nur das Tonspur-Tag, nicht den gesprochenen Inhalt – eine als „deutsch“ getaggte Spur mit englischem Ton wird nicht erkannt."
      toggle
    >
      <Toggle :model-value="verifyAudioLanguage" @update:model-value="setVerifyAudioLanguage" />
    </SettingsRow>
    <SettingsRow
      label="Downloads vor dem Import prüfen"
      hint="Bevor ein Film in die Mediathek kommt, wird seine Laufzeit mit der bekannten Laufzeit verglichen (zu kurz = unvollständig, deutlich zu lang = vermutlich ein anderer Film). Im Strikt-Modus und bei Upgrades wird außerdem die Tonspur-Sprache geprüft. Passt etwas nicht, wird das Release gesperrt und ein anderes gesucht."
      toggle
    >
      <Toggle :model-value="verifyImport" @update:model-value="setVerifyImport" />
    </SettingsRow>
  </SettingsSection>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsContext } from '../../composables/useSettingsContext';
import SettingsSection from './SettingsSection.vue';
import SettingsRow from './SettingsRow.vue';
import Toggle from './Toggle.vue';
import Chips from './Chips.vue';

const { settings } = useSettingsContext();

const preferHoster = computed(() => settings.value['quality.prefer_hoster'] === 'true');
function setPreferHoster(v: boolean) {
  settings.value['quality.prefer_hoster'] = v ? 'true' : 'false';
}

const EXCLUDE_OPTIONS = [
  'Complete BluRay',
  'Remux',
  'Dolby Vision',
];

const TYPE_KEYS: Record<string, string> = {
  'Complete BluRay': 'complete',
  'Remux': 'remux',
  'Dolby Vision': 'dolbyvision',
};
const TYPE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(TYPE_KEYS).map(([label, key]) => [key, label])
);

const autoUpgrade = computed(() => settings.value['quality.auto_upgrade'] === 'true');
function setAutoUpgrade(v: boolean) {
  settings.value['quality.auto_upgrade'] = v ? 'true' : 'false';
}

const seriesOverride = computed(() => settings.value['quality.series_override'] === 'true');
function setSeriesOverride(v: boolean) {
  settings.value['quality.series_override'] = v ? 'true' : 'false';
}

const strictLanguage = computed(() => settings.value['quality.language_strict'] === 'true');
function setStrictLanguage(v: boolean) {
  settings.value['quality.language_strict'] = v ? 'true' : 'false';
}

const verifyImport = computed(() => settings.value['integrity.verify_import'] !== 'false');
function setVerifyImport(v: boolean) {
  settings.value['integrity.verify_import'] = v ? 'true' : 'false';
}

const verifyAudioLanguage = computed(() => settings.value['integrity.verify_language'] === 'true');
function setVerifyAudioLanguage(v: boolean) {
  settings.value['integrity.verify_language'] = v ? 'true' : 'false';
}

const excludeTypes = computed(() => {
  const csv = settings.value['quality.exclude_types'] || '';
  return csv.split(',').map(s => s.trim()).filter(Boolean).map(k => TYPE_LABELS[k] || k);
});
function updateExcludes(labels: string[]) {
  const keys = labels.map(l => TYPE_KEYS[l] || l);
  settings.value['quality.exclude_types'] = keys.join(',');
}
</script>
