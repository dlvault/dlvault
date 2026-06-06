<template>
  <div
    :class="['lx-poster', { 'is-selected': selected, 'has-image': imgLoaded }]"
    :style="{ background: gradient }"
    role="button"
    :tabindex="0"
    :aria-label="`${title}${year ? ' (' + year + ')' : ''}`"
    @click="$emit('open')"
    @keydown.enter.prevent="$emit('open')"
    @keydown.space.prevent="$emit('open')"
  >
    <!-- Gradient-mode atmospherics (top sheen + bottom vignette) — masked once a real image is loaded. -->
    <div class="lx-poster-year" v-if="year">{{ year }}</div>
    <div v-if="quality" :class="['lx-poster-quality', { 'is-4k': quality === '4K' }]">{{ quality }}</div>
    <div v-if="title" class="lx-poster-title">{{ title }}</div>
    <span v-if="mediaType === 'show'" class="lx-poster-type">Serie</span>

    <img
      v-if="posterUrl && !imgFailed"
      :src="posterUrl"
      :alt="title"
      loading="lazy"
      decoding="async"
      class="lx-poster-img"
      :class="{ loaded: imgLoaded }"
      @load="imgLoaded = true"
      @error="imgFailed = true"
    />

    <!-- Hover detail overlay -->
    <div class="lx-poster-overlay">
      <div class="actions" @click.stop>
        <button
          v-if="canDelete"
          class="danger"
          type="button"
          :aria-label="`${title} aus Mediathek löschen`"
          @click.stop="$emit('delete')"
        ><Trash2 :size="13" /></button>
      </div>
      <div v-if="genres && genres.length" class="genres">
        <span v-for="g in genres.slice(0, 2)" :key="g">{{ g }}</span>
      </div>
      <div class="name">{{ title }}</div>
      <div class="meta">
        <span v-if="rating != null" class="rating"><Star :size="9" /> {{ rating.toFixed(1) }}</span>
        <template v-if="rating != null && (runtimeLabel || qualityShort)"><span class="pip">·</span></template>
        <span v-if="runtimeLabel">{{ runtimeLabel }}</span>
        <template v-if="runtimeLabel && qualityShort"><span class="pip">·</span></template>
        <span v-if="qualityShort">{{ qualityShort }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Trash2, Star } from 'lucide-vue-next';
import { posterGradient } from '../../composables/useFormatters';

const props = withDefaults(defineProps<{
  title: string;
  year?: number | string | null;
  mediaType?: 'movie' | 'show';
  posterUrl?: string | null;
  quality?: string | null;
  rating?: number | null;
  runtimeLabel?: string | null;
  genres?: string[] | null;
  selected?: boolean;
  canDelete?: boolean;
}>(), { canDelete: true });

defineEmits<{ open: []; delete: [] }>();

const imgLoaded = ref(false);
const imgFailed = ref(false);

// Quality echoed at the bottom of the hover overlay only when no other meta is shown.
// Top-right badge is the canonical quality chip; this avoids a duplicate when both exist.
const qualityShort = computed(() => (props.quality && !props.rating && !props.runtimeLabel ? props.quality : null));

// Deterministic — same title always lands on the same gradient.
const gradient = computed(() => posterGradient(props.title));
</script>

<style scoped>
.lx-poster {
  position: relative;
  width: 100%;
  aspect-ratio: 2 / 3;
  border-radius: var(--r-md);
  overflow: hidden;
  border: 1px solid var(--line);
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
  isolation: isolate;
}
.lx-poster:not(.has-image)::before {
  content: '';
  position: absolute; inset: 0 0 auto 0;
  height: 40%;
  background: linear-gradient(180deg, rgba(255,255,255,0.10), transparent);
  pointer-events: none;
  z-index: 0;
}
.lx-poster:not(.has-image)::after {
  content: '';
  position: absolute; inset: 0;
  background:
    radial-gradient(120% 80% at 50% 110%, rgba(0,0,0,0.60), transparent 60%),
    radial-gradient(140% 60% at 50% -20%, rgba(255,255,255,0.06), transparent 60%);
  pointer-events: none;
  z-index: 0;
}
.lx-poster:hover {
  transform: translateY(-3px);
  border-color: var(--line-2);
  box-shadow: 0 10px 28px rgba(0,0,0,0.4);
}
.lx-poster:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.lx-poster.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.lx-poster-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  opacity: 0;
  transition: opacity 0.2s ease;
  z-index: 2;
}
.lx-poster-img.loaded { opacity: 1; }

