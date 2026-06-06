<template>
  <div class="sv">
    <header class="section-header">
      <h1>Medien <span class="serif">suchen</span></h1>
    </header>

    <!-- Search hero -->
    <div class="srch-hero">
      <div class="srch-box">
        <Search :size="18" />
        <input
          v-model="musicStore.searchQuery"
          class="srch-input"
          type="text"
          placeholder="Film, Serie oder Album suchen…"
          @keyup.enter="doSearch"
        />
        <div class="srch-actions">
          <button v-if="musicStore.searchQuery" class="srch-clear" aria-label="Suche löschen" @click="clearQuery">
            <X :size="15" />
          </button>
          <button class="srch-kbd" aria-label="Suchen" @click="doSearch">↵</button>
        </div>
      </div>
      <div class="srch-types">
        <button
          v-for="f in filters"
          :key="f.key"
          class="lib-chip"
          :class="{ active: activeFilter === f.key }"
          @click="activeFilter = f.key"
        >
          {{ f.label }}<span v-if="hasSearched" class="count">{{ countFor(f.key) }}</span>
        </button>
      </div>
    </div>

    <!--
      Pasted streaming link. The source resolves foreign links itself (album,
      playlist, single track), so there is nothing to search — offer the direct
      download instead of running a text search that cannot match a URL.
    -->
    <div v-if="looksLikeLink" class="srch-link card">
      <div class="srch-link-body">
        <LinkIcon :size="18" />
        <div class="srch-link-text">
          <strong>Link erkannt</strong>
          <span class="srch-link-url">{{ musicStore.searchQuery.trim() }}</span>
        </div>
      </div>
      <button class="srch-link-btn" :disabled="linkBusy" @click="downloadPastedLink">
        {{ linkBusy ? 'Startet…' : 'Direkt laden' }}
      </button>
    </div>

    <!-- Loading skeleton -->
    <div v-if="musicStore.searching" class="lib-grid" style="margin-top: 26px">
      <div v-for="n in 8" :key="n" class="sk-tile" :style="{ animationDelay: (n * 0.08) + 's' }"></div>
    </div>

    <!-- Error -->
    <div v-else-if="musicStore.searchError" class="lib-empty">
      <div class="icon-circle"><SearchX :size="22" /></div>
      <div class="title">Suche fehlgeschlagen</div>
      <div class="sub">{{ musicStore.searchError }}</div>
    </div>

    <!-- Not searched yet — Trending shelf ("Beliebt diese Woche") or hint -->
    <template v-else-if="!hasSearched">
      <section v-if="musicStore.trending.length" class="sv-shelf">
        <div class="sv-shelf-head">
          <span class="sv-shelf-title">Beliebt <span class="serif">diese Woche</span></span>
          <span class="sv-shelf-link">Via Trakt Trending</span>
        </div>
        <div class="sv-rail">
          <div
            v-for="(c, i) in musicStore.trending"
            :key="i"
            class="sv-rail-card"
            @click="searchTitle(c.title)"
          >
            <div class="poster">
              <img
                v-if="c.poster && !failed.has('t' + i)"
                :src="c.poster"
                :alt="c.title"
                loading="lazy"
                class="poster-img"
                @error="failed.add('t' + i)"
              />
              <span v-else class="poster-title">{{ c.title }}</span>
              <span class="sr-type">{{ c.mediaType === 'show' ? 'Serie' : 'Film' }}</span>
              <span v-if="c.year" class="sr-year">{{ c.year }}</span>
            </div>
            <div class="sv-rail-info">
              <span class="when">Trend #{{ i + 1 }}</span>
              <span class="name">{{ c.title }}</span>
            </div>
          </div>
        </div>
      </section>
      <div v-else class="lib-empty">
        <div class="icon-circle"><Search :size="22" /></div>
        <div class="title">Suche nach Filmen, Serien oder Musik</div>
        <div class="sub">Ein Suchfeld für alle Quellen — Ergebnisse nach Kategorie.</div>
      </div>
    </template>

    <!-- No results -->
    <div v-else-if="visibleSections.length === 0" class="lib-empty">
      <div class="icon-circle"><SearchX :size="22" /></div>
      <div class="title">Nichts gefunden für „{{ musicStore.lastQuery }}"</div>
      <div class="sub">Anderen Begriff probieren — oder Typ-Filter zurücksetzen.</div>
    </div>

    <!-- Result sections -->
    <template v-else>
      <section v-for="s in visibleSections" :key="s.key" class="sv-section">
        <div class="sr-result-head">
          <span class="t">{{ s.label }}</span>
          <span class="n">{{ s.results.length }} {{ s.results.length === 1 ? 'Treffer' : 'Treffer' }}</span>
        </div>
        <div class="lib-grid cascade">
          <div v-for="(c, i) in s.results" :key="i" class="lib-tile">
            <div class="poster" :class="{ square: s.square }" @click="act(c, s.kind)">
              <img
                v-if="c.poster && !failed.has(keyOf(c))"
                :src="c.poster"
                :alt="c.title"
                loading="lazy"
                class="poster-img"
                @error="failed.add(keyOf(c))"
              />
              <span v-else class="poster-title">{{ c.title }}</span>
              <span class="sr-type">{{ s.typeLabel }}</span>
              <span v-if="c.year" class="sr-year">{{ c.year }}</span>
            </div>
            <div class="sr-label">
              <span class="name">{{ c.title }}</span>
              <span class="meta">
                <template v-if="s.kind === 'album' && c.count">{{ c.count }} {{ c.count === 1 ? 'Track' : 'Tracks' }}</template>
                <template v-else>{{ s.typeLabel }}</template>
                <!-- Which back-end produced this hit. With several services
                     enabled the same song appears more than once at different
                     quality, so this is what makes the list decidable. -->
                <span v-if="c.label" class="sr-provider">{{ c.label }}</span>
              </span>
            </div>
            <div class="sr-add-row">
              <button class="add-btn" :class="{ done: added.has(keyOf(c)) }" :disabled="busy.has(keyOf(c))" @click.stop="act(c, s.kind)">
                <component :is="added.has(keyOf(c)) ? Check : (s.isDownload ? Download : Plus)" :size="13" />
                {{ added.has(keyOf(c)) ? (s.isDownload ? 'Gestartet' : 'Hinzugefügt') : s.actionLabel }}
              </button>
            </div>
          </div>
        </div>
      </section>
    </template>

    <Transition name="slide-up">
      <div v-if="toast" class="sv-toast" :class="toast.type" @click="toast = null">{{ toast.message }}</div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { Search, SearchX, Film, Tv, Music, Download, Plus, Check, X, Link as LinkIcon } from 'lucide-vue-next';
