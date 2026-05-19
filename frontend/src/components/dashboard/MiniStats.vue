<template>
  <div class="mini-stats">
    <div class="mini-stat" style="--stage-color: var(--ok);">
      <div class="lbl">Gesamt</div>
      <div class="val">{{ formatNumber(totalMovies) }}</div>
      <div class="delta">
        <strong v-if="weekAdded > 0">+{{ weekAdded }}</strong>
        <span v-if="weekAdded > 0">&nbsp;diese Woche</span>
        <span v-else>in Watchlist</span>
      </div>
    </div>
    <div class="mini-stat" style="--stage-color: var(--warn);">
      <div class="lbl">Ausstehend</div>
      <div class="val">{{ pending }}</div>
      <div class="delta">
        <span v-if="oldestPendingAge">Älteste: {{ oldestPendingAge }}</span>
        <span v-else-if="pending === 0">Alle aufgearbeitet</span>
        <span v-else>Warten auf Sync</span>
      </div>
    </div>
    <div class="mini-stat" style="--stage-color: var(--busy);">
      <div class="lbl">Aktiv</div>
      <div class="val">{{ downloading }}</div>
      <div class="delta">
        <span v-if="downloading > 0">in JDownloader</span>
        <span v-else>keine aktiven</span>
      </div>
    </div>
    <div class="mini-stat" :style="{ '--stage-color': schedulerRunning ? 'var(--ok)' : 'var(--err)' }">
      <div class="lbl">Scheduler</div>
      <div class="val">{{ schedulerRunning ? 'Aktiv' : 'Aus' }}</div>
      <div class="delta">
        <span v-if="schedulerRunning">Automatischer Sync</span>
        <span v-else>Manuell starten</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  totalMovies: number;
  pending: number;
  downloading: number;
  schedulerRunning: boolean;
  weekAdded: number;
  oldestPendingAge: string;
}>();

function formatNumber(n: number | undefined): string {
  if (!n) return '0';
  return n.toLocaleString('de-DE');
}
</script>

<style scoped>
.mini-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.mini-stat {
  background: var(--surface);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mini-stat .lbl {
  display: flex;
  align-items: center;
  gap: 7px;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-3);
}
.mini-stat .lbl::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 2px;
  background: var(--stage-color, var(--accent));
}
.mini-stat .val {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.mini-stat .delta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.mini-stat .delta strong { color: var(--ok); font-weight: 500; }

@media (max-width: 768px) {
  .mini-stats { grid-template-columns: 1fr 1fr; }
}
</style>