.lx-poster-year {
  position: absolute;
  top: 8px; left: 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: rgba(255,255,255,0.78);
  letter-spacing: 0.08em;
  z-index: 3;
}
.lx-poster-quality {
  position: absolute;
  top: 7px; right: 7px;
  z-index: 3;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba(0,0,0,0.5);
  color: rgba(255,255,255,0.85);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.lx-poster-quality.is-4k {
  background: rgba(240, 107, 130, 0.85);
  color: #0b0c0e;
  font-weight: 700;
}

.lx-poster-title {
  position: absolute;
  inset: auto 10px 10px 10px;
  font-family: var(--font-serif);
  font-style: italic;
  color: rgba(255,255,255,0.96);
  text-shadow: 0 2px 8px rgba(0,0,0,0.7);
  line-height: 1.0;
  z-index: 3;
  font-size: clamp(14px, 1.7vw, 18px);
}
.lx-poster.has-image .lx-poster-title { opacity: 0; transition: opacity 0.2s; }
.lx-poster.has-image:hover .lx-poster-title { opacity: 1; }

.lx-poster-type {
  position: absolute;
  bottom: 8px; right: 8px;
  z-index: 3;
  font-family: var(--font-mono);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba(0,0,0,0.55);
  color: rgba(255,255,255,0.85);
  backdrop-filter: blur(4px);
}
.lx-poster:hover .lx-poster-type { display: none; }

/* Hover overlay */
.lx-poster-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.5) 50%, rgba(0,0,0,0.92) 100%);
  padding: 12px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 6px;
  opacity: 0;
  transition: opacity 0.2s ease;
  z-index: 4;
}
.lx-poster:hover .lx-poster-overlay,
.lx-poster:focus-visible .lx-poster-overlay {
  opacity: 1;
}
.lx-poster-overlay .name {
  font-family: var(--font-sans);
  font-size: 13px; font-weight: 600;
  color: #fff;
  line-height: 1.25;
  letter-spacing: -0.005em;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.lx-poster-overlay .meta {
  display: flex; flex-wrap: wrap;
  gap: 4px 8px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.04em;
  color: rgba(255,255,255,0.75);
  font-variant-numeric: tabular-nums;
  align-items: center;
}
.lx-poster-overlay .meta:empty { display: none; }
.lx-poster-overlay .meta .rating {
  color: var(--accent-2);
  font-weight: 600;
  display: inline-flex; align-items: center; gap: 3px;
}
.lx-poster-overlay .meta .pip { color: rgba(255,255,255,0.35); }
.lx-poster-overlay .genres {
  display: flex; flex-wrap: wrap; gap: 4px;
}
.lx-poster-overlay .genres span {
  font-family: var(--font-mono);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba(255,255,255,0.12);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.85);
}
.lx-poster-overlay .actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex; gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.lx-poster:hover .lx-poster-overlay .actions { opacity: 1; }
.lx-poster-overlay .actions button {
  width: 26px; height: 26px;
  border-radius: var(--r-sm);
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  color: rgba(255,255,255,0.85);
  display: grid; place-items: center;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.lx-poster-overlay .actions button:hover {
  background: rgba(255,255,255,0.15);
  color: #fff;
}
.lx-poster-overlay .actions button.danger:hover {
  background: rgba(240, 123, 110, 0.85);
  color: #0b0c0e;
  border-color: rgba(240, 123, 110, 0.85);
}

/* Touch devices — overlays + actions stay reachable without hover. */
@media (hover: none) {
  .lx-poster-overlay { opacity: 0; }
  .lx-poster-overlay .actions { opacity: 0.85; }
  .lx-poster-type { display: inline-block; }
}
</style>
