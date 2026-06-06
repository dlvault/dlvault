<template>
  <SettingsSection label="Quellen-Plugins">
    <p class="intro">
      Plugins erweitern dlvault um zusätzliche Quellen. dlvault selbst pflegt keine zentrale Plugin-Liste —
      Plugins kommen von Drittanbietern, denen du selbst vertraust.
    </p>

    <div class="plugin-actions">
      <button class="btn btn-primary" type="button" @click="openAddModal">
        <Plus :size="14" /> <span>Plugin hinzufügen</span>
      </button>
      <button class="btn btn-ghost" type="button" :disabled="loading" @click="reload">
        <RefreshCw :size="14" /> <span>Aktualisieren</span>
      </button>
    </div>

    <h4 class="group-title">Installiert</h4>
    <p v-if="loading" class="empty-hint">Lade Plugins…</p>
    <p v-else-if="registered.length === 0" class="empty-hint">Keine Plugins installiert.</p>

    <div v-else class="plugin-list">
      <div
        v-for="p in registered"
        :key="p.id"
        :class="['plugin-card', { 'is-expanded': expandedId === p.id }]"
      >
        <div class="plugin-row" role="button" tabindex="0"
             @click="toggleExpand(p.id)"
             @keydown.enter.prevent="toggleExpand(p.id)">
          <div class="plugin-info">
            <div class="plugin-title">
              <span :class="['chevron', { rotated: expandedId === p.id }]">▸</span>
              <strong>{{ p.name }}</strong>
              <span v-if="p.version" class="tag info">v{{ p.version }}</span>
              <span v-if="p.bundled" class="tag info">bundled</span>
              <span v-for="t in p.mediaTypes" :key="t" class="tag warn">{{ t }}</span>
            </div>
            <div class="plugin-meta">
              <code>{{ p.id }}</code>
              <span v-if="p.author"> · {{ p.author }}</span>
            </div>
          </div>
          <div class="plugin-controls" @click.stop>
            <Toggle :model-value="p.enabled" @update:model-value="() => toggleEnabled(p)" />
            <button
              class="btn btn-danger btn-sm"
              type="button"
              :disabled="p.bundled"
              :title="p.bundled ? 'Bundled-Plugins können nicht entfernt werden' : 'Plugin entfernen'"
              @click="confirmUninstall(p)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </div>

        <div v-if="expandedId === p.id" class="plugin-details" @click.stop>
          <p v-if="p.description" class="plugin-description">{{ p.description }}</p>
          <dl class="attr-grid">
            <template v-if="p.homepage">
              <dt>Homepage</dt>
              <dd><a :href="p.homepage" target="_blank" rel="noopener">{{ p.homepage }}</a></dd>
            </template>
            <template v-if="p.permissions && p.permissions.length">
              <dt>Berechtigungen</dt>
              <dd>
                <span v-for="perm in p.permissions" :key="perm" class="tag warn">{{ perm }}</span>
              </dd>
            </template>
            <template v-if="p.cspDomains.length">
              <dt>CSP-Domains</dt>
              <dd><code>{{ p.cspDomains.join(', ') }}</code></dd>
            </template>
          </dl>

          <template v-if="p.settingsSchema && p.settingsSchema.length">
            <h5 class="settings-title">Einstellungen</h5>
            <p class="settings-hint">Änderungen werden über die Save-Bar unten gespeichert.</p>
            <div class="plugin-settings">
              <div v-for="field in p.settingsSchema" :key="field.key" class="plugin-field">
                <label :for="`plugin-${p.id}-${field.key}`" class="field-label">
                  {{ field.label }}
                  <small v-if="field.description" class="field-hint">— {{ field.description }}</small>
                </label>
                <Toggle
                  v-if="field.type === 'boolean'"
                  :model-value="isFieldTrue(p, field)"
                  @update:model-value="v => setField(p, field, v ? 'true' : 'false')"
                />
                <Chips
                  v-else-if="field.type === 'multi-select'"
                  :model-value="fieldSelectedOptions(p, field)"
                  @update:model-value="v => setField(p, field, v.join(','))"
                  :options="field.options || []"
                />
                <SecretInput
                  v-else-if="field.type === 'secret'"
                  :model-value="settings[fieldKey(p, field)] ?? ''"
                  :placeholder="field.default || 'API key / token'"
                  optional
                  @update:model-value="(v: string) => setField(p, field, v)"
                />
                <input
                  v-else
                  :id="`plugin-${p.id}-${field.key}`"
                  class="sx-input"
                  :type="field.type === 'number' ? 'number' : 'text'"
                  :value="fieldValue(p, field)"
                  :placeholder="field.default || ''"
                  @input="onFieldInput(p, field, ($event.target as HTMLInputElement).value)"
                />
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <template v-if="pending.length > 0">
      <h4 class="group-title">Wartet auf Bestätigung</h4>
      <p class="hint">
        Diese Plugin-Dateien liegen in <code>data/plugins/</code>, sind aber noch nicht aktiviert.
        Lies das Manifest und bestätige bewusst.
      </p>
      <div class="plugin-list">
        <div v-for="p in pending" :key="p.id" class="plugin-card plugin-card-pending">
          <div class="plugin-row">
            <div class="plugin-info">
              <div class="plugin-title">
                <strong>{{ p.name }}</strong>
                <span class="tag warn">v{{ p.version }}</span>
                <span v-if="p.reason === 'sha-mismatch'" class="tag err">Datei verändert</span>
              </div>
              <div class="plugin-meta">
                <code>{{ p.id }}</code>
                <span v-if="p.author"> · {{ p.author }}</span>
              </div>
              <p v-if="p.description" class="plugin-description">{{ p.description }}</p>
              <div v-if="p.permissions && p.permissions.length" class="plugin-perms">
                <strong>Berechtigungen:</strong>
                <span v-for="perm in p.permissions" :key="perm" class="tag warn">{{ perm }}</span>
              </div>
              <code class="plugin-sha">SHA-256: {{ p.fileSha256 }}</code>
            </div>
            <div class="plugin-controls">
              <button class="btn btn-primary" type="button" @click="acceptPending(p)">
                <Check :size="14" /> <span>Akzeptieren</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div class="legal">
      <strong>Plugin-Verantwortung.</strong> Plugins führen Drittanbieter-Code in dlvault aus.
      dlvault selbst pflegt keine Plugin-Liste, prüft keine Plugin-Inhalte und empfiehlt keine Quellen.
      Du bist verantwortlich dafür, dass die Nutzung jedes installierten Plugins mit deinen anwendbaren
      Urheberrechts- und Nutzungsbestimmungen vereinbar ist.
    </div>
  </SettingsSection>

  <AddPluginModal ref="addModal" @installed="onInstalled" />
  <ConfirmModal ref="confirmModal" />
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
import SettingsSection from './SettingsSection.vue';
import Toggle from './Toggle.vue';
import Chips from './Chips.vue';

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

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id;
}

