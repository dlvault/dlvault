<template>
  <Teleport to="body">
    <Transition name="install-banner">
      <div v-if="show" class="install-banner" role="alert">
        <div class="install-banner-content">
          <div class="install-banner-icon"><DownloadCloud :size="20" /></div>
          <div class="install-banner-text">
            <strong>dlvault installieren</strong>
            <span>Als App auf deinem Gerät nutzen</span>
          </div>
          <button class="install-btn" @click="handleInstall">Installieren</button>
          <button class="install-dismiss" @click="handleDismiss" aria-label="Schließen">&times;</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useInstallPrompt } from '../composables/useInstallPrompt';
import { DownloadCloud } from 'lucide-vue-next';

const { isInstallable, isInstalled, install, dismiss, dismissed } = useInstallPrompt();

const show = computed(() => isInstallable.value && !isInstalled.value && !dismissed.value);

async function handleInstall() {
  await install();
}

function handleDismiss() {
  dismiss();
}
</script>

<style scoped>
.install-banner {
  position: fixed;
  bottom: calc(72px + env(safe-area-inset-bottom, 0px));
  left: 0;
  right: 0;
  z-index: 9990;
  padding: 0 16px;
  pointer-events: none;
}

@media (min-width: 769px) {
  .install-banner {
    bottom: 16px;
  }
}

.install-banner-content {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: rgba(19, 20, 24, 0.92);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
  max-width: 480px;
  margin: 0 auto;
}

.install-banner-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
  flex-shrink: 0;
}

.install-banner-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.install-banner-text strong {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 600;
  letter-spacing: -0.005em;
}

.install-banner-text span {
  font-size: 12px;
  color: var(--text-secondary);
}

.install-btn {
  background: var(--accent);
  color: #0b0c0e;
  border: none;
  padding: 8px 14px;
  border-radius: var(--r-sm);
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s;
}

.install-btn:hover {
  background: var(--accent-hover);
}

.install-dismiss {
  background: none;
  border: none;
  color: var(--text-3);
  font-size: 1.3rem;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  flex-shrink: 0;
}

.install-dismiss:hover {
  color: var(--text-primary);
}

.install-banner-enter-active { transition: all 0.3s ease; }
.install-banner-leave-active { transition: all 0.2s ease; }
.install-banner-enter-from { transform: translateY(100%); opacity: 0; }
.install-banner-leave-to { transform: translateY(100%); opacity: 0; }

@media (max-width: 768px) {
  .install-banner {
    padding: 0 8px 8px;
  }
}
</style>
