<template>
  <div v-if="visible.length > 0" class="dl-section">
    <div class="dl-section-head">
      <h2>Musik-Downloads <span class="serif">{{ visible.length }}</span></h2>
      <span class="dl-section-hint">Track für Track · direkt von der Quelle</span>
    </div>
    <div class="mdl-list">
      <div v-for="d in visible" :key="d.id" :class="['mdl-row', 'is-' + stageOf(d).key]">
        <div class="mdl-cover">
          <img v-if="d.cover" :src="d.cover" :alt="d.title" loading="lazy" />
          <Disc3 v-else :size="22" />
        </div>
        <div class="mdl-body">
          <div class="mdl-title">
            <span class="name">{{ d.title }}</span>
            <span v-if="d.artist" class="artist">{{ d.artist }}</span>
          </div>
          <div class="mdl-meta">
            <template v-if="stageOf(d).key === 'dl'">
              <span v-if="d.tracksTotal && d.tracksTotal > 1"><strong>{{ d.tracksDone ?? 0 }}</strong>/{{ d.tracksTotal }} Tracks</span>
              <span v-if="d.speedBps"><strong>{{ formatSpeed(d.speedBps) }}</strong></span>
              <span v-if="typeof d.progress === 'number'"><strong>{{ Math.round(d.progress) }}%</strong></span>
              <span v-if="d.detail">{{ d.detail }}</span>
            </template>
            <template v-else-if="stageOf(d).key === 'err'">
              <!-- The failure reason, not the last progress line it replaced. -->
              <span class="err-text">{{ d.error || d.detail || 'Fehler' }}</span>
            </template>
            <template v-else>
              <span>{{ d.detail || stageOf(d).label }}</span>
            </template>
          </div>
          <!-- Segmentbalken: 1 Segment pro Track, wenn das Plugin Track-Infos
               liefert — sonst durchgehender Fortschrittsbalken. -->
          <div v-if="d.tracksTotal && d.tracksTotal > 1 && d.tracksTotal <= 40" class="trackbar">
            <span
              v-for="n in d.tracksTotal"
              :key="n"
              :class="['seg', { done: n <= (d.tracksDone ?? 0), now: stageOf(d).key === 'dl' && n === (d.tracksDone ?? 0) + 1 }]"
            ></span>
          </div>
          <div v-else class="mdl-bar">
            <div class="fill" :style="{ width: barPct(d) + '%' }"></div>
          </div>
          <div v-if="stageOf(d).key === 'dl' && d.currentTrack" class="nowline">
            <span class="eq"><i></i><i></i><i></i></span>
            <span>{{ d.currentTrack }}</span>
          </div>
        </div>
        <div class="mdl-actions">
          <span :class="['stage-pill', stageOf(d).cls]">
            <CheckCircle2 v-if="stageOf(d).key === 'done'" :size="11" />
            <span v-else class="dot"></span>
            {{ stageOf(d).label }}
          </span>
          <button
            v-if="stageOf(d).key === 'dl' || stageOf(d).key === 'wait' || stageOf(d).key === 'tag'"
            class="mdl-cancel"
            title="Download abbrechen"
            :disabled="cancelling.has(d.id)"
            @click="cancel(d)"
          >
            <X :size="14" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { Disc3, CheckCircle2, X } from 'lucide-vue-next';
import { useMusicStore, type MusicDownload } from '../../stores/music';
import { formatSpeed } from '../../composables/useFormatters';

const musicStore = useMusicStore();
const cancelling = ref(new Set<string>());

/** How long a finished download stays visible before the panel drops it. */
const FINISHED_GRACE_MS = 10 * 60 * 1000;

/**
 * Active downloads, plus recently finished ones so a completion is actually
 * seen. The server keeps the last 100 jobs forever, so rendering all of them
 * left the panel permanently showing every album ever downloaded — and the
 * "nothing active" empty state in DownloadsView could never appear again.
 */
