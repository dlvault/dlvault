<template>
  <div class="dash-hero fade-in">
    <div class="dash-hero-eyebrow">
      <span class="dot"></span>
      Alles synchronisiert · {{ libraryLabel }}
    </div>
    <h2>Was willst du <span class="serif">hinzufügen?</span></h2>
    <div class="srch-box">
      <Search :size="18" />
      <input
        ref="inputEl"
        v-model="q"
        class="srch-input"
        type="text"
        placeholder="Film, Serie oder Album suchen…"
        @keyup.enter="go(q)"
      />
      <button class="dash-go" :disabled="!q.trim()" @click="go(q)">
        Suchen <ArrowRight :size="14" />
      </button>
    </div>
    <div v-if="recents.length" class="dash-recent">
      <span class="lbl">Zuletzt</span>
      <button v-for="r in recents" :key="r" class="recent-chip" @click="go(r)">
        <Clock :size="11" /> {{ r }}
      </button>
    </div>
    <div class="dash-hint">
      <template v-if="pendingCount > 0">{{ pendingCount }} in der Warteschlange · </template>
      <kbd>/</kbd> fokussiert das Feld
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { Search, ArrowRight, Clock } from 'lucide-vue-next';
import { readRecentSearches } from '../../composables/useRecentSearches';

const props = defineProps<{
  libraryCount: number;
  libraryTotal: number;
  pendingCount: number;
}>();

const router = useRouter();
const q = ref('');
const inputEl = ref<HTMLInputElement>();
const recents = ref<string[]>(readRecentSearches());

const libraryLabel = computed(() => {
  const n = props.libraryTotal > 0 ? props.libraryTotal : props.libraryCount;
  return `${n} ${n === 1 ? 'Titel' : 'Titel'} in der Mediathek`;
});

function go(term: string) {
  const query = term.trim();
  if (!query) return;
  router.push({ path: '/search', query: { q: query } });
}

function onKey(e: KeyboardEvent) {
  // '/' fokussiert — aber nicht, wenn der User schon in einem Eingabefeld tippt
  const t = e.target as HTMLElement;
  if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) {
    e.preventDefault();
    inputEl.value?.focus();
  }
}
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<style scoped>
.dash-hero { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 40px 32px 34px; overflow: hidden; text-align: center; }
.dash-hero::before { content: ''; position: absolute; inset: 0; background: radial-gradient(560px 220px at 50% -10%, var(--accent-soft), transparent 70%); pointer-events: none; }
.dash-hero > * { position: relative; }
.dash-hero-eyebrow { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ok); margin-bottom: 14px; }
.dash-hero-eyebrow .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 6px currentColor; }
.dash-hero h2 { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 20px; color: var(--text-primary); }
.dash-hero h2 .serif { font-family: var(--font-serif); font-style: italic; font-weight: 400; color: var(--accent-2); }
.srch-box { position: relative; max-width: 640px; margin: 0 auto; text-align: left; }
.srch-box > svg { position: absolute; left: 20px; top: 50%; transform: translateY(-50%); color: var(--text-3); pointer-events: none; transition: color 0.15s; }
.srch-box:focus-within > svg { color: var(--accent); }
.srch-input { width: 100%; height: 56px; padding: 0 130px 0 50px; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; color: var(--text-primary); font-family: var(--font-sans); font-size: 16.5px; outline: none; transition: border-color 0.15s, box-shadow 0.2s, background 0.15s; }
.srch-input::placeholder { color: var(--text-3); }
.srch-input:focus { border-color: var(--accent); background: var(--surface-2); box-shadow: 0 0 0 4px var(--accent-soft), 0 12px 40px rgba(0,0,0,0.35); }
.dash-go { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); height: 40px; padding: 0 18px; display: inline-flex; align-items: center; gap: 8px; background: var(--accent); color: #0b0c0e; border: none; border-radius: 10px; font-family: var(--font-sans); font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.15s, opacity 0.15s; }
.dash-go:hover { background: var(--accent-hover, var(--accent-2)); }
.dash-go:disabled { opacity: 0; pointer-events: none; }
.dash-recent { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
.dash-recent .lbl { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-3); margin-right: 4px; }
.recent-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 999px; color: var(--text-secondary); font-family: var(--font-sans); font-size: 12px; cursor: pointer; transition: all 0.13s; }
.recent-chip:hover { border-color: var(--accent); color: var(--accent-2); background: var(--accent-soft); }
.dash-hint { margin-top: 14px; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); letter-spacing: 0.05em; }
.dash-hint kbd { background: var(--surface-2); border: 1px solid var(--line-2); border-radius: 4px; padding: 1px 6px; font-size: 10px; margin: 0 2px; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.fade-in { animation: fadeIn 0.3s ease; }
@media (max-width: 768px) { .dash-hero { padding: 26px 18px 24px; } .srch-input { height: 48px; font-size: 15px; padding-right: 110px; } }
</style>
