<template>
  <details class="card settings-section">
    <summary class="card-toggle"><h2>Rename-Templates</h2></summary>
    <p class="section-hint">
      Steuert Dateinamen und Ordnerstruktur in der Bibliothek. Die Hauptdatei (groesster Mediafile) wird umbenannt verschoben,
      der Rest aus dem Download-Ordner (Samples, Werbung, Affiliate-Links) wird geloescht.
      Verfuegbare Tokens: <code>{title}</code> <code>{year}</code> <code>{quality}</code> <code>{audio}</code> <code>{season}</code> <code>{episode}</code> <code>{release}</code>
      &mdash; <code>{season}</code> und <code>{episode}</code> sind 2-stellig.
    </p>
    <div class="form-grid">
      <div class="form-group full-col">
        <label for="rename-movie-file">Film &mdash; Dateiname (ohne Extension)</label>
        <input id="rename-movie-file" v-model="settings['rename.movie_file_template']" placeholder="{title} ({year})" />
        <div class="rename-preview">
          Vorschau: <code>{{ moviePreview }}</code>
        </div>
      </div>
      <div class="form-group full-col">
        <label for="rename-series-folder">Serie &mdash; Ordnername</label>
        <input id="rename-series-folder" v-model="settings['rename.series_folder_template']" placeholder="{title}" />
      </div>
      <div class="form-group full-col">
        <label for="rename-series-file">Serie &mdash; Episoden-Dateiname (ohne Extension)</label>
        <input id="rename-series-file" v-model="settings['rename.series_file_template']" placeholder="{title} S{season}E{episode}" />
        <div class="rename-preview">
          Vorschau: <code>{{ seriesPreview }}</code>
        </div>
      </div>
      <div class="form-group full-col">
        <label for="rename-junk-mb">Junk-Schwelle (MB)</label>
        <input id="rename-junk-mb" type="number" min="0" v-model="settings['rename.junk_min_size_mb']" placeholder="300" />
        <div class="rename-preview">
          Dateien unterhalb dieser Groesse gelten als Junk (Samples, Werbung) und werden mit dem Source-Ordner verworfen.
        </div>
      </div>
    </div>
    <div class="rename-defaults">
      <button class="btn btn-secondary btn-sm" @click="resetDefaults">Defaults wiederherstellen</button>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsContext } from '../../composables/useSettingsContext';

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
    title: 'The Devil Wears Prada 2', year: '2026', quality: '1080p', audio: '5.1', release: 'The.Devil.Wears.Prada.2.2026.1080p.BluRay.x264',
  }) + '.mkv';
});

const seriesPreview = computed(() => {
  const folderTmpl = settings.value['rename.series_folder_template'] || '{title}';
  const fileTmpl = settings.value['rename.series_file_template'] || '{title} S{season}E{episode}';
  const vars = {
    title: 'Scrubs', year: '2001', quality: '1080p', audio: '5.1', season: '01', episode: '03', release: 'Scrubs.S01E03.1080p',
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
.section-hint {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  margin-bottom: 12px;
  line-height: 1.6;
}

.section-hint code {
  background: var(--bg-primary);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 0.8em;
}

.rename-preview {
  margin-top: 6px;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.rename-preview code {
  color: var(--accent);
  background: var(--bg-primary);
  padding: 2px 6px;
  border-radius: 4px;
}

.rename-defaults {
  margin-top: 12px;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 0.8rem;
}
</style>
