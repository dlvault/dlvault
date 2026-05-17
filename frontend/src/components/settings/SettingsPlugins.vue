<template>
  <details class="card settings-section" open>
    <summary class="card-toggle"><h2>Plugins</h2></summary>

    <p class="section-hint">
      Plugins erweitern dlvault um zusätzliche Quellen. dlvault selbst pflegt
      keine zentrale Plugin-Liste — Plugins kommen von Drittanbietern, denen
      du selbst vertraust.
    </p>

    <div class="plugin-actions">
      <button class="btn btn-primary" @click="openAddModal">
        <Plus :size="14" /> Plugin hinzufügen
      </button>
      <button class="btn btn-secondary" @click="reload" :disabled="loading" aria-label="Plugin-Liste neu laden">
        <RefreshCw :size="14" /> Aktualisieren
      </button>
    </div>

    <!-- Registered plugins -->
    <h3 class="plugin-section-title">Installiert</h3>
    <div v-if="loading" class="text-secondary">Lade Plugins…</div>
    <div v-else-if="registered.length === 0" class="text-secondary">Keine Plugins installiert.</div>
    <div v-else class="plugin-list">
      <div v-for="p in registered" :key="p.id" class="plugin-card"
           :class="{ 'is-expanded': expandedId === p.id }">
        <div class="plugin-row" @click="toggleExpand(p.id)" role="button" tabindex="0"
             @keydown.enter.prevent="toggleExpand(p.id)">
          <div class="plugin-info">
            <div class="plugin-title">
              <span class="plugin-chevron" :class="{ rotated: expandedId === p.id }">▸</span>
              <strong>{{ p.name }}</strong>
              <span v-if="p.version" class="badge badge-info">v{{ p.version }}</span>
              <span v-if="p.bundled" class="badge badge-info">bundled</span>
              <span v-for="t in p.mediaTypes" :key="t" class="badge badge-pending">{{ t }}</span>
            </div>
            <div class="plugin-meta">
              <code class="plugin-id">{{ p.id }}</code>
              <span v-if="p.author"> · {{ p.author }}</span>
            </div>
          </div>
          <div class="plugin-controls" @click.stop>
            <label class="toggle-row">
              <span class="toggle-switch" :class="{ active: p.enabled }"
                    @click="toggleEnabled(p)"
                    tabindex="0" @keydown.enter.prevent="toggleEnabled(p)"
                    role="switch" :aria-checked="p.enabled">
                <span class="toggle-knob" />
              </span>
            </label>
            <button class="btn btn-danger btn-sm" @click="confirmUninstall(p)"
                    :disabled="p.bundled" :title="p.bundled ? 'Bundled-Plugins können nicht entfernt werden' : 'Plugin entfernen'">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>

        <!-- Expanded details -->
        <div v-if="expandedId === p.id" class="plugin-details" @click.stop>
          <p v-if="p.description" class="plugin-description">{{ p.description }}</p>
          <dl class="plugin-attr-grid">
            <template v-if="p.homepage">
              <dt>Homepage</dt>
              <dd><a :href="p.homepage" target="_blank" rel="noopener">{{ p.homepage }}</a></dd>
            </template>
            <template v-if="p.permissions && p.permissions.length">
              <dt>Berechtigungen</dt>
              <dd>
                <span v-for="perm in p.permissions" :key="perm" class="badge badge-warning">{{ perm }}</span>
              </dd>
            </template>
            <template v-if="p.cspDomains.length">
              <dt>CSP-Domains</dt>
              <dd><code class="mono">{{ p.cspDomains.join(', ') }}</code></dd>
            </template>
          </dl>

          <!-- Plugin-specific settings form -->
          <template v-if="p.settingsSchema && p.settingsSchema.length">
            <h4 class="plugin-settings-title">Einstellungen</h4>
            <p class="text-secondary plugin-settings-hint">
              Änderungen werden mit dem globalen „Speichern"-Button oben übernommen.
            </p>
            <div class="form-grid">
              <div v-for="field in p.settingsSchema" :key="field.key" class="form-group">
                <label :for="`plugin-${p.id}-${field.key}`">
                  {{ field.label }}
                  <small v-if="field.description" class="text-secondary"> — {{ field.description }}</small>
                </label>
                <!-- boolean → toggle -->
                <label v-if="field.type === 'boolean'" class="toggle-row">
                  <span class="toggle-switch" :class="{ active: isFieldTrue(p, field) }"
                        @click="setField(p, field, isFieldTrue(p, field) ? 'false' : 'true')"
                        tabindex="0" role="switch" :aria-checked="isFieldTrue(p, field)">
                    <span class="toggle-knob" />
                  </span>
                </label>
                <!-- multi-select → chip-checkboxes from field.options -->
                <div v-else-if="field.type === 'multi-select'" class="chip-list">
                  <label v-for="opt in field.options || []" :key="opt"
                         class="chip-checkbox" :class="{ checked: fieldSelectedOptions(p, field).includes(opt) }">
                    <input type="checkbox"
                           :checked="fieldSelectedOptions(p, field).includes(opt)"
                           @change="toggleMultiSelect(p, field, opt)" />
                    <span>{{ opt }}</span>
                  </label>
                </div>
                <!-- number / string / secret → input -->
                <input v-else
                       :id="`plugin-${p.id}-${field.key}`"
                       :type="field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text'"
                       :value="fieldValue(p, field)"
                       :placeholder="field.default || ''"
                       @input="onFieldInput(p, field, ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Pending plugins -->
    <template v-if="pending.length > 0">
      <h3 class="plugin-section-title">Wartet auf Bestätigung</h3>
      <p class="text-secondary plugin-hint">
        Diese Plugin-Dateien liegen in <code>data/plugins/</code>, sind aber
        noch nicht aktiviert. Lies das Manifest und bestätige bewusst.
      </p>
      <div class="plugin-list">
        <div v-for="p in pending" :key="p.id" class="plugin-card plugin-card-pending">
          <div class="plugin-row">
            <div class="plugin-info">
              <div class="plugin-title">
                <strong>{{ p.name }}</strong>
                <span class="badge badge-pending">v{{ p.version }}</span>
                <span class="badge badge-warning" v-if="p.reason === 'sha-mismatch'">Datei verändert</span>
              </div>
              <div class="plugin-meta">
                <code class="plugin-id">{{ p.id }}</code>
                <span v-if="p.author"> · {{ p.author }}</span>
              </div>
              <p v-if="p.description" class="plugin-description">{{ p.description }}</p>
              <div class="plugin-perms" v-if="p.permissions && p.permissions.length">
                <strong>Berechtigungen:</strong>
                <span v-for="perm in p.permissions" :key="perm" class="badge badge-warning">{{ perm }}</span>
              </div>
              <code class="plugin-sha">SHA-256: {{ p.fileSha256 }}</code>
            </div>
            <div class="plugin-controls">
              <button class="btn btn-primary" @click="acceptPending(p)">
                <Check :size="14" /> Akzeptieren
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div class="plugins-legal">
      <p>
        <strong>Plugin-Verantwortung.</strong> Plugins führen Drittanbieter-Code
        in dlvault aus. dlvault selbst pflegt keine Plugin-Liste, prüft keine
        Plugin-Inhalte und empfiehlt keine Quellen. Du bist verantwortlich
        dafür, dass die Nutzung jedes installierten Plugins mit deinen
        anwendbaren Urheberrechts- und Nutzungsbestimmungen vereinbar ist.
      </p>
    </div>

    <AddPluginModal ref="addModal" @installed="onInstalled" />
    <ConfirmModal ref="confirmModal" />
  </details>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Plus, RefreshCw, Trash2, Check } from 'lucide-vue-next';
