<template>
  <div class="hero fade-in">
    <div class="hero-glow"></div>
    <div class="hero-inner hero-idle">
      <div>
        <div class="hero-eyebrow">
          <span class="dot"></span>
          Alles synchronisiert · Keine Downloads aktiv
        </div>
        <div class="hero-display-num">
          {{ displayCount }} <small>{{ displayCount === 1 ? 'Film in deiner Mediathek' : 'Filme in deiner Mediathek' }}</small>
        </div>
        <div v-if="libraryTotal > 0" class="hero-idle-managed">
          {{ libraryCount }} {{ libraryCount === 1 ? 'Film' : 'Filme' }} von dlvault verwaltet
        </div>
        <div v-if="pendingCount > 0" class="hero-idle-queue-hint">
          <span class="dot"></span>
          {{ pendingCount }} {{ pendingCount === 1 ? 'Film wartet' : 'Filme warten' }} auf nächsten Sync
        </div>
        <div v-if="recent.length > 0" class="hero-idle-recent">
          <div class="lbl">Frisch hinzugefügt</div>
          <div class="hero-idle-posters">
            <div v-for="m in recent" :key="m.id" class="hero-idle-poster" :title="`${m.title} · ${m.when}`">
              <MoviePoster :imdb-id="m.imdbId" :title="m.title" :year="m.year" size="md" />
              <span class="name">{{ m.title }}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="hero-countdown">
        <div class="hero-countdown-lbl">{{ lastSyncLabel ? 'Letzter Sync' : 'Scheduler' }}</div>
        <div class="hero-countdown-num">
          <template v-if="lastSyncLabel">{{ lastSyncLabel }}</template>
          <template v-else>{{ schedulerRunning ? 'Aktiv' : 'Aus' }}</template>
        </div>
        <div v-if="weekDelta" class="week-delta">
          <span class="lbl">Diese Woche</span>
          <span class="val">+{{ weekDelta.added }} hinzugefügt · +{{ weekDelta.completed }} fertig</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MoviePoster from '../MoviePoster.vue';

interface RecentItem {
  id: number;
  imdbId?: string | null;
  title: string;
  year?: number;
  when: string;
}

const props = defineProps<{
  libraryCount: number;
  libraryTotal: number;
  pendingCount: number;
  recent: RecentItem[];
  schedulerRunning: boolean;
  lastSyncLabel: string | null;
  weekDelta: { added: number; completed: number } | null;
}>();

// Prefer the real media-server library size; fall back to dlvault's managed
// count when no provider is configured or its cache isn't populated yet.
const displayCount = computed(() => props.libraryTotal > 0 ? props.libraryTotal : props.libraryCount);
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
  background: radial-gradient(600px 240px at 12% 20%, rgba(74, 222, 128, 0.07), transparent 70%);
  pointer-events: none;
}
.hero-inner {
  position: relative;
  padding: 26px 28px;
}
.hero-idle {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 28px;
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
.hero-display-num {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 72px;
  line-height: 0.95;
  font-weight: 400;
  letter-spacing: -0.02em;
  color: var(--accent-2);
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}
.hero-display-num small {
  font-family: var(--font-sans);
  font-style: normal;
  font-size: 13px;
  color: var(--text-3);
  font-weight: 500;
  margin-left: 12px;
  letter-spacing: 0;
  vertical-align: middle;
}
.hero-idle-managed {
  margin-top: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.hero-idle-queue-hint {
  margin-top: 14px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(245, 176, 65, 0.10);
  border: 1px solid rgba(245, 176, 65, 0.30);
  color: var(--warn);
  font-size: 12px;
  font-weight: 500;
}
.hero-idle-queue-hint .dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}
.hero-idle-recent {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px dashed var(--line);
}
.hero-idle-recent .lbl {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
  margin-bottom: 10px;
}
.hero-idle-posters {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.hero-idle-poster {
  display: flex;
  flex-direction: column;
  gap: 6px;
  cursor: default;
  transition: transform 0.2s;
}
.hero-idle-poster:hover { transform: translateY(-2px); }
.hero-idle-poster .name {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 56px;
}
.hero-countdown {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  padding-left: 28px;
  border-left: 1px solid var(--line);
}
.hero-countdown-num {
  font-family: var(--font-mono);
  font-size: 28px;
  font-weight: 500;
  letter-spacing: -0.02em;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.hero-countdown-lbl {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
}
.week-delta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  margin-top: 4px;
}
.week-delta .lbl {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-3);
}
.week-delta .val {
  font-size: 12px;
  color: var(--ok);
  font-weight: 500;
}

@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.fade-in { animation: fadeIn 0.3s ease; }

@media (max-width: 768px) {
  .hero-inner { padding: 20px; }
  .hero-idle { grid-template-columns: 1fr; }
  .hero-display-num { font-size: 56px; }
  .hero-countdown { padding-left: 0; border-left: none; padding-top: 14px; border-top: 1px solid var(--line); align-items: flex-start; }
  .week-delta { align-items: flex-start; }
}
</style>
