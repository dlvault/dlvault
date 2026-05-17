<template>
  <Teleport to="body">
    <Transition name="tray">
      <div
        v-if="dlStore.hasContent"
        ref="trayEl"
        class="download-tray"
        :class="{ 'tray-minimized': minimized, 'tray-dragging': dragging, 'tray-positioned': isPositioned }"
        :style="trayStyle"
      >
        <!-- Minimized bar -->
        <div class="tray-header" @pointerdown="onPointerDown" @click="onHeaderClick">
          <div class="tray-summary">
            <span class="tray-icon" aria-hidden="true"><Download :size="14" /></span>
            <span v-if="dlStore.runningCount > 0">
              {{ dlStore.runningCount }} aktiv
              <span v-if="dlStore.totalSpeed !== '0 KB/s'" class="tray-speed">{{ dlStore.totalSpeed }}</span>
            </span>
            <span v-else-if="dlStore.extractingCount > 0">{{ dlStore.extractingCount }} entpacken...</span>
            <span v-else-if="dlStore.movedCount > 0">{{ dlStore.movedCount }} verschoben</span>
            <span v-else-if="dlStore.finishedCount > 0">{{ dlStore.finishedCount }} fertig</span>
            <span v-else>{{ dlStore.packages.length }} in Warteschlange</span>
          </div>
          <div class="tray-actions">
            <button
              v-if="dlStore.activeCount > 0"
              class="tray-btn"
              @click.stop="$router.push('/downloads')"
              aria-label="Zu Downloads"
            >Details</button>
            <button
              class="tray-btn tray-toggle"
              :aria-label="minimized ? 'Erweitern' : 'Minimieren'"
              @click.stop="minimized = !minimized"
            ><component :is="minimized ? ChevronUp : ChevronDown" :size="14" /></button>
          </div>
        </div>

        <!-- Expanded content -->
        <div v-if="!minimized" class="tray-content">
          <div v-for="pkg in visiblePackages" :key="pkg.uuid" class="tray-item">
            <div class="tray-item-header">
              <span class="tray-item-name">{{ pkg.name }}</span>
              <span class="tray-item-pct">{{ progress(pkg) }}%</span>
            </div>
            <div class="tray-progress">
              <div class="tray-progress-fill" :style="{ width: progress(pkg) + '%' }"></div>
            </div>
            <div class="tray-item-meta">
              <span>{{ formatBytes(pkg.bytesLoaded) }} / {{ formatBytes(pkg.bytesTotal) }}</span>
              <span v-if="pkg.speed > 0">{{ formatSpeed(pkg.speed) }}</span>
              <span v-if="pkg.eta > 0">{{ formatEta(pkg.eta) }}</span>
            </div>
          </div>
          <div v-if="dlStore.packages.length > 3" class="tray-more" @click="$router.push('/downloads'); minimized = true;">
            +{{ dlStore.packages.length - 3 }} weitere...
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useDownloadsStore } from '../stores/downloads';
import { useDownloadPolling } from '../composables/useDownloadPolling';
import { formatBytes, formatSpeed, formatEta } from '../composables/useFormatters';
import type { DownloadPackage } from '../types/index';
import { Download, ChevronUp, ChevronDown } from 'lucide-vue-next';

const dlStore = useDownloadsStore();
const minimized = ref(true);
useDownloadPolling();

const visiblePackages = computed(() => dlStore.packages.slice(0, 3));

function progress(pkg: DownloadPackage): number {
  if (!pkg.bytesTotal) return 0;
  return Math.round((pkg.bytesLoaded / pkg.bytesTotal) * 100);
}

// --- Draggable positioning ---
const STORAGE_KEY = 'downloadTrayPosition';
const DRAG_THRESHOLD = 4;
const trayEl = ref<HTMLElement | null>(null);
const position = ref<{ x: number; y: number } | null>(null);
const dragging = ref(false);
const isMobile = ref(false);

let dragStart: { x: number; y: number; trayX: number; trayY: number } | null = null;
let didMove = false;

const isPositioned = computed(() => position.value !== null && !isMobile.value);

const trayStyle = computed(() => {
  if (!isPositioned.value) return {};
  return {
    left: position.value!.x + 'px',
    top: position.value!.y + 'px',
    right: 'auto',
    bottom: 'auto',
  };
});

function clampPosition(x: number, y: number) {
  if (!trayEl.value) return { x, y };
  const rect = trayEl.value.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 8;
  const maxY = window.innerHeight - rect.height - 8;
  return {
    x: Math.max(8, Math.min(x, Math.max(8, maxX))),
    y: Math.max(8, Math.min(y, Math.max(8, maxY))),
  };
}

