<template>
  <svg
    class="sparkline"
    :viewBox="`0 0 ${w} ${h}`"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <defs>
      <linearGradient :id="gid" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" :stop-color="color" stop-opacity="0.3" />
        <stop offset="100%" :stop-color="color" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path v-if="hasArea" :d="area" :fill="`url(#${gid})`" />
    <path
      :d="line"
      :stroke="color"
      stroke-width="1.4"
      fill="none"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  data: number[];
  color?: string;
  w?: number;
  h?: number;
}>(), {
  color: '#b794f4',
  w: 60,
  h: 24,
});

const gid = `sg-${Math.random().toString(36).slice(2, 8)}`;

const points = computed(() => {
  const d = props.data;
  if (!d || d.length < 2) return [];
  const max = Math.max(...d);
  const min = Math.min(...d);
  const range = max - min || 1;
  return d.map((v, i) => [
    (i / (d.length - 1)) * props.w,
    props.h - 2 - ((v - min) / range) * (props.h - 4),
  ] as [number, number]);
});

const hasArea = computed(() => points.value.length >= 2);

const line = computed(() => {
  if (points.value.length === 0) {
    return `M0 ${props.h - 2} L${props.w} ${props.h - 2}`;
  }
  return points.value
    .map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(' ');
});

const area = computed(() => `${line.value} L${props.w} ${props.h} L0 ${props.h} Z`);
</script>