import { useMusicStore, type SearchCandidate } from '../stores/music';
import { rememberSearch } from '../composables/useRecentSearches';

const musicStore = useMusicStore();
const activeFilter = ref<'all' | 'movie' | 'show' | 'music'>('all');
const toast = ref<{ type: string; message: string } | null>(null);
const busy = ref<Set<string>>(new Set());
const added = ref<Set<string>>(new Set());
const failed = ref<Set<string>>(new Set());
const hasSearched = computed(() => !!musicStore.lastQuery);

function clearQuery() {
  musicStore.clearSearch();
  activeFilter.value = 'all';
}

const filters = [
  { key: 'all', label: 'Alle' },
  { key: 'movie', label: 'Filme' },
  { key: 'show', label: 'Serien' },
  { key: 'music', label: 'Musik' },
] as const;

interface Section {
  key: string;
  label: string;
  typeLabel: string;
  filterKey: 'movie' | 'show' | 'music';
  kind: 'movie' | 'show' | 'album' | 'song';
  square: boolean;
  isDownload: boolean;
  actionLabel: string;
  results: SearchCandidate[];
}

const sections = computed<Section[]>(() => {
  const out: Section[] = [];
  for (const g of musicStore.groups) {
    if (g.mediaType === 'movie') {
      out.push({ key: 'movie', label: 'Filme', typeLabel: 'Film', filterKey: 'movie', kind: 'movie', square: false, isDownload: false, actionLabel: 'Hinzufügen', results: g.results });
    } else if (g.mediaType === 'show') {
      out.push({ key: 'show', label: 'Serien', typeLabel: 'Serie', filterKey: 'show', kind: 'show', square: false, isDownload: false, actionLabel: 'Hinzufügen', results: g.results });
    } else if (g.mediaType === 'music') {
      const albums = g.results.filter(r => r.kind === 'album');
      const songs = g.results.filter(r => r.kind !== 'album');
      if (albums.length) out.push({ key: 'album', label: 'Alben', typeLabel: 'Album', filterKey: 'music', kind: 'album', square: true, isDownload: true, actionLabel: 'Album laden', results: albums });
      if (songs.length) out.push({ key: 'song', label: 'Songs', typeLabel: 'Song', filterKey: 'music', kind: 'song', square: true, isDownload: true, actionLabel: 'Laden', results: songs });
    }
  }
  return out;
});
const visibleSections = computed(() =>
  sections.value.filter(s => activeFilter.value === 'all' || s.filterKey === activeFilter.value),
);
const totalCount = computed(() => musicStore.groups.reduce((n, g) => n + g.results.length, 0));