import {
  listPlugins, enablePlugin, disablePlugin, uninstallPlugin,
  acceptPendingPlugin,
  type RegisteredPlugin, type PendingPlugin, type PluginSettingField,
} from '../../api/index';
import { useToast } from '../../composables/useApp';
import { useSettingsContext } from '../../composables/useSettingsContext';
import AddPluginModal from '../AddPluginModal.vue';
import ConfirmModal from '../ConfirmModal.vue';

const toast = useToast();
const { settings } = useSettingsContext();
const loading = ref(true);
const registered = ref<RegisteredPlugin[]>([]);
const pending = ref<PendingPlugin[]>([]);
const expandedId = ref<string | null>(null);

const addModal = ref<InstanceType<typeof AddPluginModal> | null>(null);
const confirmModal = ref<InstanceType<typeof ConfirmModal> | null>(null);

function fieldKey(p: RegisteredPlugin, f: PluginSettingField): string {
  return `plugins.${p.id}.${f.key}`;
}
function fieldValue(p: RegisteredPlugin, f: PluginSettingField): string {
  const v = settings.value[fieldKey(p, f)];
  return v !== undefined && v !== '' ? v : (f.default ?? '');
}
function isFieldTrue(p: RegisteredPlugin, f: PluginSettingField): boolean {
  const v = fieldValue(p, f);
  return v === 'true' || v === '1';
}
function setField(p: RegisteredPlugin, f: PluginSettingField, value: string) {
  settings.value[fieldKey(p, f)] = value;
}
function onFieldInput(p: RegisteredPlugin, f: PluginSettingField, value: string) {
  settings.value[fieldKey(p, f)] = value;
}
function fieldSelectedOptions(p: RegisteredPlugin, f: PluginSettingField): string[] {
  return fieldValue(p, f).split(',').map(s => s.trim()).filter(Boolean);
}
function toggleMultiSelect(p: RegisteredPlugin, f: PluginSettingField, option: string) {
  const current = fieldSelectedOptions(p, f);
  const next = current.includes(option)
    ? current.filter(o => o !== option)
    : [...current, option];
  settings.value[fieldKey(p, f)] = next.join(',');
}

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id;
}

async function reload() {
  loading.value = true;
  try {
    const res = await listPlugins();
    registered.value = res.data.registered;
    pending.value = res.data.pending;
  } catch (err: any) {
    toast.value?.add(err.response?.data?.error || 'Plugins konnten nicht geladen werden', 'error');
  } finally {
    loading.value = false;
  }
}

