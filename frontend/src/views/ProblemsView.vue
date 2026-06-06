<template>
  <div>
    <div class="section-header">
      <!-- Same count as the nav badge (things to act on); notes listed apart. -->
      <h1 class="page-title">
        Probleme <span v-if="!loading" class="serif">{{ actionable }}</span>
        <small v-if="!loading && notes > 0" class="page-title-sub">· {{ notes }} {{ notes === 1 ? 'Hinweis' : 'Hinweise' }}</small>
      </h1>
      <div class="flex-row-wrap">
        <button class="btn btn-secondary" @click="load" aria-label="Aktualisieren">Aktualisieren</button>
      </div>
    </div>

    <SkeletonLoader v-if="loading" variant="table" :count="5" />

    <EmptyState
      v-else-if="loadFailed && problems.length === 0"
      icon="AlertTriangle"
      title="Probleme konnten nicht geladen werden"
      description="Server nicht erreichbar — „Aktualisieren“ versucht es erneut."
    />
    <EmptyState
      v-else-if="problems.length === 0"
      icon="CheckCircle2"
      title="Alles in Ordnung"
      description="Nichts braucht gerade deine Aufmerksamkeit."
    />

    <div v-else class="card problem-list">
      <div v-for="p in problems" :key="p.key" :class="['problem', p.severity]">
        <span class="sev" :title="SEVERITY_LABEL[p.severity]" :aria-label="SEVERITY_LABEL[p.severity]">
          <component :is="SEVERITY_ICON[p.severity]" :size="18" />
        </span>
        <div class="text">
          <div class="head">
            <span class="kind">{{ p.kind }}</span>
            <span class="title">{{ p.title }}</span>
          </div>
          <div class="detail">{{ p.detail }}</div>
          <div v-if="p.since" class="since">{{ timeAgo(p.since) }}</div>
        </div>
        <div class="actions">
          <button
            v-if="p.actions.includes('retry') && p.movieId"
            class="btn btn-secondary btn-sm"
            :disabled="busy.has(p.key)"
            @click="retry(p)"
          >Neu suchen</button>
          <button
            v-if="p.actions.includes('redownload') && p.movieId"
            class="btn btn-secondary btn-sm"
            :disabled="busy.has(p.key)"
            @click="redownload(p)"
          >Neu laden</button>
          <button
            v-if="p.actions.includes('mark_removed') && p.movieId"
            class="btn btn-secondary btn-sm"
            :disabled="busy.has(p.key)"
            @click="markRemoved(p)"
          >Absichtlich gelöscht</button>
          <button
            v-if="p.actions.includes('remove') && p.movieId"
            class="btn btn-secondary btn-sm"
            :disabled="busy.has(p.key)"
            @click="remove(p)"
          >Entfernen</button>
          <button
            v-if="p.actions.includes('open') && p.movieId"
            class="btn btn-secondary btn-sm"
            @click="router.push({ path: '/movies', query: { highlight: String(p.movieId) } })"
          >Öffnen</button>
          <button
            v-if="p.actions.includes('settings')"
            class="btn btn-secondary btn-sm"
            @click="router.push('/settings')"
          >Einstellungen</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { XCircle, AlertTriangle, Info } from 'lucide-vue-next';
import { apiMessage } from '../utils/apiError';
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { getProblems, retryMovie, redownloadMovie, markMovieRemoved, type Problem, deleteMovie } from '../api/index';
import { timeAgo } from '../composables/useFormatters';
import { useToast, useConfirm } from '../composables/useApp';
import { problemCount } from '../composables/useProblemCount';
import SkeletonLoader from '../components/SkeletonLoader.vue';
import EmptyState from '../components/EmptyState.vue';

const router = useRouter();
const toast = useToast();
const confirmModal = useConfirm();
const problems = ref<Problem[]>([]);
const loading = ref(true);
const busy = ref(new Set<string>());