async function reload() {
  loading.value = true;
  try {
    const res = await listPlugins();
    registered.value = res.data.registered;
    pending.value = res.data.pending;
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } } };
    toast.value?.add(e.response?.data?.error || 'Plugins konnten nicht geladen werden', 'error');
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
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } } };
    toast.value?.add(e.response?.data?.error || 'Aktion fehlgeschlagen', 'error');
  }
}

async function confirmUninstall(p: RegisteredPlugin) {
  const ok = await confirmModal.value?.show({
    title: `${p.name} entfernen?`,
    message: 'Das Plugin und sein Disclaimer-Eintrag werden gelöscht. Plugin-Settings bleiben in der DB erhalten.',
    confirmText: 'Entfernen',
    danger: true,
  });
  if (!ok) return;
  try {
    await uninstallPlugin(p.id);
    toast.value?.add(`${p.name} entfernt`, 'success');
    await reload();
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } } };
    toast.value?.add(e.response?.data?.error || 'Entfernen fehlgeschlagen', 'error');
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
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } } };
    toast.value?.add(e.response?.data?.error || 'Aktivierung fehlgeschlagen', 'error');
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
.intro {
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.55;
  margin-bottom: 14px;
}
.hint {
  font-size: 12.5px;
  color: var(--text-3);
  line-height: 1.55;
  margin-bottom: 10px;
}
.hint code {
  font-family: var(--font-mono);
  background: var(--surface-2);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
  color: var(--text-secondary);
}
.empty-hint {
  font-size: 13px;
  color: var(--text-3);
  font-style: italic;
  padding: 12px 0;
}

