<template>
  <SettingsSection label="Kinder-Bibliothek (optional)">
    <div class="info-note">
      Trennt Kinderfilme + Kinderserien automatisch <strong>per Genre</strong> in eigene
      Verzeichnisse. Lass die Pfade leer, um die Trennung auszuschalten — dann landet
      alles wie gewohnt im Hauptverzeichnis.
    </div>

    <SettingsRow
      label="Kinder-Genres"
      hint="Kommagetrennt. Ein Titel mit einem dieser Genres wird in die Kinder-Ordner verschoben."
    >
      <input
        class="sx-input"
        type="text"
        placeholder="Family,Animation"
        v-model="settings['kids.genres']"
      />
    </SettingsRow>

    <SettingsRow
      label="Kinder-Filme-Ordner"
      hint="Container-Pfad (als Docker-Volume mounten). Leer = Trennung für Filme aus."
    >
      <input
        class="sx-input mono"
        type="text"
        placeholder="/kids_movies"
        v-model="settings['paths.kids_movies']"
      />
    </SettingsRow>

    <SettingsRow
      label="Kinder-Serien-Ordner"
      hint="Container-Pfad (als Docker-Volume mounten). Leer = Trennung für Serien aus."
    >
      <input
        class="sx-input mono"
        type="text"
        placeholder="/kids_series"
        v-model="settings['paths.kids_series']"
      />
    </SettingsRow>

    <div class="warning-note">
      <strong>Am einfachsten:</strong> das Windows-Setup-Script nochmal ausführen und bei
      „Kinder-Filme-Ordner" / „Kinder-Serien-Ordner" einen Pfad eintragen — dann wird der
      Docker-Mount automatisch gesetzt und diese Felder hier befüllt. Die Werte hier sind
      <em>Container-Pfade</em> (wie <code>/movies</code>): Wer den Container von Hand startet,
      mountet die Host-Ordner selbst (z.B. <code>-v D:\Kinder\Filme:/kids_movies</code>).
      Damit ein eigenes Kinderkonto sie sieht, muss dein Media-Server sie als separate
      Kinder-Bibliothek scannen. Genres stammen aus den Metadaten — dafür sollte ein
      OMDb-Schlüssel gesetzt sein.
    </div>
  </SettingsSection>
</template>

<script setup lang="ts">
import { useSettingsContext } from '../../composables/useSettingsContext';
import SettingsSection from './SettingsSection.vue';
import SettingsRow from './SettingsRow.vue';

const { settings } = useSettingsContext();
</script>

<style scoped>
.info-note {
  font-size: 12.5px;
  color: var(--text-secondary);
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 10px 14px;
  margin-bottom: 12px;
  line-height: 1.55;
}
.info-note strong { color: var(--text-primary); }

.warning-note {
  margin-top: 12px;
  font-size: 12.5px;
  color: var(--text-secondary);
  background: rgba(245, 176, 65, 0.08);
  border: 1px solid rgba(245, 176, 65, 0.25);
  border-radius: var(--r-sm);
  padding: 10px 14px;
  line-height: 1.55;
}
.warning-note strong { color: var(--warn); }
.warning-note code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  background: var(--surface-2);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
