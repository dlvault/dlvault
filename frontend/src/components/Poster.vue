<template>
  <div class="poster" :class="size ? 'poster-' + size : ''">
    <img
      v-if="src && !failed"
      :src="src"
      :alt="title"
      loading="lazy"
      decoding="async"
      @error="failed = true"
    />
    <span v-else class="poster-letter">{{ letter }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

const props = defineProps<{
  imdbId?: string | null;
  title: string;
  size?: 'sm' | 'md' | 'lg';
}>();

const failed = ref(false);
const letter = computed(() => (props.title || '?').charAt(0).toUpperCase());
const src = computed(() => {
  if (!props.imdbId || !/^tt\d+$/i.test(props.imdbId)) return null;
  return `/api/poster/${props.imdbId}`;
});
</script>

<style scoped>
.poster {
  aspect-ratio: 2 / 3;
  width: 100%;
  height: 100%;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
  position: relative;
}

.poster-sm { width: 40px; height: auto; }
.poster-md { width: 56px; height: auto; }
.poster-lg { width: 96px; height: auto; }

.poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.poster-letter {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 24px;
  color: rgba(255, 255, 255, 0.4);
  pointer-events: none;
}
</style>
