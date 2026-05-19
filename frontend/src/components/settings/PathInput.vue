<template>
  <div class="sx-path">
    <input
      type="text"
      :value="modelValue"
      :placeholder="placeholder"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button type="button" @click="$emit('browse')">Browse</button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  modelValue: string;
  placeholder?: string;
}>();
defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'browse'): void;
}>();
</script>

<style scoped>
.sx-path {
  display: flex;
  gap: 0;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--surface-2);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.sx-path:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.sx-path input {
  flex: 1;
  padding: 9px 12px;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12.5px;
  outline: none;
  min-width: 0;
}
.sx-path button {
  padding: 0 14px;
  background: var(--surface-3);
  border: none;
  border-left: 1px solid var(--line);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.sx-path button:hover { background: var(--line-2); color: var(--text-primary); }
</style>
