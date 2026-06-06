<template>
  <div class="dl-disks">
    <div v-for="d in disks" :key="d.key" class="dl-disk">
      <div class="dl-disk-head">
        <div class="dl-disk-path">{{ d.path }}</div>
        <div class="dl-disk-free"><strong>{{ fmtDiskGB(d.freeGB) }}</strong> frei</div>
      </div>
      <div class="dl-disk-bar">
        <div :class="['fill', d.tone]" :style="{ width: d.usedPercent + '%' }"></div>
      </div>
      <div class="dl-disk-foot">
        <span>{{ d.label }}</span>
        <span><strong>{{ fmtDiskGB(d.usedGB) }}</strong> / {{ fmtDiskGB(d.totalGB) }} · {{ Math.round(d.usedPercent) }}%</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { fmtDiskGB } from './downloadPackage';

interface DiskRow {
  key: string;
  path: string;
  label: string;
  totalGB: number;
  freeGB: number;
  usedGB: number;
  usedPercent: number;
  tone: string;
}

defineProps<{ disks: DiskRow[] }>();
</script>

<style scoped>
/* ───── Disk usage strip ───── */
.dl-disks {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.dl-disk {
  background: var(--surface);
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dl-disk-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.dl-disk-path {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  font-weight: 600;
  letter-spacing: 0.01em;
}
.dl-disk-free {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.dl-disk-free strong { color: var(--ok); font-weight: 600; }
.dl-disk-bar {
  height: 4px;
  background: var(--surface-3);
  border-radius: 999px;
  overflow: hidden;
}
.dl-disk-bar .fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  border-radius: 999px;
  transition: width 0.4s ease;
}
.dl-disk-bar .fill.warn { background: linear-gradient(90deg, var(--warn), #ffd068); }
.dl-disk-bar .fill.err { background: linear-gradient(90deg, var(--err), #ffb3a8); }
.dl-disk-foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.dl-disk-foot strong { color: var(--text-secondary); }

@media (max-width: 1100px) {
  .dl-disks { grid-template-columns: 1fr; }
}
</style>
