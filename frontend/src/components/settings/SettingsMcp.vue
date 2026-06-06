<template>
  <SettingsSection label="KI-Zugang (MCP)">
    <SettingsRow
      label="Schnittstelle aktiv"
      hint="Adresse: <code>/mcp</code> auf diesem Server, nur aus privaten Netzen und nur mit Token. Solange das aus ist, antwortet sie nicht."
      toggle
    >
      <Toggle :model-value="settings['mcp.enabled'] === 'true'" @update:model-value="set('mcp.enabled', $event)" />
    </SettingsRow>
  </SettingsSection>

  <SettingsSection label="Funktionen">
    <SettingsRow
      v-for="g in info?.groups || []"
      :key="g.id"
      :label="g.label"
      :hint="g.description + ' Werkzeuge: ' + g.tools.map(t => t.name + (t.write ? ' ✎' : '')).join(', ') + '. ✎ = schreibt, nur mit Schreib-Zugang und Bestätigung.'"
      toggle
    >
      <Toggle :model-value="settings['mcp.group.' + g.id] === 'true'" @update:model-value="set('mcp.group.' + g.id, $event)" />
    </SettingsRow>
  </SettingsSection>

  <SettingsSection label="Zugänge">
    <SettingsRow label="Neuer Zugang" hint="Ein Zugang je KI. Der Schlüssel wird nur einmal angezeigt — danach ist nur ein Hash gespeichert.">
      <div class="mcp-new">
        <input v-model="newName" class="input" placeholder="Name, z. B. Lexi" />
        <select v-model="newScope" class="input">
          <option value="read">nur lesen</option>
          <option value="write">lesen + schreiben</option>
        </select>
        <button class="btn" type="button" @click="create">Anlegen</button>
      </div>
    </SettingsRow>
    <SettingsRow v-if="shown" label="Schlüssel (jetzt kopieren)" hint="Wird nicht noch einmal angezeigt.">
      <code class="mcp-token">{{ shown }}</code>
    </SettingsRow>
    <SettingsRow v-for="t in info?.tokens || []" :key="t.id" :label="t.name" :hint="(t.scope === 'write' ? 'lesen + schreiben' : 'nur lesen') + ' · angelegt ' + t.created.slice(0, 10) + ' · zuletzt benutzt ' + (t.lastUsed ? t.lastUsed.slice(0, 16).replace('T', ' ') : 'nie')">
      <button class="btn btn-ghost" type="button" @click="remove(t.id)">Löschen</button>
    </SettingsRow>
  </SettingsSection>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getMcp, createMcpToken, deleteMcpToken, type McpInfo } from '../../api';
import { useSettingsContext } from '../../composables/useSettingsContext';
import SettingsSection from './SettingsSection.vue';
import SettingsRow from './SettingsRow.vue';
import Toggle from './Toggle.vue';

const { settings } = useSettingsContext();
const info = ref<McpInfo | null>(null);
const newName = ref('');
const newScope = ref<'read' | 'write'>('read');
const shown = ref('');

function set(key: string, v: boolean) { settings.value[key] = v ? 'true' : 'false'; }
async function load() { try { info.value = (await getMcp()).data; } catch { info.value = null; } }
async function create() {
  const r = await createMcpToken(newName.value || 'KI', newScope.value);
  shown.value = r.data.token;
  newName.value = '';
  await load();
}
async function remove(id: string) { await deleteMcpToken(id); await load(); }
onMounted(load);
</script>

<style scoped>
.mcp-new { display: flex; gap: 8px; flex-wrap: wrap; }
.mcp-token { word-break: break-all; user-select: all; }
</style>
