<template>
  <Teleport to="body">
    <div class="toast-container" aria-live="polite">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          :class="['toast', 'toast-' + toast.type]"
          role="alert"
        >
          <span class="toast-icon">{{ iconMap[toast.type] }}</span>
          <span class="toast-text">{{ toast.message }}</span>
          <button class="toast-close" @click="remove(toast.id)" aria-label="Schließen">&times;</button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
}

const toasts = ref<Toast[]>([]);
let nextId = 0;

const iconMap: Record<string, string> = {
  success: '\u2713',
  error: '\u2717',
  warning: '\u26A0',
  info: '\u2139',
};

function add(message: string, type: Toast['type'] = 'info', duration = 5000) {
  const id = nextId++;
  toasts.value.push({ id, message, type });
  if (duration > 0) {
    setTimeout(() => remove(id), duration);
  }
}

function remove(id: number) {
  toasts.value = toasts.value.filter(t => t.id !== id);
}

defineExpose({ add, remove });
</script>

<style scoped>
.toast-container {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 400px;
}

.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 0.9rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(8px);
}

.toast-success { background: rgba(46, 204, 113, 0.9); color: #fff; }
.toast-error { background: rgba(231, 76, 60, 0.9); color: #fff; }
.toast-warning { background: rgba(243, 156, 18, 0.9); color: #fff; }
.toast-info { background: rgba(52, 152, 219, 0.9); color: #fff; }

.toast-icon { font-size: 1.1em; flex-shrink: 0; }
.toast-text { flex: 1; }

.toast-close {
  background: none;
  border: none;
  color: inherit;
  font-size: 1.2em;
  cursor: pointer;
  opacity: 0.7;
  padding: 0 2px;
  line-height: 1;
}

.toast-close:hover { opacity: 1; }

.toast-enter-active { transition: all 0.3s ease; }
.toast-leave-active { transition: all 0.2s ease; }
.toast-enter-from { transform: translateX(100%); opacity: 0; }
.toast-leave-to { transform: translateX(100%); opacity: 0; }

@media (max-width: 768px) {
  .toast-container {
    top: auto;
    bottom: 72px; /* above bottom nav (64px) + margin */
    right: 8px;
    left: 8px;
    max-width: none;
  }

  .toast {
    font-size: 0.85rem;
    padding: 10px 14px;
  }
}

@supports (padding-bottom: env(safe-area-inset-bottom)) {
  @media (max-width: 768px) {
    .toast-container {
      bottom: calc(72px + env(safe-area-inset-bottom));
    }
  }
}
</style>