function countFor(key: string): number {
  if (key === 'all') return totalCount.value;
  return musicStore.groups.find(g => g.mediaType === key)?.results.length || 0;
}
/**
 * Stable identity for a search result.
 *
 * `/api/search/all` returns no `url` for movies/shows, so the old fallback to
 * the bare title collapsed remakes into one key: adding Dune (2021) also flipped
 * Dune (1984) to "Hinzugefügt" and disabled it. Prefer the IMDb id, then the
 * url, and always carry the year.
 */
function keyOf(c: SearchCandidate): string {
  return `${c.mediaType}:${c.imdbId || c.url || c.title}:${c.year ?? ''}`;
}

/** A pasted http(s) URL — searching for it as text would never match anything. */
const looksLikeLink = computed(() => /^https?:\/\/\S+$/i.test(musicStore.searchQuery.trim()));
const linkBusy = ref(false);

async function downloadPastedLink() {
  if (linkBusy.value) return;
  linkBusy.value = true;
  try {
    const res = await musicStore.downloadLink(musicStore.searchQuery);
    if (res?.error) {
      toast.value = { type: 'error', message: res.error };
    } else {
      toast.value = { type: 'success', message: 'Download gestartet — Fortschritt unter Downloads' };
      musicStore.searchQuery = '';
    }
  } finally {
    linkBusy.value = false;
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.value = null; toastTimer = null; }, 3500);
  }
}

async function doSearch() {
  const q = musicStore.searchQuery.trim();
  if (!q) return;
  // A URL is handled by the direct-download card, not by a text search.
  if (looksLikeLink.value) {
    await downloadPastedLink();
    return;
  }
  rememberSearch(q);
  // Kategorie-Filter über Suchen hinweg beibehalten (bleibt z.B. auf "Musik"),
  // nur auf "Alle" zurückfallen, wenn die gewählte Kategorie im neuen Ergebnis leer ist.
  const prevFilter = activeFilter.value;
  await musicStore.unifiedSearch(q);
  if (prevFilter !== 'all' && countFor(prevFilter) === 0) {
    activeFilter.value = 'all';
  }
}

function searchTitle(title: string) {
  musicStore.searchQuery = title;
  doSearch();
}

// Trending shelf (empty state) + a ?q=… handoff from the Dashboard search.
const route = useRoute();
onMounted(() => {
  musicStore.loadTrending();
  const q = route.query.q;
  if (typeof q === 'string' && q.trim() && q.trim() !== musicStore.lastQuery) {
    musicStore.searchQuery = q.trim();
    doSearch();
  }
});

async function act(c: SearchCandidate, kind: string) {
  const k = keyOf(c);
  if (busy.value.has(k) || added.value.has(k)) return;
  busy.value.add(k);
  const isMusic = kind === 'album' || kind === 'song';
  try {
    const res = isMusic ? await musicStore.downloadCandidate(c) : await musicStore.addMovie(c);
    if (res?.error) {
      toast.value = { type: 'error', message: res.error };
    } else {
      added.value.add(k);
      toast.value = { type: 'success', message: isMusic ? `Download gestartet: ${c.title}` : `Hinzugefügt: ${c.title}` };
    }
  } finally {
    busy.value.delete(k);
    // One shared timer: an uncancelled per-action timeout meant the second of
    // two quick additions had its toast cleared by the FIRST one's timer, after
    // roughly a second instead of the intended 3.5.
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.value = null; toastTimer = null; }, 3500);
  }
}

let toastTimer: number | null = null;
onBeforeUnmount(() => { if (toastTimer !== null) clearTimeout(toastTimer); });
</script>

