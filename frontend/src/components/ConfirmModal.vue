<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible" ref="modalRoot" class="modal-backdrop" @click.self="cancel" @keydown.escape="cancel" role="dialog" aria-modal="true" :aria-label="title">
        <div class="modal-box" ref="modalBox">
          <h3 class="modal-title">{{ title }}</h3>
          <p class="modal-message">{{ message }}</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" @click="cancel" ref="cancelBtn">Abbrechen</button>
            <button :class="['btn', danger ? 'btn-danger' : 'btn-primary']" @click="confirm">
              {{ confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';
import { useModalA11y } from '../composables/useModalA11y';

const visible = ref(false);
const title = ref('');
const message = ref('');
const confirmText = ref('Bestätigen');
const danger = ref(false);
const cancelBtn = ref<HTMLButtonElement>();
const modalRoot = ref<HTMLElement>();
useModalA11y(visible, modalRoot);

let resolvePromise: ((value: boolean) => void) | null = null;

function show(opts: { title: string; message: string; confirmText?: string; danger?: boolean }): Promise<boolean> {
  title.value = opts.title;
  message.value = opts.message;
  confirmText.value = opts.confirmText || 'Bestätigen';
  danger.value = opts.danger ?? true;
  visible.value = true;

  nextTick(() => cancelBtn.value?.focus());

  return new Promise(resolve => {
    resolvePromise = resolve;
  });
}

function confirm() {
  visible.value = false;
  resolvePromise?.(true);
}

function cancel() {
  visible.value = false;
  resolvePromise?.(false);
}

defineExpose({ show });
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9998;
  backdrop-filter: blur(2px);
}

.modal-box {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  max-width: 420px;
  width: 90%;
}

.modal-title {
  font-size: 1.1rem;
  margin-bottom: 10px;
  color: var(--text-primary);
}

.modal-message {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin-bottom: 20px;
  line-height: 1.5;
}

.modal-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.modal-enter-active { transition: opacity 0.2s; }
.modal-leave-active { transition: opacity 0.15s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }

@media (max-width: 768px) {
  .modal-box {
    width: 94%;
    padding: 20px 16px;
  }

  .modal-actions {
    flex-direction: column-reverse;
    gap: 8px;
  }

  .modal-actions .btn {
    width: 100%;
    justify-content: center;
    min-height: 44px;
  }
}
</style>