// Same icon family as the rest of the app (emoji rendered differently on
// every platform and looked out of place).
const SEVERITY_ICON = { error: XCircle, warning: AlertTriangle, info: Info } as const;
const SEVERITY_LABEL = { error: 'Fehler', warning: 'Warnung', info: 'Hinweis' } as const;

const loadFailed = ref(false);
const actionable = computed(() => problems.value.filter(p => p.severity !== 'info').length);
const notes = computed(() => problems.value.filter(p => p.severity === 'info').length);

async function load() {
  loading.value = problems.value.length === 0;
  try {
    const res = await getProblems();
    problems.value = res.data.problems;
    problemCount.value = res.data.counts.error + res.data.counts.warning;
    loadFailed.value = false;
  } catch {
    // Never "Alles in Ordnung" for a list that was not loaded.
    loadFailed.value = true;
    toast.value?.add('Probleme konnten nicht geladen werden', 'error');
  } finally {
    loading.value = false;
  }
}

async function retry(p: Problem) {
  if (!p.movieId) return;
  busy.value.add(p.key);
  try {
    await retryMovie(p.movieId);
    toast.value?.add(`${p.title}: neue Suche gestartet`, 'success');
  } catch (e: any) {
    toast.value?.add(apiMessage(e, 'Neue Suche konnte nicht gestartet werden'), 'error');
  } finally {
    busy.value.delete(p.key);
  }
}

/** Run a per-title action, then drop the entry from the list (and the nav badge). */
async function act(p: Problem, call: (id: number) => Promise<unknown>, done: string) {
  if (!p.movieId) return;
  busy.value.add(p.key);
  try {
    await call(p.movieId);
    toast.value?.add(`${p.title}: ${done}`, 'success');
    problems.value = problems.value.filter(x => x.key !== p.key);
    problemCount.value = problems.value.filter(x => x.severity !== 'info').length;
  } catch (e: any) {
    toast.value?.add(apiMessage(e, 'Aktion fehlgeschlagen'), 'error');
  } finally {
    busy.value.delete(p.key);
  }
}
const redownload = (p: Problem) => act(p, redownloadMovie, 'wird neu geladen');
const markRemoved = (p: Problem) => act(p, markMovieRemoved, 'als gelöscht markiert');

async function remove(p: Problem) {
  const ok = await confirmModal.value?.show({
    title: 'Aus der Warteschlange entfernen',
    message: `„${p.title}“ nicht mehr suchen? Dateien in der Mediathek bleiben unberührt.`,
    confirmText: 'Entfernen',
    danger: true,
  });
  if (ok) await act(p, deleteMovie, 'aus der Warteschlange entfernt');
}

onMounted(load);
</script>

<style scoped>
.problem-list { padding: 0; }
.problem {
  display: flex;
  gap: var(--gap-md, 12px);
  align-items: flex-start;
  padding: var(--gap-md, 12px) var(--gap-lg, 16px);
  border-bottom: 1px solid var(--border);
}
.problem:last-child { border-bottom: none; }
.sev { display: inline-flex; padding-top: 1px; color: var(--info); }
.problem.error .sev { color: var(--err); }
.problem.warning .sev { color: var(--warn); }
.text { flex: 1; min-width: 0; }
.head { display: flex; flex-wrap: wrap; gap: 0 8px; align-items: baseline; }
.kind { font-weight: 600; }
.problem.error .kind { color: var(--err); }
.problem.warning .kind { color: var(--warn); }
.title { color: var(--text-secondary, inherit); }
.detail { margin-top: 2px; word-break: break-word; }
.since { margin-top: 2px; font-size: 0.8rem; color: var(--text-muted, #888); }
.actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
@media (max-width: 640px) {
  .problem { flex-wrap: wrap; }
  .actions { width: 100%; justify-content: flex-start; padding-left: 28px; }
}
.page-title-sub { font-size: 14px; font-weight: 500; color: var(--text-3); }
</style>
