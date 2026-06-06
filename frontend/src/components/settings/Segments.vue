<template>
  <div class="sx-seg" role="radiogroup">
    <button
      v-for="o in options"
      :key="String(o.value)"
      type="button"
      role="radio"
      :aria-checked="modelValue === o.value"
      :class="{ active: modelValue === o.value }"
      @click="$emit('update:modelValue', o.value)"
    >{{ o.label }}</button>
  </div>
</template>

<script setup lang="ts" generic="T extends string | number">
defineProps<{
  modelValue: T;
  options: { value: T; label: string }[];
}>();
defineEmits<{ (e: 'update:modelValue', v: T): void }>();
</script>

<style scoped>
.sx-seg {
  display: inline-flex;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  padding: 2px;
  gap: 2px;
  max-width: 100%;
  overflow-x: auto;
}
.sx-seg::-webkit-scrollbar { display: none; }
.sx-seg button {
  padding: 6px 14px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
}
.sx-seg button.active {
  background: var(--surface);
  color: var(--text-primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}
.sx-seg button:hover:not(.active) { color: var(--text-primary); }
</style>
