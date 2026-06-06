<template>
  <div class="dash-search-card fade-in">
    <span class="lbl">Suche</span>
    <div class="srch-box">
      <Search :size="15" />
      <input
        v-model="q"
        class="srch-input"
        type="text"
        placeholder="Film, Serie oder Album suchen…"
        @keyup.enter="go"
      />
      <button class="dash-go" :disabled="!q.trim()" @click="go">
        Suchen <ArrowRight :size="13" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { Search, ArrowRight } from 'lucide-vue-next';

const router = useRouter();
const q = ref('');
function go() {
  const query = q.value.trim();
  if (!query) return;
  router.push({ path: '/search', query: { q: query } });
}
</script>

<style scoped>
.dash-search-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 14px 16px; display: flex; align-items: center; gap: 14px; }
.dash-search-card .lbl { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-3); white-space: nowrap; }
.srch-box { position: relative; flex: 1; }
.srch-box > svg { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--text-3); pointer-events: none; }
.srch-box:focus-within > svg { color: var(--accent); }
.srch-input { width: 100%; height: 44px; padding: 0 116px 0 40px; background: var(--surface); border: 1px solid var(--line); border-radius: 11px; color: var(--text-primary); font-family: var(--font-sans); font-size: 14px; outline: none; transition: border-color 0.15s, box-shadow 0.15s; }
.srch-input::placeholder { color: var(--text-3); }
.srch-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.dash-go { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); height: 34px; padding: 0 14px; display: inline-flex; align-items: center; gap: 7px; background: var(--accent); color: #0b0c0e; border: none; border-radius: 8px; font-family: var(--font-sans); font-size: 12.5px; font-weight: 600; cursor: pointer; transition: background 0.15s, opacity 0.15s; }
.dash-go:hover { background: var(--accent-hover, var(--accent-2)); }
.dash-go:disabled { opacity: 0; pointer-events: none; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.fade-in { animation: fadeIn 0.3s ease; }
@media (max-width: 768px) { .dash-search-card .lbl { display: none; } }
</style>
