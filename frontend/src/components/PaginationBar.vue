<template>
  <div v-if="totalPages > 1" class="pagination-bar" role="navigation" aria-label="Seitennavigation">
    <span class="pagination-info">
      {{ startItem }}–{{ endItem }} von {{ totalItems }}
    </span>
    <div class="pagination-controls">
      <button
        class="pagination-btn"
        :disabled="!hasPrev"
        @click="$emit('prev')"
        aria-label="Vorherige Seite"
      >&lsaquo;</button>
      <span class="pagination-page">{{ page }} / {{ totalPages }}</span>
      <button
        class="pagination-btn"
        :disabled="!hasNext"
        @click="$emit('next')"
        aria-label="Nächste Seite"
      >&rsaquo;</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  page: number;
  totalPages: number;
  totalItems: number;
  perPage: number;
  hasPrev: boolean;
  hasNext: boolean;
}>();

defineEmits(['prev', 'next']);

const startItem = computed(() => (props.page - 1) * props.perPage + 1);
const endItem = computed(() => Math.min(props.page * props.perPage, props.totalItems));
</script>

<style scoped>
.pagination-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0 0;
  margin-top: 12px;
  border-top: 1px solid var(--border);
}

.pagination-info {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.pagination-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pagination-page {
  font-size: 0.85rem;
  color: var(--text-secondary);
  min-width: 50px;
  text-align: center;
}

.pagination-btn {
  background: var(--bg-input);
  border: 1px solid var(--border);
  color: var(--text-primary);
  width: 32px;
  height: 32px;
  border-radius: var(--radius);
  font-size: 1.1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.pagination-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.pagination-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  .pagination-bar {
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }

  .pagination-btn {
    width: 40px;
    height: 40px;
    font-size: 1.2rem;
  }

  .pagination-info {
    width: 100%;
    text-align: center;
  }
}
</style>
