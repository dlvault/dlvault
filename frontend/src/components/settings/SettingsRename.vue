<template>
  <SettingsSection label="Templates">
    <div class="rename-intro">
      Steuert Dateinamen und Ordnerstruktur in der Bibliothek. Die Hauptdatei (größter Mediafile) wird umbenannt verschoben,
      der Rest aus dem Download-Ordner (Samples, Werbung, Affiliate-Links) wird gelöscht.<br />
      <strong>Verfügbare Tokens:</strong>
      <code>{title}</code> <code>{year}</code> <code>{quality}</code> <code>{audio}</code>
      <code>{season}</code> <code>{episode}</code> <code>{release}</code>
      — <code>{season}</code> und <code>{episode}</code> sind 2-stellig.
    </div>

    <SettingsRow
      label="Film — Dateiname"
      hint="Ohne Dateiendung. Preview zeigt das Ergebnis mit Beispiel-Daten."
    >
      <input
        class="sx-input mono"
        type="text"
        placeholder="{title} ({year})"
        v-model="settings['rename.movie_file_template']"
      />
      <div class="preview">Vorschau: <code>{{ moviePreview }}</code></div>
    </SettingsRow>

    <SettingsRow label="Serie — Ordnername" hint="Üblicherweise nur der Titel.">
      <input
        class="sx-input mono"
        type="text"
        placeholder="{title}"
        v-model="settings['rename.series_folder_template']"
      />
    </SettingsRow>

    <SettingsRow
      label="Serie — Episoden-Dateiname"
      hint="Ohne Dateiendung. <code>{season}</code> und <code>{episode}</code> kommen 2-stellig."
    >
      <input
        class="sx-input mono"
        type="text"
        placeholder="{title} S{season}E{episode}"
        v-model="settings['rename.series_file_template']"
      />
      <div class="preview">Vorschau: <code>{{ seriesPreview }}</code></div>
    </SettingsRow>
  </SettingsSection>

  <SettingsSection label="Junk-Erkennung">
    <SettingsRow
      label="Junk-Schwelle"
      hint="Dateien unter dieser Größe gelten als Junk (Samples, Werbung) und werden mit dem Source-Ordner verworfen."
    >
      <div class="num-with-unit">
        <input
          class="sx-input"
          type="number"
          min="0"
          placeholder="300"
          v-model="settings['rename.junk_min_size_mb']"
        />
        <span class="unit">MB</span>
      </div>
    </SettingsRow>
  </SettingsSection>

  <div class="defaults-row">
    <button class="btn btn-ghost" type="button" @click="resetDefaults">
      Defaults wiederherstellen
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsContext } from '../../composables/useSettingsContext';
import SettingsSection from './SettingsSection.vue';
import SettingsRow from './SettingsRow.vue';

const { settings } = useSettingsContext();

function applyTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
  }
  return result;
}

const moviePreview = computed(() => {
  const tmpl = settings.value['rename.movie_file_template'] || '{title} ({year})';
  return applyTemplate(tmpl, {
    title: 'The Devil Wears Prada 2', year: '2026', quality: '1080p', audio: '5.1',
    release: 'The.Devil.Wears.Prada.2.2026.1080p.BluRay.x264',
  }) + '.mkv';
});

const seriesPreview = computed(() => {
  const folderTmpl = settings.value['rename.series_folder_template'] || '{title}';
  const fileTmpl = settings.value['rename.series_file_template'] || '{title} S{season}E{episode}';
  const vars = {
    title: 'Scrubs', year: '2001', quality: '1080p', audio: '5.1', season: '01', episode: '03',
    release: 'Scrubs.S01E03.1080p',
  };
  return `${applyTemplate(folderTmpl, vars)}/${applyTemplate(fileTmpl, vars)}.mkv`;
});

function resetDefaults() {
  settings.value['rename.movie_file_template'] = '{title} ({year})';
  settings.value['rename.series_folder_template'] = '{title}';
  settings.value['rename.series_file_template'] = '{title} S{season}E{episode}';
  settings.value['rename.junk_min_size_mb'] = '300';
}
</script>

<style scoped>
.rename-intro {
  font-size: 12.5px;
  color: var(--text-secondary);
  margin-bottom: 14px;
  line-height: 1.6;
  padding: 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}
.rename-intro strong { color: var(--text-primary); font-weight: 600; }
.rename-intro code {
  font-family: var(--font-mono);
  background: var(--surface);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
  color: var(--text-secondary);
}

.preview {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3);
}
.preview code {
  font-family: var(--font-mono);
  color: var(--accent-2);
  background: var(--surface-2);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11.5px;
}

.num-with-unit {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 180px;
}
.num-with-unit .sx-input { flex: 1; }
.unit {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-3);
}

.defaults-row {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
