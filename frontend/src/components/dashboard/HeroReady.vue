<template>
  <div class="hero fade-in">
    <div class="hero-glow"></div>
    <div class="hero-inner hero-ready">
      <div>
        <div class="hero-eyebrow">
          <span class="dot"></span>
          {{ watchlistLabel }} verbunden · keine Filme synchronisiert
        </div>
        <h2>
          Bereit für deinen<br />
          <span class="accent-2">ersten Sync.</span>
        </h2>
        <p>
          Drück den Knopf — dlvault holt deine Watchlist ab und legt los, sobald die ersten Filme da sind.
        </p>
        <ul v-if="optionalHints.length" class="hints">
          <li v-for="h in optionalHints" :key="h.key">
            <span class="dot"></span>
            <span>{{ h.text }}</span>
            <router-link to="/settings" class="link">Einstellungen →</router-link>
          </li>
        </ul>
      </div>
      <div class="hero-cta">
        <button class="btn btn-primary cta-btn" :disabled="syncing" @click="$emit('sync')">
          <RefreshCw :size="18" />
          <span>{{ syncing ? 'Sync läuft…' : 'Jetzt synchronisieren' }}</span>
        </button>
        <span class="hint">Erster Lauf kann ein paar Minuten dauern.</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RefreshCw } from 'lucide-vue-next';

const props = defineProps<{
  watchlistProvider: 'trakt' | 'plex' | null;
  jdConfigured: boolean;
  mediaServerConfigured: boolean;
  syncing: boolean;
}>();

defineEmits<{ (e: 'sync'): void }>();

const watchlistLabel = computed(() => {
  if (props.watchlistProvider === 'trakt') return 'Trakt';
  if (props.watchlistProvider === 'plex')  return 'Plex';
  return 'Watchlist';
});

// Non-blocking hints — sync works without JD/MediaServer, but you'll only see
// search results, not finished downloads. Show what's missing as soft prompts.
const optionalHints = computed(() => {
  const out: { key: string; text: string }[] = [];
  if (!props.jdConfigured)          out.push({ key: 'jd', text: 'JDownloader noch nicht eingerichtet — Downloads bleiben in der Queue stehen.' });
  if (!props.mediaServerConfigured) out.push({ key: 'ms', text: 'Kein Media-Server verbunden — Filme werden noch nicht ins Library-System importiert.' });
  return out;
});
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
.hero-ready {
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
  color: var(--ok);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.hero-eyebrow .dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 8px var(--ok);
}
.hero-ready h2 {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  font-size: 44px;
  letter-spacing: -0.02em;
  line-height: 1.05;
  color: var(--text-primary);
  margin-top: 12px;
}
.hero-ready h2 .accent-2 { color: var(--accent-2); }
.hero-ready p {
  margin-top: 12px;
  color: var(--text-secondary);
  font-size: 14px;
  max-width: 520px;
  line-height: 1.55;
}
.hints {
  list-style: none;
  margin-top: 16px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hints li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: rgba(245, 176, 65, 0.08);
  border: 1px solid rgba(245, 176, 65, 0.25);
  border-radius: var(--r-sm);
  font-size: 12px;
  color: var(--text-secondary);
}
.hints li .dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--warn);
  flex-shrink: 0;
}
.hints li > span:nth-child(2) { flex: 1; }
.hints .link {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent);
  text-decoration: none;
  white-space: nowrap;
}
.hints .link:hover { color: var(--accent-hover); }

.hero-cta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  padding-left: 28px;
  border-left: 1px solid var(--line);
}
.cta-btn {
  padding: 14px 24px;
  font-size: 15px;
  font-weight: 600;
}
.cta-btn :deep(svg) { width: 18px; height: 18px; }
.hero-cta .hint {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-3);
}

@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.fade-in { animation: fadeIn 0.3s ease; }

@media (max-width: 768px) {
  .hero-inner { padding: 20px; }
  .hero-ready { grid-template-columns: 1fr; }
  .hero-ready h2 { font-size: 30px; }
  .hero-cta {
    padding-left: 0;
    border-left: none;
    padding-top: 14px;
    border-top: 1px solid var(--line);
    align-items: flex-start;
  }
}
</style>
