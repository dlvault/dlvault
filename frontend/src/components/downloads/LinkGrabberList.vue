<template>
  <div class="dl-lg-list">
    <div v-for="(pkg, i) in packages" :key="pkg.uuid" class="dl-lg-row">
      <div class="dl-lg-pos">{{ String(i + 1).padStart(2, '0') }}</div>
      <div class="dl-lg-name">
        <span class="title">{{ parsed(pkg.name).title }}</span>
        <span v-if="parsed(pkg.name).year" class="year">{{ parsed(pkg.name).year }}</span>
        <span v-if="quality(pkg.name)" class="dl-lg-quality">{{ quality(pkg.name) }}</span>
      </div>
      <div class="dl-lg-size">{{ pkg.bytesTotal ? formatBytes(pkg.bytesTotal) : '—' }}</div>
      <div class="dl-lg-actions">
        <button class="icon-btn" title="Starten" @click="$emit('start', pkg)"><Play :size="14" /></button>
        <button class="icon-btn danger" title="Entfernen" @click="$emit('remove', pkg)"><Trash2 :size="14" /></button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { DownloadPackage } from '../../types/index';
import { formatBytes } from '../../composables/useFormatters';
import { parsed, quality } from './downloadPackage';
import { Play, Trash2 } from 'lucide-vue-next';

defineProps<{ packages: DownloadPackage[] }>();

defineEmits<{
  (e: 'start', pkg: DownloadPackage): void;
  (e: 'remove', pkg: DownloadPackage): void;
}>();
</script>

<style scoped>
/* ───── LinkGrabber ───── */
.dl-lg-list {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.dl-lg-row {
  display: grid;
  grid-template-columns: 30px 1fr auto auto;
  gap: 14px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
  align-items: center;
}
.dl-lg-row:last-child { border-bottom: none; }
.dl-lg-row:hover { background: var(--surface-2); }
.dl-lg-pos {
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
  text-align: center;
}
.dl-lg-name {
  font-size: 13.5px;
  color: var(--text-primary);
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.dl-lg-name .title {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dl-lg-name .year {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 13px;
  color: var(--text-secondary);
}
.dl-lg-quality {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-3);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 5px;
  letter-spacing: 0.04em;
}
.dl-lg-size {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.dl-lg-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.dl-lg-row:hover .dl-lg-actions { opacity: 1; }

@media (max-width: 768px) {
  .dl-lg-actions { opacity: 1; }
}
</style>
