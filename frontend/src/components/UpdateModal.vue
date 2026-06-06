<template>
  <Transition name="wizard-fade">
    <div v-if="open" class="update-overlay" @click.self="emit('close')">
      <div class="update-modal">
        <h3 v-if="state === 'idle'">Update verfügbar</h3>
        <h3 v-else-if="state === 'running'">Update läuft...</h3>
        <h3 v-else-if="state === 'done'">Update erfolgreich</h3>
        <h3 v-else>Update fehlgeschlagen</h3>

        <template v-if="state === 'idle' && canStart">
          <p class="update-steps">
            Der Updater lädt das neueste Image aus der Registry, ersetzt den Container und prüft die Health.
            Konfiguration und Datenbank bleiben erhalten. Dauert ca. 1-3 Minuten.
          </p>
          <div class="update-modal-footer">
            <button class="btn btn-secondary" @click="emit('close')">Abbrechen</button>
            <button class="btn btn-primary update-btn" @click="emit('start')">
              Jetzt aktualisieren
            </button>
          </div>
        </template>

        <template v-else-if="state === 'idle'">
          <p v-if="blockedReason" class="update-error">{{ blockedReason }}</p>
          <p class="text-secondary">
            Der One-Click-Updater braucht die <code>HOST_DATA_DIR</code>-Umgebungsvariable, um Status zwischen
            altem und neuem Container zu teilen. Setze sie in deinem Container-Template auf den Host-Pfad,
            den du auf <code>/app/data</code> mountest (z.B. <code>/mnt/user/appdata/dlvault</code> auf Unraid).
            Danach Container neu starten — der Button funktioniert dann.
          </p>
          <div class="update-modal-footer">
            <button class="btn btn-secondary" @click="emit('close')">Schließen</button>
          </div>
        </template>

        <template v-else>
          <div class="phase-stepper">
            <div v-for="step in steps" :key="step.key"
                 class="phase-step"
                 :class="{ active: step.active, done: step.done, error: step.error }">
              <span class="phase-dot"></span>
              <span class="phase-label">{{ step.label }}</span>
            </div>
          </div>

          <div class="update-log" ref="logBox">
            <div v-for="(line, i) in logLines" :key="i" class="log-line">{{ line }}</div>
            <div v-if="reconnecting" class="log-line reconnect">… Verbindung zum Container verloren — versuche erneut …</div>
          </div>

          <div v-if="state === 'error'" class="update-error">
            <p><strong>{{ errorHeadline }}</strong></p>
            <p v-if="errorAction" style="margin-top: 6px;">{{ errorAction }}</p>
            <p v-else style="margin-top: 6px;">Der laufende Container ist nicht betroffen.</p>
          </div>

          <div class="update-modal-footer">
            <button v-if="state === 'running'" class="btn btn-secondary" disabled>
              Bitte warten...
            </button>
            <button v-else-if="state === 'done'" class="btn btn-primary" @click="emit('reload')">
              Seite neu laden
            </button>
            <button v-else class="btn btn-secondary" @click="emit('close')">Schließen</button>
          </div>
        </template>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { UpdateState } from '../composables/useAppUpdate';

const props = defineProps<{
  open: boolean;
  state: UpdateState;
  currentPhase: string;
  logLines: string[];
  errorMessage: string;
  reconnecting: boolean;
  canStart: boolean;
  blockedReason: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'start'): void;
  (e: 'reload'): void;
}>();

/** Phases the backend updater reports, in the order they run. */
const PHASES = [
  { key: 'pulling',    label: 'Image laden' },
  { key: 'inspecting', label: 'Container prüfen' },
  { key: 'restarting', label: 'Container ersetzen' },
  { key: 'health',     label: 'Health-Check' },
  { key: 'done',       label: 'Fertig' },
] as const;

const steps = computed(() => {
  const cur = PHASES.findIndex(s => s.key === props.currentPhase);
  return PHASES.map((s, i) => ({
    key: s.key,
    label: s.label,
    // An unknown/empty phase marks nothing done — mirrors the original guard
    // order, where a missing phase index short-circuits before the done check.
    done: cur < 0 ? false : (props.state === 'done' ? true : i < cur),
    active: s.key === props.currentPhase,
    error: props.state === 'error' && s.key === props.currentPhase,
  }));
});