const visible = computed<MusicDownload[]>(() => {
  const now = Date.now();
  return musicStore.downloads.filter(d => {
    const stage = stageOf(d).key;
    if (stage !== 'done' && stage !== 'err') return true;
    return !d.finishedAt || now - d.finishedAt < FINISHED_GRACE_MS;
  });
});

async function cancel(d: MusicDownload) {
  if (cancelling.value.has(d.id)) return;
  cancelling.value = new Set(cancelling.value).add(d.id);
  try {
    await musicStore.cancelDownload(d.id);
  } finally {
    const next = new Set(cancelling.value);
    next.delete(d.id);
    cancelling.value = next;
  }
}

// Status-Vokabular der fetch-jobs ist plugin-getrieben — defensiv mappen.
function stageOf(d: MusicDownload): { key: string; label: string; cls: string } {
  const s = (d.status || '').toLowerCase();
  if (s === 'completed') return { key: 'done', label: 'In Library', cls: 'ok' };
  if (s === 'error' || s === 'failed') return { key: 'err', label: 'Fehler', cls: 'err' };
  if (s === 'tagging') return { key: 'tag', label: 'Taggen', cls: 'tag' };
  if (s === 'pending' || s === 'queued') return { key: 'wait', label: 'Wartet', cls: '' };
  return { key: 'dl', label: 'Lädt', cls: 'dl' }; // running / downloading / unbekannt-aktiv
}

function barPct(d: MusicDownload): number {
  if (stageOf(d).key === 'done') return 100;
  if (typeof d.progress === 'number') return Math.max(0, Math.min(100, d.progress));
  if (d.tracksTotal && d.tracksDone != null) return Math.round((d.tracksDone / d.tracksTotal) * 100);
  return 0;
}

// Eigenes Polling — Section ist selbstversorgend, DownloadsView muss nichts wissen.
// Stops itself when the instance has no music plugin at all: without that check
// this component (which renders nothing in that case) still polled every 4s for
// as long as the Downloads page stayed open.
let timer: ReturnType<typeof setInterval> | null = null;

function stopPolling() {
  if (timer) { clearInterval(timer); timer = null; }
}

onMounted(async () => {
  await musicStore.loadDownloads();
  if (!musicStore.hasMusicPlugin()) return;
  timer = setInterval(async () => {
    await musicStore.loadDownloads();
    if (!musicStore.hasMusicPlugin()) stopPolling();
  }, 4000);
});
onBeforeUnmount(stopPolling);
</script>

