<template>
  <div class="skeleton-wrapper" :class="'skeleton-' + variant" role="status" aria-label="Wird geladen">
    <template v-if="variant === 'stats'">
      <div class="stats-grid">
        <div v-for="i in count" :key="i" class="stat-card skeleton-pulse">
          <div class="skeleton-line" style="width: 60%; height: 2rem; margin: 0 auto 8px;"></div>
          <div class="skeleton-line" style="width: 80%; height: 0.75rem; margin: 0 auto;"></div>
        </div>
      </div>
    </template>

    <template v-else-if="variant === 'table'">
      <div class="card">
        <div class="skeleton-line" style="width: 30%; height: 1rem; margin-bottom: 16px;"></div>
        <div v-for="i in count" :key="i" class="skeleton-table-row skeleton-pulse">
          <div class="skeleton-line" style="width: 35%;"></div>
          <div class="skeleton-line" style="width: 15%;"></div>
          <div class="skeleton-line" style="width: 20%;"></div>
          <div class="skeleton-line" style="width: 20%;"></div>
        </div>
      </div>
    </template>

    <template v-else-if="variant === 'grid'">
      <div class="library-grid">
        <div v-for="i in count" :key="i" class="skeleton-card skeleton-pulse">
          <div class="skeleton-poster"></div>
          <div style="padding: 8px 10px;">
            <div class="skeleton-line" style="width: 80%; margin-bottom: 6px;"></div>
            <div class="skeleton-line" style="width: 40%; height: 0.65rem;"></div>
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="variant === 'downloads'">
      <div class="card">
        <div class="skeleton-line" style="width: 30%; height: 1rem; margin-bottom: 16px;"></div>
        <div v-for="i in count" :key="i" class="skeleton-download skeleton-pulse">
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <div class="skeleton-line" style="width: 50%;"></div>
            <div class="skeleton-line" style="width: 15%;"></div>
          </div>
          <div class="skeleton-line" style="width: 100%; height: 6px; border-radius: 3px;"></div>
        </div>
      </div>
    </template>

    <span class="sr-only">Inhalt wird geladen...</span>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  variant: 'stats' | 'table' | 'grid' | 'downloads';
  count?: number;
}>();
</script>

<style scoped>
.skeleton-line {
  height: 0.85rem;
  background: var(--bg-input);
  border-radius: 4px;
}

.skeleton-pulse {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.skeleton-table-row {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}

.skeleton-card {
  background: var(--bg-secondary);
  border-radius: 8px;
  overflow: hidden;
}

.skeleton-poster {
  aspect-ratio: 2/3;
  background: var(--bg-primary);
}

.skeleton-download {
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 12px;
}

.library-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 12px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
}
</style>