async function toggleEnabled(p: RegisteredPlugin) {
  const next = !p.enabled;
  try {
    if (next) await enablePlugin(p.id);
    else await disablePlugin(p.id);
    p.enabled = next;
    toast.value?.add(`${p.name} ${next ? 'aktiviert' : 'deaktiviert'}`, 'success');
  } catch (err: any) {
    toast.value?.add(err.response?.data?.error || 'Aktion fehlgeschlagen', 'error');
  }
}

async function confirmUninstall(p: RegisteredPlugin) {
  const ok = await confirmModal.value?.show({
    title: `${p.name} entfernen?`,
    message: `Das Plugin und sein Disclaimer-Eintrag werden gelöscht. Plugin-Settings bleiben in der DB erhalten.`,
    confirmText: 'Entfernen',
    danger: true,
  });
  if (!ok) return;
  try {
    await uninstallPlugin(p.id);
    toast.value?.add(`${p.name} entfernt`, 'success');
    await reload();
  } catch (err: any) {
    toast.value?.add(err.response?.data?.error || 'Entfernen fehlgeschlagen', 'error');
  }
}

async function acceptPending(p: PendingPlugin) {
  const ok = await confirmModal.value?.show({
    title: `${p.name} aktivieren?`,
    message: `Dieses Plugin ist Drittanbieter-Code und wird Zugriff auf Settings und Downloads bekommen. ` +
             `Berechtigungen: ${(p.permissions || ['keine']).join(', ')}. SHA: ${p.fileSha256.slice(0, 12)}…`,
    confirmText: 'Akzeptieren und aktivieren',
    danger: false,
  });
  if (!ok) return;
  try {
    await acceptPendingPlugin(p.id, true);
    toast.value?.add(`${p.name} aktiviert`, 'success');
    await reload();
  } catch (err: any) {
    toast.value?.add(err.response?.data?.error || 'Aktivierung fehlgeschlagen', 'error');
  }
}

function openAddModal() {
  addModal.value?.open();
}

function onInstalled() {
  reload();
}

onMounted(reload);
</script>

<style scoped>
.plugin-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.plugin-section-title {
  margin: 20px 0 8px;
  font-size: 14px;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.plugin-hint {
  margin-bottom: 12px;
}
.plugin-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.plugin-card {
  background: var(--color-bg-subtle);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  transition: border-color 0.15s;
}
.plugin-card.is-expanded {
  border-color: var(--color-accent, #4a90e2);
}
.plugin-card-pending {
  border-color: var(--color-accent, #d4a017);
  background: var(--color-bg-accent-subtle, rgba(212, 160, 23, 0.05));
}
.plugin-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 12px;
  cursor: pointer;
}
.plugin-info {
  flex: 1;
  min-width: 0;
}
.plugin-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
}
.plugin-chevron {
  display: inline-block;
  transition: transform 0.15s;
  font-size: 0.8em;
  width: 12px;
  color: var(--color-text-secondary);
}
.plugin-chevron.rotated {
  transform: rotate(90deg);
}
.plugin-meta {
  font-size: 12px;
  color: var(--color-text-secondary);
}
.plugin-id {
  font-family: var(--font-mono, monospace);
  background: rgba(255, 255, 255, 0.05);
  padding: 1px 4px;
  border-radius: 3px;
}
.plugin-description {
  margin: 6px 0;
  font-size: 13px;
}
.plugin-perms {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 6px 0;
  font-size: 12px;
  align-items: center;
}
.plugin-sha {
  display: block;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--color-text-secondary);
  word-break: break-all;
  margin-top: 6px;
}
.plugin-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.plugin-details {
  padding: 0 16px 16px 28px;
  border-top: 1px solid var(--color-border);
}
.plugin-attr-grid {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 6px 12px;
  font-size: 0.85rem;
  margin: 8px 0;
}
.plugin-attr-grid dt {
  color: var(--color-text-secondary);
  font-weight: 600;
}
.plugin-attr-grid dd {
  margin: 0;
  word-break: break-word;
}
.plugin-settings-title {
  margin: 16px 0 4px;
  font-size: 14px;
}
.plugin-settings-hint {
  font-size: 12px;
  margin-bottom: 8px;
}
.mono { font-family: var(--font-mono, monospace); }

.plugins-legal {
  margin-top: 24px;
  padding: 14px 18px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-secondary, #888);
  background: rgba(0, 0, 0, 0.15);
  border-left: 3px solid var(--color-accent, #d4a017);
  border-radius: 4px;
}
.plugins-legal p { margin: 0; }
.plugins-legal strong { color: var(--color-text, #ddd); }

.chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.chip-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  background: var(--bg-input, rgba(0,0,0,0.2));
  cursor: pointer;
  font-size: 0.85rem;
  transition: border-color 0.15s, background 0.15s;
  user-select: none;
}
.chip-checkbox:hover { border-color: var(--accent, #4a90e2); }
.chip-checkbox.checked {
  border-color: var(--accent, #4a90e2);
  background: rgba(74, 144, 226, 0.1);
}
.chip-checkbox input[type="checkbox"] {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--accent, #4a90e2);
  cursor: pointer;
}
</style>
