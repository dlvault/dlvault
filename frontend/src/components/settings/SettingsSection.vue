<template>
  <section class="sx-section">
    <h3 class="sx-section-label">{{ label }}</h3>
    <slot />
  </section>
</template>

<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<style scoped>
.sx-section { margin-top: 28px; }
.sx-section:first-of-type { margin-top: 0; }
.sx-section-label {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
  margin-bottom: 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 500;
}
.sx-section-label::before {
  content: '';
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-3);
}
</style>
