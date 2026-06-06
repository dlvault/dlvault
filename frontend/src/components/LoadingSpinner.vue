<template>
  <div class="spinner-wrapper" :class="{ 'spinner-inline': inline }">
    <div class="spinner" role="status" aria-label="Wird geladen"></div>
    <span v-if="text" class="spinner-text">{{ text }}</span>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  text?: string;
  inline?: boolean;
}>();
</script>

<style scoped>
.spinner-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 0;
}

.spinner-wrapper.spinner-inline {
  flex-direction: row;
  padding: 0;
  gap: 8px;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinner-inline .spinner {
  width: 16px;
  height: 16px;
  border-width: 2px;
}

.spinner-text {
  color: var(--text-secondary);
  font-size: 0.9rem;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
