<template>
  <div class="conn" :style="{ '--conn-tint': tint }">
    <div class="conn-glow"></div>
    <div class="conn-logo">
      <span class="service-mark" :style="{ background: markColor + '22', color: markColor }">
        {{ mark }}
      </span>
    </div>
    <div class="conn-body">
      <div class="conn-name">
        {{ name }}
        <span :class="['conn-pill', pillState]">
          <span class="dot"></span>
          {{ pillLabel }}
        </span>
      </div>
      <div v-if="meta.length > 0" class="conn-meta">
        <span v-for="m in meta" :key="m.lbl" class="item">
          <strong>{{ m.lbl }}:</strong> {{ m.val }}
        </span>
      </div>
    </div>
    <div class="conn-actions">
      <button
        v-if="testable"
        class="btn btn-ghost"
        type="button"
        :disabled="pillState === 'testing'"
        @click="$emit('test')"
      >
        <RefreshCw :size="14" />
        <span>{{ pillState === 'testing' ? 'Teste…' : 'Test' }}</span>
      </button>
      <a
        v-if="openUrl"
        class="btn btn-secondary"
        :href="openUrl"
        target="_blank"
        rel="noreferrer"
      >
        <ExternalLink :size="14" />
        <span>Öffnen</span>
      </a>
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { RefreshCw, ExternalLink } from 'lucide-vue-next';

defineProps<{
  name: string;
  mark: string;
  markColor: string;
  tint: string;
  pillState: 'ok' | 'err' | 'na' | 'testing';
  pillLabel: string;
  meta: { lbl: string; val: string }[];
  openUrl?: string;
  testable?: boolean;
}>();

defineEmits<{ (e: 'test'): void }>();
</script>

<style scoped>
.conn {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 22px 24px;
  margin-bottom: 24px;
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 22px;
  align-items: center;
  position: relative;
  overflow: hidden;
}
.conn-glow {
  position: absolute;
  inset: 0;
  background: radial-gradient(500px 200px at 0% 20%, color-mix(in srgb, var(--conn-tint, var(--ok)) 10%, transparent), transparent 70%);
  pointer-events: none;
}
.conn-logo {
  width: 56px;
  height: 56px;
  border-radius: 12px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  display: grid;
  place-items: center;
  position: relative;
  z-index: 1;
}
.service-mark {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 14px;
  letter-spacing: -0.02em;
}
.conn-body {
  position: relative;
  z-index: 1;
  min-width: 0;
}
.conn-name {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.conn-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  font-family: var(--font-sans);
  border: 1px solid color-mix(in srgb, var(--conn-tint) 30%, transparent);
  background: color-mix(in srgb, var(--conn-tint) 8%, transparent);
  color: var(--conn-tint);
  line-height: 1.4;
}
.conn-pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.conn-pill.ok .dot { box-shadow: 0 0 6px currentColor; }
.conn-pill.testing .dot { animation: connPulse 1.2s ease-in-out infinite; }
@keyframes connPulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}
.conn-meta {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 0.02em;
}
.conn-meta .item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.conn-meta strong {
  color: var(--text-secondary);
  font-weight: 500;
}
.conn-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
  z-index: 1;
}

@media (max-width: 768px) {
  .conn { grid-template-columns: 1fr; }
  .conn-actions { flex-wrap: wrap; }
}
</style>