<style scoped>
.sv { padding: 4px 0 40px; }
.srch-link {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  margin-top: 18px; padding: 14px 16px;
}
.srch-link-body { display: flex; align-items: center; gap: 12px; min-width: 0; color: var(--text-2); }
.srch-link-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.srch-link-text strong { font-size: 13.5px; color: var(--text-primary); font-weight: 600; }
.srch-link-url {
  font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 52ch;
}
.srch-link-btn {
  flex-shrink: 0; padding: 8px 14px; font-size: 13px; font-weight: 500;
  color: var(--bg); background: var(--text-primary);
  border: none; border-radius: var(--r-md); cursor: pointer;
}
.srch-link-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sr-provider {
  margin-left: 6px; padding: 1px 6px;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.04em;
  color: var(--accent-2); background: color-mix(in srgb, var(--accent-2) 12%, transparent);
  border-radius: 4px; text-transform: uppercase;
}
.section-header h1 {
  font-size: 28px; font-weight: 600; letter-spacing: -0.02em; margin: 0;
  display: flex; align-items: baseline; gap: 12px; color: var(--text-primary);
}
.section-header h1 .serif { font-family: var(--font-serif); font-style: italic; font-weight: 400; color: var(--accent-2); }

/* ── Hero ── */
.srch-hero { max-width: 760px; margin: 22px auto 6px; text-align: center; }
.srch-box { position: relative; }
.srch-box > svg { position: absolute; left: 20px; top: 50%; transform: translateY(-50%); color: var(--text-3); pointer-events: none; transition: color .15s; }
.srch-box:focus-within > svg { color: var(--accent); }
.srch-input {
  width: 100%; height: 56px; padding: 0 100px 0 50px;
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  color: var(--text-primary); font-family: var(--font-sans); font-size: 16.5px;
  outline: none; transition: border-color .15s, box-shadow .2s, background .15s;
}
.srch-input::placeholder { color: var(--text-3); }
.srch-input:focus { border-color: var(--accent); background: var(--surface-2); box-shadow: 0 0 0 4px var(--accent-soft), 0 12px 40px rgba(0,0,0,.35); }
.srch-actions { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 6px; }
.srch-clear {
  width: 30px; height: 30px; display: grid; place-items: center; border-radius: 7px;
  background: transparent; border: none; color: var(--text-3); cursor: pointer; transition: all .15s;
}
.srch-clear:hover { color: var(--text-primary); background: var(--surface-3); }
.srch-kbd {
  background: var(--surface-2); color: var(--text-secondary); border: 1px solid var(--line-2);
  padding: 5px 10px; border-radius: 6px; font-family: var(--font-mono); font-size: 13px; cursor: pointer; transition: all .15s;
}
.srch-kbd:hover { border-color: var(--accent); color: var(--accent-2); }
.srch-types { display: flex; justify-content: center; gap: 8px; margin-top: 16px; flex-wrap: wrap; }

/* ── Chips ── */
.lib-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--surface); color: var(--text-secondary);
  font-size: 12.5px; font-weight: 500; cursor: pointer; font-family: inherit; transition: all .15s; white-space: nowrap;
}
.lib-chip:hover { border-color: var(--line-2); color: var(--text-primary); }
.lib-chip.active { background: var(--surface-2); border-color: var(--accent); color: var(--accent); }
.lib-chip .count { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.lib-chip.active .count { color: var(--accent); }

/* ── Section head ── */
.sv-section { margin-top: 42px; }
.sr-result-head {
  display: flex; align-items: baseline; gap: 12px; margin: 0 0 18px;
  padding-bottom: 10px; border-bottom: 1px solid var(--line);
}
.sr-result-head .t { font-size: 22px; font-weight: 600; color: var(--text-primary); letter-spacing: -0.015em; }
.sr-result-head .n {
  font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--text-3); font-variant-numeric: tabular-nums;
}

/* ── Grid + tile ── */
.lib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 18px; }
.lib-tile { display: flex; flex-direction: column; gap: 6px; }