<style scoped>
.dl-section { display: flex; flex-direction: column; gap: 12px; }
.mdl-actions { display: flex; align-items: center; gap: 8px; }
.err-text { color: var(--danger, #e5484d); }
.mdl-cancel {
  display: grid; place-items: center;
  width: 26px; height: 26px; padding: 0;
  color: var(--text-3); background: transparent;
  border: 1px solid var(--line); border-radius: var(--r-sm, 6px);
  cursor: pointer; transition: color 0.15s, border-color 0.15s;
}
.mdl-cancel:hover:not(:disabled) { color: var(--danger, #e5484d); border-color: var(--danger, #e5484d); }
.mdl-cancel:disabled { opacity: 0.4; cursor: not-allowed; }
.dl-section-head { display: flex; align-items: baseline; gap: 12px; padding: 0 4px; }
.dl-section-head h2 { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; color: var(--text-primary); display: flex; align-items: baseline; gap: 10px; margin: 0; }
.dl-section-head h2 .serif { font-family: var(--font-serif); font-style: italic; font-weight: 400; color: var(--accent-2); }
.dl-section-hint { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); letter-spacing: 0.06em; }
.mdl-list { display: flex; flex-direction: column; gap: 10px; }
.mdl-row { position: relative; display: grid; grid-template-columns: 64px 1fr auto; gap: 16px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); align-items: center; transition: border-color 0.15s; }
.mdl-row:hover { border-color: var(--line-2); }
.mdl-row.is-dl { border-color: color-mix(in srgb, var(--stage-downloading) 30%, var(--line)); }
.mdl-cover { width: 64px; height: 64px; border-radius: var(--r-sm); border: 1px solid var(--line); position: relative; overflow: hidden; align-self: start; background: linear-gradient(160deg, #2c2136 0%, #141019 70%, #1a2c2a 100%); display: grid; place-items: center; color: rgba(255,255,255,0.85); }
.mdl-cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.mdl-body { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.mdl-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.mdl-title .name { font-size: 14px; font-weight: 500; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mdl-title .artist { font-family: var(--font-serif); font-style: italic; font-size: 13px; color: var(--text-secondary); white-space: nowrap; }
.mdl-meta { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; display: flex; gap: 10px; flex-wrap: wrap; }
.mdl-meta strong { color: var(--text-secondary); font-weight: 600; }
.trackbar { display: flex; gap: 3px; height: 5px; margin-top: 2px; }
.trackbar .seg { flex: 1; border-radius: 3px; background: var(--surface-2); border: 1px solid var(--line); position: relative; overflow: hidden; }
.trackbar .seg.done { background: var(--stage-downloading); border-color: transparent; }
.trackbar .seg.now { border-color: transparent; background: color-mix(in srgb, var(--stage-downloading) 45%, var(--surface-2)); animation: segGlow 1.3s ease-in-out infinite; }
@keyframes segGlow { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.mdl-row.is-tag .trackbar .seg, .mdl-row.is-tag .mdl-bar { background: repeating-linear-gradient(45deg, color-mix(in srgb, var(--stage-extracting) 40%, transparent) 0 6px, color-mix(in srgb, var(--stage-extracting) 18%, transparent) 6px 12px); border-color: transparent; animation: tagSlide 1.6s linear infinite; }
@keyframes tagSlide { to { background-position: -34px 0; } }
.mdl-bar { height: 5px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
.mdl-bar .fill { height: 100%; border-radius: 3px; background: var(--stage-downloading); transition: width 0.4s ease; }
.mdl-row.is-done .mdl-bar .fill, .mdl-row.is-done .trackbar .seg.done { background: color-mix(in srgb, var(--stage-library) 70%, var(--surface-2)); }
.mdl-row.is-err .mdl-bar .fill { background: var(--err); }
.nowline { display: flex; align-items: center; gap: 9px; font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.nowline .eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 11px; }
.nowline .eq i { width: 2.5px; background: var(--stage-downloading); border-radius: 1px; animation: eq 0.9s ease-in-out infinite; }
.nowline .eq i:nth-child(1) { height: 60%; }
.nowline .eq i:nth-child(2) { height: 100%; animation-delay: 0.25s; }
.nowline .eq i:nth-child(3) { height: 40%; animation-delay: 0.5s; }
@keyframes eq { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1); } }
.stage-pill { display: inline-flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface-2); color: var(--text-3); white-space: nowrap; align-self: start; }
.stage-pill .dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.stage-pill.dl { border-color: color-mix(in srgb, var(--stage-downloading) 35%, transparent); color: var(--stage-downloading); background: color-mix(in srgb, var(--stage-downloading) 8%, transparent); }
.stage-pill.dl .dot { box-shadow: 0 0 6px currentColor; animation: pillPulse 1.4s ease-in-out infinite; }
@keyframes pillPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.stage-pill.tag { border-color: color-mix(in srgb, var(--stage-extracting) 35%, transparent); color: var(--stage-extracting); background: color-mix(in srgb, var(--stage-extracting) 8%, transparent); }
.stage-pill.ok { border-color: color-mix(in srgb, var(--ok) 30%, transparent); color: var(--ok); background: color-mix(in srgb, var(--ok) 6%, transparent); }
.stage-pill.err { border-color: color-mix(in srgb, var(--err) 30%, transparent); color: var(--err); background: color-mix(in srgb, var(--err) 6%, transparent); }
@media (max-width: 768px) {
  .mdl-row { grid-template-columns: 48px 1fr; }
  .mdl-cover { width: 48px; height: 48px; }
  .stage-pill { position: absolute; top: 12px; right: 12px; }
  .mdl-title .artist { display: none; }
}
</style>
