<template>
  <details class="card settings-section" open>
    <summary class="card-toggle"><h2>Backups</h2></summary>
    <div class="form-grid">
      <div class="form-group">
        <label class="toggle-row">
          <span>Automatische Backups</span>
          <span class="toggle-switch" :class="{ active: settings['backup.enabled'] === 'true' }" @click="settings['backup.enabled'] = settings['backup.enabled'] === 'true' ? 'false' : 'true'" tabindex="0" @keydown.enter.prevent="settings['backup.enabled'] = settings['backup.enabled'] === 'true' ? 'false' : 'true'" role="switch" :aria-checked="settings['backup.enabled'] === 'true'">
            <span class="toggle-knob" />
          </span>
        </label>
      </div>
      <div class="form-group">
        <label for="backup-interval">Backup-Intervall (Stunden) <small class="text-secondary">1-168</small></label>
        <input
          id="backup-interval"
          v-model="settings['backup.interval_hours']"
          type="number"
          min="1"
          max="168"
        />
      </div>
      <div class="form-group">
        <label for="backup-max">Maximale Anzahl Backups <small class="text-secondary">1-50</small></label>
        <input
          id="backup-max"
          v-model="settings['backup.max_backups']"
          type="number"
          min="1"
          max="50"
        />
      </div>
    </div>

    <div class="backup-actions">
      <button class="btn btn-secondary" @click="manualBackup" :disabled="backingUp">
        {{ backingUp ? 'Backup wird erstellt...' : 'Jetzt Backup erstellen' }}
      </button>
    </div>

    <div v-if="backups.length > 0" class="backup-list">
      <h3>Vorhandene Backups</h3>
      <div v-for="b in backups" :key="b.filename" class="backup-item">
        <div class="backup-info">
          <span class="backup-name">{{ b.filename }}</span>
          <span class="backup-meta">{{ formatSize(b.size) }} &middot; {{ formatDate(b.created) }}</span>
        </div>
        <button class="btn btn-danger btn-sm" @click="removeBackup(b.filename)" title="Löschen">&times;</button>
      </div>
    </div>
    <p v-else class="text-secondary backup-empty">Noch keine Backups vorhanden.</p>
  </details>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useSettingsContext } from '../../composables/useSettingsContext';
import { triggerBackup, getBackupList, deleteBackup } from '../../api/index';

const { settings } = useSettingsContext();
const backups = ref<{ filename: string; size: number; created: string }[]>([]);
const backingUp = ref(false);

async function loadBackups() {
  try {
    const res = await getBackupList();
    backups.value = res.data;
  } catch { /* ignore */ }
}

async function manualBackup() {
  backingUp.value = true;
  try {
    await triggerBackup();
    await loadBackups();
  } catch { /* ignore */ }
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
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

onMounted(loadBackups);
</script>

<style scoped>
.text-secondary { color: var(--text-secondary); }

.backup-actions {
  margin: 12px 0 16px;
}

.backup-list h3 {
  font-size: 0.9rem;
  margin-bottom: 8px;
}

.backup-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.backup-item:last-child {
  border-bottom: none;
}

.backup-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.backup-name {
  font-size: 0.85rem;
  font-weight: 500;
  font-family: monospace;
}

.backup-meta {
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.backup-empty {
  font-size: 0.85rem;
  margin: 8px 0;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 0.8rem;
  min-width: auto;
}
</style>
