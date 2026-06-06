<template>
  <div
    :class="['mp', 'size-' + size, { 'has-image': showImage && imgLoaded }]"
    :style="{ background: gradient }"
    :aria-label="`${title}${year ? ' (' + year + ')' : ''}`"
  >
    <!-- Gradient + title fallback layer — visible until the real poster paints,
         and visible permanently if the poster 404s or no imdbId is provided.
         Keeping it always rendered behind the image prevents the empty-tile
         flash that the previous (show-OR-fallback) layout produced while
         /api/poster/* roundtripped to OMDb. -->
    <div v-if="year && showMeta" class="mp-year">{{ year }}</div>
    <div v-if="rating && showMeta" class="mp-rating">{{ rating }}</div>
    <div v-if="showTitle" class="mp-title">{{ title }}</div>

    <img
      v-if="showImage"
      :src="src!"
      :alt="title"
      loading="lazy"
      decoding="async"
      class="mp-img"
      :class="{ loaded: imgLoaded }"
      @load="imgLoaded = true"
      @error="imgFailed = true"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { posterGradient } from '../composables/useFormatters';

const props = withDefaults(defineProps<{
  imdbId?: string | null;
  title: string;
  year?: number | string;
  rating?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
}>(), { size: 'md' });

const imgFailed = ref(false);
const imgLoaded = ref(false);

const src = computed(() => {
  if (!props.imdbId || !/^tt\d+$/i.test(props.imdbId)) return null;
  return `/api/poster/${props.imdbId}`;
});

const showImage = computed(() => !!src.value && !imgFailed.value);

// Size-dependent feature visibility — small posters hide meta to stay legible.
const showMeta = computed(() => props.size === 'md' || props.size === 'lg' || props.size === 'xl');
const showTitle = computed(() => props.size !== 'xs');

// Deterministic gradient per title — same movie always gets the same look.
const gradient = computed(() => posterGradient(props.title));
</script>

<style scoped>
.mp {
  position: relative;
  overflow: hidden;
  border-radius: var(--r-md);
  border: 1px solid var(--line);
  flex-shrink: 0;
  isolation: isolate;
}

.mp-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  /* Fade in once the real poster decodes — the gradient fallback stays
     visible until then, so there's no empty-tile flash while OMDb roundtrips. */
  opacity: 0;
  transition: opacity 0.2s ease;
  z-index: 2;
}
.mp-img.loaded { opacity: 1; }

/* Gradient-mode atmospherics — skipped when a real poster is loaded */
.mp:not(.has-image)::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 40%;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.10), transparent);
  pointer-events: none;
  z-index: 0;
}
.mp:not(.has-image)::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 80% at 50% 110%, rgba(0, 0, 0, 0.55), transparent 60%),
    radial-gradient(140% 60% at 50% -20%, rgba(255, 255, 255, 0.06), transparent 60%);
  pointer-events: none;
  z-index: 0;
}

.mp-year {
  position: absolute;
  top: 8px;
  left: 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: rgba(255, 255, 255, 0.7);
  letter-spacing: 0.1em;
  z-index: 1;
}

.mp-rating {
  position: absolute;
  top: 8px;
  right: 8px;
  font-family: var(--font-mono);
  font-size: 9px;
  color: rgba(255, 255, 255, 0.75);
  letter-spacing: 0.06em;
  padding: 2px 5px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  text-transform: uppercase;
  z-index: 1;
}

.mp-title {
  position: absolute;
  inset: auto 10px 10px 10px;
  font-family: var(--font-serif);
  font-style: italic;
  color: rgba(255, 255, 255, 0.96);
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.7);
  line-height: 1.0;
  letter-spacing: -0.005em;
  z-index: 1;
}

.size-xs { width: 24px;  height: 36px;  border-radius: 4px; }
.size-xs .mp-title { font-size: 0; }

.size-sm { width: 40px;  height: 60px;  border-radius: 5px; }
.size-sm .mp-title { font-size: 11px; inset: auto 4px 4px 4px; }

.size-md { width: 56px;  height: 84px;  border-radius: 6px; }
.size-md .mp-title { font-size: 12px; inset: auto 5px 5px 5px; }

.size-lg { width: 120px; height: 180px; }
.size-lg .mp-title { font-size: 16px; }

.size-xl { width: 160px; height: 240px; }
.size-xl .mp-title { font-size: 20px; }
</style>
