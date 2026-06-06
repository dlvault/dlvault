<template>
  <SettingsSection label="Auto-Backup">
    <SettingsRow
      label="Automatische Backups"
      hint="Vollständige Archive auf einem Zeitplan: Datenbank, Verschlüsselungs-Key und installierte Plugins in einer <code>.tar.gz</code>."
      toggle
    >
      <Toggle :model-value="enabled" @update:model-value="setEnabled" />
    </SettingsRow>
    <SettingsRow
      label="Intervall"
      hint="Wie oft soll ein Snapshot gemacht werden?"
    >
      <div class="num-with-unit">
        <input
          class="sx-input"
          type="number"
          min="1"
          max="168"
          placeholder="24"
          v-model="settings['backup.interval_hours']"
          :disabled="!enabled"
        />
        <span class="unit">Stunden</span>
      </div>
    </SettingsRow>
    <SettingsRow
      label="Speicherort"
      hint="Leer = <code>data/backups</code> — das liegt im selben Volume wie die Datenbank, ein Volume-Verlust nimmt beides mit. Einen anderen gemounteten Pfad angeben (z.B. einen zweiten Share oder einen Cloud-Sync-Ordner), damit das Backup den Ausfall übersteht."
    >
      <div class="path-field">
        <input
          class="sx-input mono"
          type="text"
          placeholder="/backups"
          v-model="settings['backup.path']"
        />
        <span v-if="effectivePath" class="path-hint">Aktuell: <code>{{ effectivePath }}</code></span>
      </div>
    </SettingsRow>
    <SettingsRow
      label="Verschlüsselungs-Key mitsichern"
      hint="Ohne den Key sind die gespeicherten Zugangsdaten nach einer Wiederherstellung unlesbar. Mit Key ist das Archiv genauso schützenswert wie die Zugangsdaten selbst."
      toggle
    >
      <Toggle :model-value="includeKey" @update:model-value="setIncludeKey" />
    </SettingsRow>
    <SettingsRow
      label="Maximale Anzahl"
      hint="Ältere Backups werden automatisch gelöscht. <code>1–50</code>."
    >
      <div class="num-with-unit">
        <input
          class="sx-input"
          type="number"
          min="1"
          max="50"
          placeholder="7"
          v-model="settings['backup.max_backups']"
        />
        <span class="unit">Backups</span>
      </div>
    </SettingsRow>
  </SettingsSection>

  <SettingsSection label="Backups">
    <div class="backup-action-row">
      <button class="btn btn-secondary" type="button" :disabled="backingUp" @click="manualBackup">
        <Save :size="14" />
        <span>{{ backingUp ? 'Backup läuft…' : 'Jetzt Backup erstellen' }}</span>
      </button>
      <span class="count-tag">{{ backups.length }} {{ backups.length === 1 ? 'Backup' : 'Backups' }}</span>
    </div>
    <div v-if="backups.length > 0" class="backup-list">
      <div v-for="b in backups" :key="b.filename" class="backup-item">
        <div class="backup-info">
          <span class="backup-name">
            {{ b.filename }}
            <span v-if="b.legacy" class="legacy-tag" title="Altes Format: nur Datenbank, ohne Key und Plugins">nur DB</span>
          </span>
          <span class="backup-meta">{{ formatSize(b.size) }} · {{ formatDate(b.created) }}</span>
        </div>
        <div class="backup-actions">
          <button
            class="btn btn-secondary btn-sm"
            type="button"
            :disabled="restoring !== null"
            @click="restore(b)"
          >
            {{ restoring === b.filename ? 'Startet neu…' : 'Wiederherstellen' }}
          </button>
          <button class="btn btn-danger btn-sm" type="button" :disabled="restoring !== null" @click="removeBackup(b.filename)" title="Löschen">×</button>
        </div>
      </div>
    </div>
    <p v-else class="empty-hint">Noch keine Backups vorhanden.</p>
    <p v-if="restoreError" class="restore-error">{{ restoreError }}</p>
    <p v-if="restoreDone" class="restore-note">
      Wiederherstellung vorbereitet — dlvault startet gerade neu und übernimmt das Backup beim Hochfahren.
      Die Seite in etwa einer Minute neu laden.
    </p>
  </SettingsSection>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useSettingsContext } from '../../composables/useSettingsContext';