function onPointerDown(e: PointerEvent) {
  if (isMobile.value) return;
  if ((e.target as HTMLElement).closest('button')) return;
  if (!trayEl.value) return;

  const rect = trayEl.value.getBoundingClientRect();
  dragStart = {
    x: e.clientX,
    y: e.clientY,
    trayX: rect.left,
    trayY: rect.top,
  };
  didMove = false;

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function onPointerMove(e: PointerEvent) {
  if (!dragStart) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;

  if (!didMove && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  didMove = true;
  dragging.value = true;

  position.value = clampPosition(dragStart.trayX + dx, dragStart.trayY + dy);
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  if (didMove && position.value) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(position.value));
    } catch {}
  }
  dragStart = null;
  dragging.value = false;
}

function onHeaderClick() {
  // Suppress toggle if this was a drag
  if (didMove) {
    didMove = false;
    return;
  }
  minimized.value = !minimized.value;
}

function onResize() {
  isMobile.value = window.innerWidth <= 768;
  if (position.value && !isMobile.value) {
    position.value = clampPosition(position.value.x, position.value.y);
  }
}

onMounted(() => {
  dlStore.fetch();
  isMobile.value = window.innerWidth <= 768;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
        position.value = parsed;
      }
    }
  } catch {}
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  window.removeEventListener('pointermove', onPointerMove);
});
</script>

<style scoped>
.download-tray {
  position: fixed;
  bottom: 16px;
  right: 16px;
  width: 360px;
  max-width: calc(100vw - 32px);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  z-index: 9990;
  overflow: hidden;
}

.tray-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  cursor: grab;
  user-select: none;
  transition: background 0.1s;
  touch-action: none;
}

.tray-dragging .tray-header,
.tray-header:active { cursor: grabbing; }
.tray-dragging { user-select: none; }

.tray-header:hover {
  background: rgba(240, 107, 130, 0.06);
}

.tray-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
  font-weight: 500;
}

.tray-icon { font-size: 1.1rem; }
.tray-speed { color: var(--accent); font-weight: 600; margin-left: 4px; }

.tray-actions { display: flex; gap: 6px; align-items: center; }

.tray-btn {
  background: var(--bg-input);
  border: none;
  color: var(--text-secondary);
  padding: 3px 8px;
  border-radius: 4px;
  font-size: var(--fs-xs);
  cursor: pointer;
  transition: all var(--duration-fast);
}

.tray-btn:hover { color: var(--text-primary); background: var(--bg-card); }
.tray-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tray-toggle { font-size: 0.65rem; padding: 3px 6px; }

.tray-content {
  border-top: 1px solid var(--border);
  padding: 10px 14px;
  max-height: 250px;
  overflow-y: auto;
}

.tray-item { margin-bottom: 10px; }
.tray-item:last-child { margin-bottom: 0; }

.tray-item-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.tray-item-name { font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; margin-right: var(--gap-sm); }
.tray-item-pct { font-size: var(--fs-xs); font-weight: 600; color: var(--accent); flex-shrink: 0; }

.tray-progress { height: 4px; background: var(--bg-primary); border-radius: 2px; overflow: hidden; margin-bottom: 4px; }
.tray-progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-hover)); border-radius: 2px; transition: width 0.5s ease; }

.tray-item-meta { display: flex; gap: var(--gap-sm); font-size: var(--fs-xs); color: var(--text-secondary); }

.tray-more { text-align: center; font-size: var(--fs-xs); color: var(--accent); cursor: pointer; padding: 6px 0 2px; }
.tray-more:hover { text-decoration: underline; }

.tray-enter-active { transition: all 0.25s ease; }
.tray-leave-active { transition: all 0.2s ease; }
.tray-enter-from { opacity: 0; transform: translateY(20px); }
.tray-leave-to { opacity: 0; transform: translateY(20px); }

@media (max-width: 768px) {
  .download-tray {
    bottom: 64px !important; /* above bottom nav */
    right: 8px !important;
    left: 8px !important;
    top: auto !important;
    width: auto;
    max-width: none;
    border-radius: 12px;
  }

  .tray-header { cursor: pointer; touch-action: auto; }

  .tray-content {
    max-height: 180px;
  }

  .tray-btn {
    padding: 6px 10px;
    min-height: 32px;
    font-size: var(--fs-xs);
  }

  .tray-toggle {
    padding: 6px 8px;
  }
}

/* iOS safe area adjustment */
@supports (padding-bottom: env(safe-area-inset-bottom)) {
  @media (max-width: 768px) {
    .download-tray {
      bottom: calc(64px + env(safe-area-inset-bottom));
    }
  }
}
</style>