.plugin-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.group-title {
  margin: 22px 0 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
  font-weight: 500;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line);
}

.plugin-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.plugin-card {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  overflow: hidden;
  transition: border-color 0.15s;
}
.plugin-card.is-expanded { border-color: var(--accent); }
.plugin-card-pending {
  border-color: rgba(245, 176, 65, 0.4);
  background: rgba(245, 176, 65, 0.04);
}

.plugin-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 12px 14px;
  cursor: pointer;
}
.plugin-info { flex: 1; min-width: 0; }
.plugin-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 13.5px;
}
.chevron {
  display: inline-block;
  transition: transform 0.15s;
  font-size: 0.8em;
  width: 12px;
  color: var(--text-3);
}
.chevron.rotated { transform: rotate(90deg); }
.plugin-meta {
  font-size: 11.5px;
  color: var(--text-3);
}
.plugin-meta code {
  font-family: var(--font-mono);
  background: var(--surface);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10.5px;
  color: var(--text-secondary);
}
.plugin-description {
  margin: 8px 0;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.plugin-perms {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 6px 0;
  font-size: 12px;
  align-items: center;
}
.plugin-perms strong { color: var(--text-secondary); }
.plugin-sha {
  display: block;
  font-size: 10.5px;
  font-family: var(--font-mono);
  color: var(--text-3);
  word-break: break-all;
  margin-top: 8px;
}
.plugin-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.plugin-details {
  padding: 4px 14px 16px 32px;
  border-top: 1px solid var(--line);
}
.attr-grid {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 6px 12px;
  font-size: 12.5px;
  margin: 10px 0;
}
.attr-grid dt {
  font-family: var(--font-mono);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-3);
}
.attr-grid dd { margin: 0; word-break: break-word; color: var(--text-secondary); }
.attr-grid a { color: var(--accent); text-decoration: none; }
.attr-grid a:hover { text-decoration: underline; }
.attr-grid code {
  font-family: var(--font-mono);
  background: var(--surface);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
  color: var(--text-secondary);
}

.settings-title {
  margin: 16px 0 4px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-3);
  font-weight: 500;
}
.settings-hint {
  font-size: 11.5px;
  margin-bottom: 10px;
  color: var(--text-3);
}
.plugin-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.plugin-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
}
.field-hint {
  font-weight: 400;
  color: var(--text-3);
  font-size: 11.5px;
}

.tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 500;
}
.tag.info {
  background: rgba(93, 173, 226, 0.12);
  color: var(--info);
  border: 1px solid rgba(93, 173, 226, 0.3);
}
.tag.warn {
  background: rgba(245, 176, 65, 0.12);
  color: var(--warn);
  border: 1px solid rgba(245, 176, 65, 0.3);
}
.tag.err {
  background: rgba(240, 123, 110, 0.12);
  color: var(--err);
  border: 1px solid rgba(240, 123, 110, 0.3);
}

.btn-sm {
  padding: 5px 10px;
  font-size: 12px;
}

.legal {
  margin-top: 22px;
  padding: 12px 16px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-3);
  background: var(--surface-2);
  border-left: 3px solid var(--warn);
  border-radius: var(--r-sm);
}
.legal strong { color: var(--text-secondary); }
</style>
