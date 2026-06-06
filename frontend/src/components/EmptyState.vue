<template>
  <div class="empty-state">
    <div class="empty-icon">
      <component v-if="iconComponent" :is="iconComponent" :size="36" :stroke-width="1.4" />
      <span v-else aria-hidden="true">{{ icon }}</span>
    </div>
    <p class="empty-title">{{ title }}</p>
    <p v-if="description" class="empty-description">{{ description }}</p>
    <router-link v-if="actionTo" :to="actionTo" class="btn btn-primary" style="margin-top: 16px;">
      {{ actionLabel }}
    </router-link>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Component } from 'vue';
import {
  AlertTriangle, CalendarDays, Coffee, Compass, FileText, Inbox,
  Popcorn, ScrollText, Search, Trophy,
} from 'lucide-vue-next';

const props = defineProps<{
  icon: string;
  title: string;
  description?: string;
  actionTo?: string;
  actionLabel?: string;
}>();

// Static registry — keeps the bundle small (no `import *`).
const REGISTRY: Record<string, Component> = {
  AlertTriangle, CalendarDays, Coffee, Compass, FileText, Inbox,
  Popcorn, ScrollText, Search, Trophy,
};

const iconComponent = computed<Component | null>(() => {
  const name = props.icon;
  if (!name || /^[^A-Za-z]/.test(name)) return null;
  return REGISTRY[name] ?? null;
});
</script>

<style scoped>
.empty-state {
  text-align: center;
  padding: 48px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.empty-icon {
  margin-bottom: 18px;
  width: 72px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent-soft);
  border: 1px solid rgba(240, 107, 130, 0.18);
  color: var(--accent);
  font-size: 2.2rem;
}

.empty-title {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: var(--accent-2);
  font-size: 1.5rem;
  letter-spacing: -0.01em;
  margin-bottom: 8px;
  line-height: 1.2;
}

.empty-description {
  color: var(--text-secondary);
  font-size: 0.9rem;
  max-width: 420px;
  margin: 0 auto;
  line-height: 1.55;
}
</style>