import { triggerBackup, getBackupList, deleteBackup, restoreBackup, getBackupSettings } from '../../api/index';
import { useConfirm } from '../../composables/useApp';
import SettingsSection from './SettingsSection.vue';
import SettingsRow from './SettingsRow.vue';
import Toggle from './Toggle.vue';
import { Save } from 'lucide-vue-next';

interface BackupItem { filename: string; size: number; created: string; legacy?: boolean }

const { settings } = useSettingsContext();
const confirm = useConfirm();
const backups = ref<BackupItem[]>([]);
const backingUp = ref(false);
const restoring = ref<string | null>(null);
const restoreError = ref<string | null>(null);
const restoreDone = ref(false);
/** Where backups actually land — resolved server-side, shown under the path field. */
const effectivePath = ref('');

const includeKey = computed(() => settings.value['backup.include_key'] !== 'false');
function setIncludeKey(v: boolean) {
  settings.value['backup.include_key'] = v ? 'true' : 'false';
}

const enabled = computed(() => settings.value['backup.enabled'] === 'true');
function setEnabled(v: boolean) {
  settings.value['backup.enabled'] = v ? 'true' : 'false';
}

async function loadBackups() {
  try { const res = await getBackupList(); backups.value = res.data; }
  catch { /* ignore */ }
  try { const res = await getBackupSettings(); effectivePath.value = res.data.effectivePath || ''; }
  catch { /* ignore */ }
}

async function restore(b: BackupItem) {
  restoreError.value = null;
  const ok = await confirm.value?.show({
    title: 'Backup wiederherstellen',
    message: b.legacy
      ? `"${b.filename}" stammt aus dem alten Format (nur Datenbank, ohne Key und Plugins) und kann nicht automatisch eingespielt werden.`
      : `"${b.filename}" einspielen? Der aktuelle Stand wird dabei ersetzt — dlvault startet danach neu. `
        + 'Die bisherige Datenbank wird als Sicherheitskopie daneben abgelegt.',
    confirmText: 'Wiederherstellen',
    danger: true,
  });
  if (!ok) return;

  restoring.value = b.filename;
  try {
    await restoreBackup(b.filename);
    restoreDone.value = true;
  } catch (e: any) {
    restoreError.value = e?.response?.data?.error || 'Wiederherstellung fehlgeschlagen';
    restoring.value = null;
  }
}

async function manualBackup() {
  backingUp.value = true;
  try { await triggerBackup(); await loadBackups(); }
  catch { /* ignore */ }
  backingUp.value = false;
}

async function removeBackup(filename: string) {
  try {
    await deleteBackup(filename);
    backups.value = backups.value.filter(b => b.filename !== filename);
  } catch { /* ignore */ }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

onMounted(loadBackups);
</script>

<style scoped>
.num-with-unit {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 220px;
}
.num-with-unit .sx-input { flex: 1; }
.unit {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-3);
}

.path-field { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
.path-hint { font-size: 11.5px; color: var(--text-3); }
.path-hint code { font-family: var(--font-mono); font-size: 11px; }
.backup-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.legacy-tag {
  margin-left: 8px; padding: 1px 6px;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.04em;
  color: var(--text-3); background: color-mix(in srgb, var(--text-3) 14%, transparent);
  border-radius: 4px;
}
.restore-error { margin-top: 12px; font-size: 12.5px; color: var(--danger, #e5484d); }
.restore-note { margin-top: 12px; font-size: 12.5px; color: var(--text-2); line-height: 1.5; }
.backup-action-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.count-tag {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-3);
}

.backup-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.backup-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
.backup-item:last-child { border-bottom: none; }
.backup-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.backup-name {
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.backup-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
}

.empty-hint {
  font-size: 13px;
  color: var(--text-3);
}

.btn-sm {
  padding: 4px 10px;
  font-size: 14px;
  min-width: auto;
  line-height: 1;
}
</style>
