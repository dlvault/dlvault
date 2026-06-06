<template>
  <SettingsSection label="Templates">
    <div class="rename-intro">
      Steuert Dateinamen und Ordnerstruktur in der Bibliothek. Die Hauptdatei (größter Mediafile) wird umbenannt verschoben,
      der Rest aus dem Download-Ordner (Samples, Werbung, Affiliate-Links) wird gelöscht.<br />
      <strong>Verfügbare Tokens:</strong>
      <code>{title}</code> <code>{year}</code> <code>{quality}</code> <code>{audio}</code>
      <code>{season}</code> <code>{episode}</code> <code>{release}</code>
      <code>{imdbid}</code> <code>{tmdbid}</code> <code>{tvdbid}</code>
      — <code>{season}</code> und <code>{episode}</code> sind 2-stellig.<br />
      Die ID-Tokens sind dafür da, in eckigen Klammern zu stehen:
      <code>[imdbid-{imdbid}]</code>. Jellyfin und Plex lesen das und ordnen die Datei
      darüber eindeutig zu, statt aus dem Titel zu raten — bei kurzen Titeln
      („Run") liegen sie sonst schon mal daneben. Ist die ID unbekannt, fällt die
      Klammer weg. <strong>Änderungen gelten nur für neue Downloads</strong> — bereits
      abgelegte Dateien werden nicht umbenannt.
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

    <SettingsRow label="Serie — Ordnername" hint="Titel plus ID-Marker; der Marker sitzt bei Serien am Ordner, nicht an der Episodendatei.">
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
  // Mirrors applyRenameTemplate on the server: a marker whose id came out empty
  // is dropped rather than left dangling as "[imdbid-]".
  return result
    .replace(/\[[^\]]*-\s*\]|\[\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const moviePreview = computed(() => {
  const tmpl = settings.value['rename.movie_file_template'] || '{title} ({year})';
  return applyTemplate(tmpl, {
    title: 'The Devil Wears Prada 2', year: '2026', quality: '1080p', audio: '5.1',
    release: 'The.Devil.Wears.Prada.2.2026.1080p.BluRay.x264',
    imdbid: 'tt19847976', tmdbid: '1035048', tvdbid: '',
  }) + '.mkv';
});

const seriesPreview = computed(() => {
  const folderTmpl = settings.value['rename.series_folder_template'] || '{title}';
  const fileTmpl = settings.value['rename.series_file_template'] || '{title} S{season}E{episode}';
  const vars = {
    title: 'Scrubs', year: '2001', quality: '1080p', audio: '5.1', season: '01', episode: '03',
    release: 'Scrubs.S01E03.1080p',
    imdbid: 'tt0285403', tmdbid: '4556', tvdbid: '76156',
  };
  return `${applyTemplate(folderTmpl, vars)}/${applyTemplate(fileTmpl, vars)}.mkv`;
});

function resetDefaults() {
  settings.value['rename.movie_file_template'] = '{title} ({year}) [imdbid-{imdbid}]';
  settings.value['rename.series_folder_template'] = '{title} [imdbid-{imdbid}]';
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