const errorHeadline = computed(() => {
  switch (props.errorMessage) {
    case 'docker_socket_unreachable': return 'Docker-Socket nicht erreichbar';
    case 'host_data_dir_missing':     return 'HOST_DATA_DIR fehlt';
    case 'missing_confirm_header':    return 'Schutz vor versehentlichem Update';
    case 'start_failed':               return 'Update konnte nicht gestartet werden';
    case 'rollback':                   return 'Update fehlgeschlagen — Container zurückgerollt';
    case '':                            return 'Update fehlgeschlagen';
    default:                            return `Update fehlgeschlagen: ${props.errorMessage.replace(/_/g, ' ')}`;
  }
});

const errorAction = computed(() => {
  switch (props.errorMessage) {
    case 'docker_socket_unreachable':
      return 'Bitte /var/run/docker.sock als Bind-Mount in deinem Container-Template hinzufügen. Danach Container neu starten.';
    case 'host_data_dir_missing':
      return 'Setze die HOST_DATA_DIR-Umgebungsvariable auf den Host-Pfad, den du auf /app/data mountest.';
    case 'rollback':
      return 'Der vorherige Container wurde automatisch wiederhergestellt. Siehe Log oben für Details.';
    case 'missing_confirm_header':
      return 'Bitte den Update-Button erneut klicken.';
    default:
      return '';
  }
});

// Keep the live tail pinned to the bottom. The composable hands us a NEW array
// on every append, so a plain identity watch fires even when the 200-line cap
// trims one line per push and the length stays put.
const logBox = ref<HTMLElement | null>(null);
watch(() => props.logLines, () => {
  nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  });
});
</script>

<style scoped>
.update-overlay {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.update-modal {
  background: var(--bg-card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 28px;
  max-width: 520px;
  width: calc(100% - 32px);
}
.update-modal h3 { font-size: 1.15rem; margin-bottom: 8px; }
.update-modal h3 code {
  background: rgba(255, 255, 255, 0.08);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.85em;
  color: var(--accent);
}
.update-steps {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: 16px;
}
.update-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
.update-error {
  background: rgba(231, 76, 60, 0.12);
  border: 1px solid rgba(231, 76, 60, 0.4);
  color: var(--text-primary);
  padding: 10px 12px;
  border-radius: 8px;
  font-size: var(--fs-sm);
  margin: 12px 0;
}
/* Shared with the dashboard's update banners — the modal is a separate SFC now,
   so the accent button style has to live here too (scoped styles don't leak). */
.update-btn {
  background: var(--accent);
  color: white;
  font-weight: 600;
  padding: 6px 16px;
  white-space: nowrap;
}
.update-btn:hover { background: var(--accent-hover); }
.update-btn:disabled { opacity: 0.6; cursor: default; }
.phase-stepper {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 16px 0 12px;
  padding: 10px 0;
  font-size: var(--fs-xs);
}
.phase-step { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); opacity: 0.55; transition: all 0.2s; }
.phase-step.done { color: var(--ok); opacity: 1; }
.phase-step.active { color: var(--accent); opacity: 1; font-weight: 600; }
.phase-step.error { color: var(--err); opacity: 1; }
.phase-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.phase-step.active .phase-dot { animation: phase-pulse 1.2s ease-in-out infinite; }
@keyframes phase-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50%      { transform: scale(1.4); opacity: 0.6; }
}
.phase-label { white-space: nowrap; }
.update-log {
  background: var(--bg-primary);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 10px 12px;
  height: 180px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.45;
  color: var(--text-secondary);
  margin: 8px 0 4px;
}
.log-line { white-space: pre-wrap; word-break: break-all; }
.log-line.reconnect { color: var(--warn); font-style: italic; margin-top: 4px; }

.wizard-fade-enter-active { transition: opacity 0.2s ease; }
.wizard-fade-leave-active { transition: opacity 0.15s ease; }
.wizard-fade-enter-from, .wizard-fade-leave-to { opacity: 0; }
</style>