/* ── Poster ── */
.poster {
  position: relative; width: 100%; aspect-ratio: 2/3; border-radius: var(--r-md); overflow: hidden;
  border: 1px solid var(--line); cursor: pointer; isolation: isolate;
  background: linear-gradient(160deg, #1a3a5c 0%, #0d1a2c 70%, #2a1a3a 100%);
  transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease;
}
.poster.square { aspect-ratio: 1/1; }
.poster-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0; }
.poster::after {
  content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none;
  background: radial-gradient(120% 80% at 50% 110%, rgba(0,0,0,.55), transparent 60%);
}
.poster:hover { transform: translateY(-3px); border-color: var(--line-2); box-shadow: 0 10px 28px rgba(0,0,0,.4); }
.poster-title {
  position: absolute; inset: auto 10px 10px 10px; z-index: 2;
  font-family: var(--font-serif); font-style: italic; color: rgba(255,255,255,.96);
  text-shadow: 0 2px 8px rgba(0,0,0,.7); line-height: 1; font-size: clamp(14px, 2vw, 18px);
}
.sr-type, .sr-year {
  position: absolute; top: 8px; z-index: 2; font-family: var(--font-mono); font-size: 9px;
  letter-spacing: .09em; text-transform: uppercase; padding: 3px 7px; border-radius: 4px;
  background: rgba(0,0,0,.55); color: rgba(255,255,255,.88); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
}
.sr-type { left: 8px; }
.sr-year { right: 8px; font-variant-numeric: tabular-nums; }

/* ── Label ── */
.sr-label { display: flex; flex-direction: column; gap: 2px; padding: 0 2px; }
.sr-label .name { font-size: 13px; font-weight: 500; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sr-label .meta { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ── Add button ── */
.sr-add-row { margin-top: 2px; min-height: 30px; }
.add-btn {
  width: 100%; height: 30px; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-sm);
  color: var(--text-secondary); font-family: var(--font-sans); font-size: 12px; font-weight: 500;
  cursor: pointer; transition: border-color .15s, color .15s, background .15s;
}
.add-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-2); background: var(--accent-soft); }
.add-btn.done { border-color: var(--ok); color: var(--ok); background: rgba(74,222,128,.08); }
.add-btn:disabled { opacity: .6; cursor: default; }

/* ── Trending shelf ── */
.sv-shelf { margin-top: 28px; }
.sv-shelf-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 14px; }
.sv-shelf-title { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; color: var(--text-primary); }
.sv-shelf-title .serif { font-family: var(--font-serif); font-style: italic; font-weight: 400; color: var(--accent-2); }
.sv-shelf-link { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-3); }
.sv-rail {
  display: grid; grid-auto-flow: column; grid-auto-columns: 150px; gap: 14px;
  overflow-x: auto; padding: 4px 0 14px;
  scrollbar-width: thin; scrollbar-color: var(--line-2) transparent;
}
.sv-rail::-webkit-scrollbar { height: 8px; }
.sv-rail::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 999px; }
.sv-rail::-webkit-scrollbar-track { background: transparent; }
.sv-rail-card { display: flex; flex-direction: column; gap: 6px; cursor: pointer; }
.sv-rail-info { display: flex; flex-direction: column; gap: 1px; padding: 0 2px; min-width: 0; }
.sv-rail-info .when { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent-2); }
.sv-rail-info .name { font-size: 12.5px; font-weight: 500; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ── Skeleton ── */
@keyframes skPulse { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
.sk-tile { border-radius: var(--r-md); aspect-ratio: 2/3; background: var(--surface-2); border: 1px solid var(--line); animation: skPulse 1.2s ease-in-out infinite; }

/* ── Empty ── */
.lib-empty { padding: 60px 40px; text-align: center; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); color: var(--text-secondary); margin-top: 20px; }
.lib-empty .icon-circle { width: 56px; height: 56px; border-radius: 50%; background: var(--surface-2); border: 1px solid var(--line); display: inline-grid; place-items: center; color: var(--text-3); margin-bottom: 14px; }
.lib-empty .title { font-size: 16px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px; }
.lib-empty .sub { font-size: 13px; color: var(--text-3); }

/* ── Cascade in ── */
@keyframes cascadeIn { from { opacity: 0; transform: translateY(10px) scale(.97); } to { opacity: 1; transform: none; } }
.cascade > * { animation: cascadeIn .3s cubic-bezier(.2,.8,.2,1) both; }

/* ── Toast ── */
.sv-toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); padding: 12px 20px;
  border-radius: 10px; font-size: 14px; z-index: 100; cursor: pointer;
  background: var(--surface-2); color: var(--text-primary); border: 1px solid var(--line);
}
.sv-toast.success { border-color: var(--ok); }
.sv-toast.error { border-color: var(--err); }
.slide-up-enter-active, .slide-up-leave-active { transition: all .25s ease; }
.slide-up-enter-from, .slide-up-leave-to { opacity: 0; transform: translate(-50%, 12px); }

@media (max-width: 768px) {
  .srch-input { height: 48px; font-size: 15px; }
  .lib-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 14px; }
}
</style>
