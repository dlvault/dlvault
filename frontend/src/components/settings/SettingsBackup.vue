<template>
  <SettingsSection label="Auto-Backup">
    <SettingsRow
      label="Automatische Backups"
      hint="SQLite-Snapshots auf einem Zeitplan — fürs Disaster-Recovery."
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
          <span class="backup-name">{{ b.filename }}</span>
          <span class="backup-meta">{{ formatSize(b.size) }} · {{ formatDate(b.created) }}</span>
        </div>
        <button class="btn btn-danger btn-sm" type="button" @click="removeBackup(b.filename)" title="Löschen">×</button>
      </div>
    </div>
    <p v-else class="empty-hint">Noch keine Backups vorhanden.</p>
  </SettingsSection>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useSettingsContext } from '../../composables/useSettingsContext';
import { triggerBackup, getBackupList, deleteBackup } from '../../api/index';
import SettingsSection from './SettingsSection.vue';
import SettingsRow from './SettingsRow.vue';
import Toggle from './Toggle.vue';
import { Save } from 'lucide-vue-next';

const { settings } = useSettingsContext();
const backups = ref<{ filename: string; size: number; created: string }[]>([]);
const backingUp = ref(false);

const enabled = computed(() => settings.value['backup.enabled'] === 'true');
function setEnabled(v: boolean) {
  settings.value['backup.enabled'] = v ? 'true' : 'false';
}

async function loadBackups() {
  try { const res = await getBackupList(); backups.value = res.data; }
  catch { /* ignore */ }
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
