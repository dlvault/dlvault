<template>
  <div :class="['qx-group', { open }]" :style="{ '--stage-color': stageColor }">
    <button class="qx-group-header" type="button" @click="$emit('toggle')">
      <ChevronRight :size="14" :class="['chevron', { rotated: open }]" />
      <span class="qx-group-dot"></span>
      <span class="qx-group-title">
        <span class="lbl">{{ stageMono }}</span>
        <span class="count">{{ count }}</span>
      </span>
      <span v-if="hint" class="qx-group-hint">{{ hint }}</span>
    </button>
    <div v-if="open" class="qx-group-body">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next';

defineProps<{
  stageMono: string;
  stageColor: string;
  count: number;
  hint?: string;
  open: boolean;
}>();

defineEmits<{ (e: 'toggle'): void }>();
</script>

<style scoped>
.qx-group {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.qx-group + .qx-group { margin-top: 10px; }

.qx-group-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  cursor: pointer;
  user-select: none;
  background: transparent;
  border: none;
  width: 100%;
  text-align: left;
  font-family: inherit;
  color: inherit;
  border-bottom: 1px solid transparent;
  transition: background 0.15s, border-color 0.15s;
}
.qx-group.open .qx-group-header { border-bottom-color: var(--line); }
.qx-group-header:hover { background: var(--surface-2); }

.chevron {
  color: var(--text-3);
  transition: transform 0.2s;
  flex-shrink: 0;
}
.chevron.rotated { transform: rotate(90deg); }

.qx-group-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--stage-color);
  box-shadow: 0 0 6px var(--stage-color);
  flex-shrink: 0;
}

.qx-group-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex: 1;
}
.qx-group-title .lbl {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--stage-color);
  font-weight: 500;
}
.qx-group-title .count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.qx-group-hint {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
}

.qx-group-body {
  display: flex;
  flex-direction: column;
}
.qx-group-body > :deep(.qx-row:last-child) { border-bottom: none; }
</style>
