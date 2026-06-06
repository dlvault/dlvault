<template>
  <Transition name="scroll-top">
    <button
      v-if="visible"
      class="scroll-top-btn"
      @click="scrollToTop"
      aria-label="Nach oben scrollen"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 15l-6-6-6 6"/>
      </svg>
    </button>
  </Transition>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const visible = ref(false);

function onScroll() {
  visible.value = window.scrollY > 400;
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true });
});

onUnmounted(() => {
  window.removeEventListener('scroll', onScroll);
});
</script>

<style scoped>
.scroll-top-btn {
  position: fixed;
  bottom: 80px;
  right: 16px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  display: none;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  transition: background var(--duration-fast), border-color var(--duration-fast);
  z-index: 90;
}

.scroll-top-btn:hover {
  border-color: var(--accent);
  background: var(--bg-card);
}

.scroll-top-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .scroll-top-btn {
    display: flex;
    bottom: calc(72px + env(safe-area-inset-bottom, 0px));
  }
}

.scroll-top-enter-active { transition: all 0.2s ease; }
.scroll-top-leave-active { transition: all 0.15s ease; }
.scroll-top-enter-from { opacity: 0; transform: translateY(10px); }
.scroll-top-leave-to { opacity: 0; transform: translateY(10px); }
</style>
