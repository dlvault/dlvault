<template>
  <span :class="['badge', 'badge-' + normalizedStatus]">
    {{ label }}
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { statusLabel } from '../composables/useFormatters';

const props = defineProps<{
  status: string;
  label?: string;
}>();

// Normalize uncommon status strings to a known channel so the dot/pulse styling kicks in.
const KNOWN = new Set([
  'pending', 'searching', 'found', 'downloading', 'extracting',
  'downloaded', 'not_found', 'info', 'secondary',
  'not_available', 'no_download', 'quality_mismatch',
]);

const normalizedStatus = computed(() => (KNOWN.has(props.status) ? props.status : 'secondary'));

const label = computed(() => props.label ?? statusLabel(props.status));
</script>
