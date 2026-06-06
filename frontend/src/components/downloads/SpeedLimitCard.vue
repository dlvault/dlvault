<template>
  <div class="dl-speedlimit">
    <div class="dl-speedlimit-text">
      <div class="dl-speedlimit-eyebrow">Bandbreitenlimit · JDownloader</div>
      <div class="dl-speedlimit-title">
        <template v-if="enabled && kbps > 0">
          Begrenzt auf <strong>{{ (kbps / 1024).toFixed(0) }} MB/s</strong>
          <span class="serif">ungefähr {{ Math.round((kbps / 1024) * 8) }} Mbit</span>
        </template>
        <template v-else>
          <strong>Unbegrenzt</strong> <span class="serif">volle Pipe</span>
        </template>
      </div>
      <div class="dl-speedlimit-sub">
        Gilt global für alle aktiven und kommenden Downloads — wird sofort übernommen.
      </div>
    </div>
    <div class="dl-speedlimit-presets" role="radiogroup" aria-label="Geschwindigkeitslimit">
      <button
        v-for="p in speedPresets"
        :key="p.label"
        :class="{ active: activePreset === p.kbps }"
        :aria-label="p.kbps ? `${p.label} MB/s` : 'Unbegrenzt'"
        @click="$emit('select', p.kbps)"
      >{{ p.label }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  enabled: boolean;
  kbps: number;
}>();

defineEmits<{ (e: 'select', kbps: number): void }>();

// MB/s → KB/s, ∞ = unlimited
const speedPresets = [
  { label: '1', kbps: 1024 },
  { label: '2', kbps: 2048 },
  { label: '5', kbps: 5120 },
  { label: '10', kbps: 10240 },
  { label: '20', kbps: 20480 },
  { label: '∞', kbps: 0 },
];
const activePreset = computed(() => (props.enabled && props.kbps > 0 ? props.kbps : 0));
</script>

<style scoped>
/* ───── Speed limit ───── */
.dl-speedlimit {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 18px 22px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 24px;
  align-items: center;
}
.dl-speedlimit-text { min-width: 0; }
.dl-speedlimit-eyebrow {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
  margin-bottom: 4px;
}
.dl-speedlimit-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.dl-speedlimit-title strong { font-weight: 600; color: var(--accent-2); }
.dl-speedlimit-title .serif {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 14px;
  color: var(--text-secondary);
}
.dl-speedlimit-sub {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  margin-top: 4px;
  letter-spacing: 0.02em;
}
.dl-speedlimit-presets {
  display: inline-flex;
  gap: 4px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px;
}
.dl-speedlimit-presets button {
  background: transparent;
  border: none;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  padding: 6px 12px;
  border-radius: 999px;
  cursor: pointer;
  font-weight: 600;
  letter-spacing: 0.04em;
  transition: background 0.15s, color 0.15s;
}
.dl-speedlimit-presets button:hover { color: var(--text-primary); }
.dl-speedlimit-presets button.active { background: var(--accent); color: #0b0c0e; }

@media (max-width: 768px) {
  .dl-speedlimit { grid-template-columns: 1fr; gap: 14px; }
}
</style>
