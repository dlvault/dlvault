<template>
  <div class="sx-chips">
    <button
      v-for="o in options"
      :key="o"
      type="button"
      :class="['sx-chip', { on: modelValue.includes(o) }]"
      @click="toggle(o)"
    >
      {{ o }}<span v-if="allowRemove && modelValue.includes(o)" class="x">×</span>
    </button>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  modelValue: string[];
  options: string[];
  allowRemove?: boolean;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string[]): void }>();

function toggle(o: string) {
  if (props.modelValue.includes(o)) {
    emit('update:modelValue', props.modelValue.filter(v => v !== o));
  } else {
    emit('update:modelValue', [...props.modelValue, o]);
  }
}
</script>

<style scoped>
.sx-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.sx-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.sx-chip:hover { border-color: var(--line-2); color: var(--text-primary); }
.sx-chip.on {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--accent);
}
.sx-chip .x { color: var(--text-3); font-family: var(--font-mono); font-size: 11px; }
</style>
