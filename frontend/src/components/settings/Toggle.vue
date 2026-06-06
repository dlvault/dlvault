<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :class="['sx-toggle', { on: modelValue }]"
    @click="$emit('update:modelValue', !modelValue)"
  ></button>
</template>

<script setup lang="ts">
defineProps<{ modelValue: boolean }>();
defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();
</script>

<style scoped>
.sx-toggle {
  display: inline-flex;
  width: 38px;
  height: 22px;
  border-radius: 12px;
  background: var(--surface-3);
  position: relative;
  cursor: pointer;
  border: none;
  transition: background 0.15s;
  flex-shrink: 0;
  padding: 0;
}
.sx-toggle.on { background: var(--accent); }
.sx-toggle::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  transition: transform 0.15s;
}
.sx-toggle.on::before { transform: translateX(16px); }
</style>
