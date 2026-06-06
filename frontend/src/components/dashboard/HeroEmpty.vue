<template>
  <div class="hero fade-in">
    <div class="hero-glow"></div>
    <div class="hero-inner hero-empty">
      <div>
        <div class="hero-eyebrow">
          <span class="dot"></span>
          Bereit zum Einrichten
        </div>
        <h2>
          Lass uns deine<br />
          Mediathek <span class="accent-2">vernetzen.</span>
        </h2>
        <p>
          dlvault verbindet deine Watchlist mit JDownloader und deinem Media-Server.
          Konfiguriere die Verbindungen — dann steht dem ersten Sync nichts im Weg.
        </p>
      </div>
      <div class="setup-steps">
        <div v-for="step in steps" :key="step.key" class="setup-step" :class="{ done: step.done, active: !step.done && step.key === firstPendingKey }">
          <span class="num">
            <Check v-if="step.done" :size="12" />
            <template v-else>{{ step.idx }}</template>
          </span>
          <span class="lbl">{{ step.label }}</span>
          <span class="arr">{{ step.done ? '✓' : '→' }}</span>
        </div>
        <router-link to="/settings" class="btn btn-primary setup-cta">
          Zu den Einstellungen
        </router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Check } from 'lucide-vue-next';

const props = defineProps<{
  watchlistConfigured: boolean;
  jdConfigured: boolean;
  mediaServerConfigured: boolean;
}>();

const steps = computed(() => [
  { key: 'watchlist',   label: 'Watchlist verbinden',   done: props.watchlistConfigured,   idx: 1 },
  { key: 'jdownloader', label: 'JDownloader einrichten', done: props.jdConfigured,         idx: 2 },
  { key: 'mediaserver', label: 'Media-Server verbinden', done: props.mediaServerConfigured, idx: 3 },
]);

const firstPendingKey = computed(() => steps.value.find(s => !s.done)?.key ?? null);
</script>

<style scoped>
.hero {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.hero-glow {
  position: absolute;
  inset: 0;
  background: radial-gradient(600px 240px at 12% 20%, rgba(240, 107, 130, 0.08), transparent 70%);
  pointer-events: none;
}
.hero-inner {
  position: relative;
  padding: 26px 28px;
}
.hero-empty {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 32px;
  align-items: center;
}
.hero-eyebrow {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.hero-eyebrow .dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}
.hero-empty h2 {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 44px;
  letter-spacing: -0.02em;
  line-height: 1.05;
  color: var(--text-primary);
  margin-top: 12px;
}
.hero-empty .accent-2 { color: var(--accent-2); }
.hero-empty p {
  margin-top: 12px;
  color: var(--text-secondary);
  font-size: 14px;
  max-width: 480px;
  line-height: 1.55;
}
.setup-steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 280px;
}
.setup-step {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface-2);
  font-size: 13px;
}
.setup-step.done {
  border-color: rgba(74, 222, 128, 0.3);
  background: rgba(74, 222, 128, 0.06);
  color: var(--text-3);
}
.setup-step.active {
  border-color: rgba(240, 107, 130, 0.4);
  background: rgba(240, 107, 130, 0.06);
}
.setup-step .num {
  width: 22px; height: 22px;
  border-radius: 50%;
  background: var(--surface-3);
  display: grid;
  place-items: center;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 600;
}
.setup-step.done .num { background: var(--ok); color: #0b0c0e; }
.setup-step.active .num { background: var(--accent); color: #0b0c0e; }
.setup-step .lbl { flex: 1; color: var(--text-primary); font-weight: 500; }
.setup-step.done .lbl { color: var(--text-3); text-decoration: line-through; }
.setup-step .arr { color: var(--text-3); font-family: var(--font-mono); }
.setup-step.active .arr { color: var(--accent); }
.setup-cta {
  margin-top: 6px;
  justify-content: center;
  padding: 12px;
  text-decoration: none;
}

@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.fade-in { animation: fadeIn 0.3s ease; }

@media (max-width: 768px) {
  .hero-inner { padding: 20px; }
  .hero-empty { grid-template-columns: 1fr; }
  .hero-empty h2 { font-size: 30px; }
}
</style>
