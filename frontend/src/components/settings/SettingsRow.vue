<template>
  <div :class="['sx-row', { 'toggle-row': toggle }]">
    <div class="sx-row-label">
      <span class="name">
        {{ label }}<span v-if="required" class="req">*</span>
      </span>
      <!-- v-html is used because hints carry intentional <strong>/<code> markup
           from the design spec; sources are static literals in our codebase. -->
      <span v-if="hint" class="hint" v-html="hint"></span>
    </div>
    <div class="sx-row-field">
      <slot />
      <div v-if="error" class="sx-error-text">{{ error }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  label: string;
  hint?: string;
  required?: boolean;
  toggle?: boolean;
  error?: string;
}>();
</script>

<style scoped>
.sx-row {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 28px;
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
  align-items: start;
}
.sx-row:last-child { border-bottom: none; }
.sx-row.toggle-row { align-items: center; grid-template-columns: 1fr auto; }

.sx-row-label {
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sx-row.toggle-row .sx-row-label { padding-top: 0; }
.sx-row-label .name {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sx-row-label .req {
  color: var(--accent);
  font-weight: 600;
}
.sx-row-label .hint {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
}
.sx-row-label .hint :deep(code) {
  font-family: var(--font-mono);
  background: var(--surface-2);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
  color: var(--text-secondary);
}
.sx-row-label .hint :deep(strong) {
  color: var(--text-secondary);
  font-weight: 600;
}

.sx-row-field { min-width: 0; }

.sx-error-text {
  margin-top: 6px;
  font-size: 12px;
  color: var(--err);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

@media (max-width: 1100px) {
  .sx-row { grid-template-columns: 1fr; gap: 8px; }
  .sx-row-label { padding-top: 0; }
}
</style>
