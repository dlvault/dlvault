<template>
  <Transition name="save-bar">
    <div v-if="changes > 0" class="save-bar" role="status">
      <div class="save-bar-msg">
        <span class="badge">{{ changes }}</span>
        ungespeicherte Änderung{{ changes !== 1 ? 'en' : '' }}
      </div>
      <button v-if="errorHint" class="save-bar-error" type="button" @click="$emit('jump')">
        <AlertTriangle :size="12" />
        <span>{{ errorHint }}</span>
      </button>
      <div class="save-bar-actions">
        <button class="btn btn-ghost" type="button" :disabled="saving" @click="$emit('discard')">
          Verwerfen
        </button>
        <button class="btn btn-primary" type="button" :disabled="saving" @click="$emit('save')">
          <Check :size="14" />
          <span>{{ saving ? 'Speichere…' : 'Speichern' }}</span>
        </button>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { Check, AlertTriangle } from 'lucide-vue-next';

defineProps<{
  changes: number;
  saving?: boolean;
  /** e.g. "Fehler in: Telegram" — clicking jumps to the offending tab. */
  errorHint?: string | null;
}>();
defineEmits<{
  (e: 'save'): void;
  (e: 'discard'): void;
  (e: 'jump'): void;
}>();
</script>

<style scoped>
.save-bar {
  position: fixed;
  bottom: 24px;
  /* Centered relative to the content area (offset by half the 240px main
     sidebar). On mobile the responsive rule below kills the offset. */
  left: 50%;
  max-width: calc(100vw - 48px);
  transform: translate(calc(-50% + 120px), 0);
  background: rgba(26, 28, 33, 0.92);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  border: 1px solid var(--line-2);
  border-radius: 999px;
  padding: 7px 7px 7px 18px;
  display: flex;
  align-items: center;
  gap: 14px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.3);
  z-index: 50;
}

.save-bar-msg {
  font-size: 13px;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.save-bar-msg .badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  background: var(--warn);
  color: #0b0c0e;
  border-radius: 999px;
  letter-spacing: 0.02em;
}

.save-bar-error {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px;
  border: 1px solid color-mix(in srgb, var(--err) 45%, transparent);
  background: color-mix(in srgb, var(--err) 12%, transparent);
  border-radius: 999px;
  color: var(--err);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s;
}
.save-bar-error:hover {
  background: color-mix(in srgb, var(--err) 20%, transparent);
}

.save-bar-actions {
  display: flex;
  gap: 6px;
}
.save-bar-actions .btn { padding: 7px 14px; }

.save-bar-enter-active, .save-bar-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.save-bar-enter-from {
  opacity: 0;
  transform: translate(calc(-50% + 120px), 30px);
}
.save-bar-leave-to {
  opacity: 0;
  transform: translate(calc(-50% + 120px), 30px);
}

@media (max-width: 768px) {
  .save-bar {
    left: 12px;
    right: 12px;
    transform: none;
    border-radius: var(--r-md);
    bottom: 12px;
  }
  .save-bar-enter-from { opacity: 0; transform: translateY(30px); }
  .save-bar-leave-to   { opacity: 0; transform: translateY(30px); }
}
</style>
