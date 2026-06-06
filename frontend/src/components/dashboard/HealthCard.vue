<template>
  <div class="card health-card">
    <div class="card-header">
      <div class="card-title">Systemzustand</div>
      <span class="badge-mono">{{ serviceList.length }} Dienste</span>
    </div>
    <div class="health-grid">
      <RouterLink v-for="s in serviceList" :key="s.key" to="/settings" class="health-row" :class="s.tone"
                  :title="s.reason || undefined">
        <span class="dot"></span>
        <span class="lbl">{{ s.label }}<small v-if="s.reason" class="why">{{ s.reason }}</small></span>
        <span class="stat">{{ s.statusText }}</span>
      </RouterLink>
    </div>

    <template v-if="plugins && plugins.length > 0">
      <div class="subhead">Plugins</div>
      <div class="health-grid">
        <div v-for="p in plugins" :key="p.id" class="health-row" :class="p.ok ? 'ok' : p.critical ? 'err' : 'warn'">
          <span class="dot"></span>
          <!-- The reason as text, not only a tooltip (unreachable on touch). -->
          <span class="lbl">{{ p.name }}<small v-if="!p.ok && (p.error || p.detail)" class="why">{{ p.error || p.detail }}</small></span>
          <span class="stat" :title="p.error || p.detail || ''">
            {{ p.ok ? 'OK' : p.critical ? 'Fehler' : 'Warnung' }}
          </span>
        </div>
      </div>
    </template>

    <div v-if="disks.length > 0" class="disk-list">
      <div v-for="d in disks" :key="d.key" class="disk-row">
        <div class="top">
          <span class="name">{{ d.label }}</span>
          <span class="meta">
            <template v-if="d.totalGB">{{ fmtDiskGB(d.freeGB ?? 0) }} frei · {{ d.usedPercent }} % belegt</template>
            <template v-else>{{ d.error || 'nicht verfügbar' }}</template>
          </span>
        </div>
        <div v-if="d.totalGB" class="disk-bar">
          <div
            class="disk-fill"
            :class="d.usedPercent && d.usedPercent > 90 ? 'err' : d.usedPercent && d.usedPercent > 75 ? 'warn' : ''"
            :style="{ width: (d.usedPercent || 0) + '%' }"
          ></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { fmtDiskGB } from '../downloads/downloadPackage';
import { computed } from 'vue';

interface ServiceHealth { configured: boolean; connected: boolean; error?: string }
interface DiskInfo { path: string; totalGB?: number; freeGB?: number; usedPercent?: number; error?: string }
interface PluginHealth { id: string; name: string; ok: boolean; critical: boolean; detail?: string; error?: string }

const props = defineProps<{
  services: Record<string, ServiceHealth>;
  plugins?: PluginHealth[];
  disk: Record<string, DiskInfo>;
}>();

const SERVICE_LABELS: Record<string, string> = {
  jdownloader: 'JDownloader',
  trakt:       'Trakt',
  telegram:    'Telegram',
  jellyfin:    'Jellyfin',
  plex:        'Plex',
  seerr:       'Seerr',
  plex_watchlist: 'Plex-Watchlist',
};
const DISK_LABELS: Record<string, string> = {
  'paths.downloads': '/downloads',
  'paths.movies':    '/movies',
  'paths.series':    '/series',
};

const serviceList = computed(() => {
  return Object.entries(props.services).map(([key, info]) => {
    let tone = 'na';
    let statusText = 'nicht eingerichtet';
    let reason = '';
    if (info.configured) {
      tone = info.connected ? 'ok' : 'err';
      statusText = info.connected ? 'OK' : 'Fehler';
      if (!info.connected) {
        // Trakt set up but not authorized is a step to finish, not a failure.
        if (key === 'trakt') { statusText = 'Nicht angemeldet'; tone = 'warn'; reason = 'In den Einstellungen autorisieren'; }
        else reason = info.error || 'nicht erreichbar';
      }
    }
    return { key, label: SERVICE_LABELS[key] || key, tone, statusText, reason };
  });
});

const disks = computed(() =>
  Object.entries(props.disk).map(([key, info]) => ({
    key,
    label: DISK_LABELS[key] || key,
    ...info,
  }))
);
</script>

<style scoped>
.health-card { padding: 22px; }
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.badge-mono {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 500;
}
.subhead {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
  margin: 14px 0 6px;
}

.health-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
}
/* Phone: one row per service — two columns squeezed name and status into
   each other ("JDownloader" over "NICHT EINGERICHTET"). */
@media (max-width: 520px) {
  .health-grid { grid-template-columns: minmax(0, 1fr); }
}
.health-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  font-size: 13px;
}
.health-row .dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 6px var(--ok);
  flex-shrink: 0;
}
.health-row.err .dot {
  background: var(--err);
  box-shadow: 0 0 6px var(--err);
  animation: pulse 1.5s ease-in-out infinite;
}
.health-row.warn .dot {
  background: var(--warn);
  box-shadow: 0 0 6px var(--warn);
}
.health-row.na .dot { background: var(--text-3); box-shadow: none; opacity: 0.4; }
.health-row .lbl { flex: 1; color: var(--text-primary); font-weight: 500; }
.health-row { color: inherit; text-decoration: none; }
.health-row .lbl { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.health-row .why { font-size: 11px; color: var(--text-3); white-space: normal; overflow-wrap: anywhere; }
.health-row .stat { flex-shrink: 0; white-space: nowrap; }
.health-row .stat {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-3);
}
.health-row.err .stat { color: var(--err); }
.health-row.ok .stat { color: var(--ok); }
.health-row.warn .stat { color: var(--warn); }

.disk-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.disk-row { display: flex; flex-direction: column; gap: 4px; }
.disk-row .top {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  align-items: baseline;
}
.disk-row .name { font-weight: 500; color: var(--text-primary); }
.disk-row .meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.disk-bar {
  height: 4px;
  background: var(--surface-3);
  border-radius: 999px;
  overflow: hidden;
}
.disk-fill {
  height: 100%;
  background: var(--ok);
  border-radius: 999px;
  transition: width 0.4s ease;
}
.disk-fill.warn { background: var(--warn); }
.disk-fill.err { background: var(--err); }

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.4; transform: scale(0.85); }
}
</style>
