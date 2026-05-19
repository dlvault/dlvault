<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible" class="modal-backdrop" @click.self="close" @keydown.escape="close"
           role="dialog" aria-modal="true" aria-label="Plugin hinzufügen">
        <div class="modal-box modal-box-wide">
          <h3 class="modal-title">Plugin hinzufügen</h3>
          <p class="modal-disclaimer">
            dlvault verwaltet keine zentrale Plugin-Liste. Plugins kommen von
            Drittanbietern, denen du selbst vertraust.
          </p>

          <!-- Step 1: Source selection -->
          <template v-if="step === 'source'">
            <div class="form-group">
              <label class="radio-row">
                <input type="radio" v-model="source" value="url" />
                URL eingeben (.dlvault.js)
              </label>
              <label class="radio-row">
                <input type="radio" v-model="source" value="upload" />
                Datei vom Computer hochladen
              </label>
              <label class="radio-row">
                <input type="radio" v-model="source" value="drop" />
                Im Plugin-Ordner ablegen (Anleitung anzeigen)
              </label>
            </div>

            <template v-if="source === 'url'">
              <div class="form-group">
                <label>URL</label>
                <input v-model="url" type="url" placeholder="https://example.com/my-plugin.dlvault.js" />
              </div>
            </template>

            <template v-else-if="source === 'upload'">
              <div class="form-group">
                <label>Datei (.dlvault.js)</label>
                <input type="file" accept=".dlvault.js,.js" @change="onFileSelected" />
                <p v-if="uploadFile" class="text-secondary">
                  Ausgewählt: <code>{{ uploadFile.name }}</code> ({{ Math.round(uploadFile.size / 1024) }} KB)
                </p>
              </div>
            </template>

            <template v-else-if="source === 'drop'">
              <div class="drop-instructions">
                <h4>So legst du Plugin-Dateien direkt ab:</h4>
                <ol>
                  <li>Speichere die <code>.dlvault.js</code>-Datei auf deinem Rechner</li>
                  <li>Kopiere sie nach <code>data/plugins/</code> (per SFTP/SMB auf den Server)</li>
                  <li>Aktualisiere diese Seite — die Datei erscheint unter „Wartet auf Bestätigung"</li>
                  <li>Klicke dort auf „Akzeptieren" um sie zu aktivieren</li>
                </ol>
                <p class="text-secondary">
                  Diese Methode braucht keine Web-UI-Berechtigung und funktioniert
                  auch wenn dlvault sonst offline ist.
                </p>
              </div>
            </template>

            <div class="modal-actions">
              <button class="btn btn-secondary" @click="close">Abbrechen</button>
              <button v-if="source === 'url' || source === 'upload'"
                      class="btn btn-primary"
                      @click="loadPreview"
                      :disabled="loading || !canPreview">
                <LoadingSpinner v-if="loading" inline />
                {{ loading ? 'Lädt…' : 'Vorschau anzeigen' }}
              </button>
              <button v-else class="btn btn-primary" @click="close">Verstanden</button>
            </div>
          </template>

          <!-- Step 2: Manifest preview + disclaimer -->
          <template v-else-if="step === 'preview' && preview">
            <div class="preview-card">
              <div class="preview-header">
                <h4>{{ preview.manifest.name }}</h4>
                <span class="badge badge-info">v{{ preview.manifest.version }}</span>
              </div>
              <p v-if="preview.manifest.description" class="preview-description">
                {{ preview.manifest.description }}
              </p>
              <dl class="preview-details">
                <dt>ID</dt>
                <dd><code>{{ preview.manifest.id }}</code></dd>
                <dt>Medientypen</dt>
                <dd>{{ preview.manifest.mediaTypes.join(', ') }}</dd>
                <dt v-if="preview.manifest.author">Autor</dt>
                <dd v-if="preview.manifest.author">{{ preview.manifest.author }}</dd>
                <dt v-if="preview.manifest.homepage">Homepage</dt>
                <dd v-if="preview.manifest.homepage">
                  <a :href="preview.manifest.homepage" target="_blank" rel="noopener">
                    {{ preview.manifest.homepage }}
                  </a>
                </dd>
                <dt v-if="preview.manifest.permissions && preview.manifest.permissions.length">Berechtigungen</dt>
                <dd v-if="preview.manifest.permissions && preview.manifest.permissions.length">
                  <span v-for="p in preview.manifest.permissions" :key="p" class="badge badge-warning">{{ p }}</span>
                </dd>
                <dt v-if="preview.manifest.cspDomains && preview.manifest.cspDomains.length">CSP-Domains</dt>
                <dd v-if="preview.manifest.cspDomains && preview.manifest.cspDomains.length">
                  <code class="domain-list">{{ preview.manifest.cspDomains.join(', ') }}</code>
                </dd>
                <dt>SHA-256</dt>
                <dd><code class="sha">{{ preview.fileSha256 }}</code></dd>
              </dl>
            </div>

            <div class="warning-box">
              ⚠️ Plugins führen Code aus mit Zugriff auf deine Einstellungen,
              Downloads und Mediathek. Installiere nur was du verstehst und
              dessen Quelle du vertraust.
            </div>

            <label class="disclaimer-check">
              <input type="checkbox" v-model="disclaimerAccepted" />
              <span>
                Ich verstehe, dass dieses Plugin Drittanbieter-Code ist und ich
                für seinen Einsatz selbst verantwortlich bin.
              </span>
            </label>

            <div class="modal-actions">
              <button class="btn btn-secondary" @click="goBack">Zurück</button>
              <button class="btn btn-primary"
                      @click="doInstall"
                      :disabled="!disclaimerAccepted || installing">
                <LoadingSpinner v-if="installing" inline />
                {{ installing ? 'Installiert…' : 'Installieren' }}
              </button>
            </div>
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import {
  previewPluginFromUrl, previewPluginFromUpload,
  installPluginFromUrl, installPluginFromUpload,
  type PluginManifest,
} from '../api/index';
import { useToast } from '../composables/useApp';
import LoadingSpinner from './LoadingSpinner.vue';

const emit = defineEmits<{
  installed: [];
}>();

const toast = useToast();
const visible = ref(false);
const step = ref<'source' | 'preview'>('source');
const source = ref<'url' | 'upload' | 'drop'>('url');

const url = ref('');
const uploadFile = ref<File | null>(null);
const uploadBase64 = ref<string | null>(null);
const uploadFilename = ref<string | null>(null);

const loading = ref(false);
const installing = ref(false);
const preview = ref<{ manifest: PluginManifest; fileSha256: string } | null>(null);
const disclaimerAccepted = ref(false);

const canPreview = computed(() => {
  if (source.value === 'url') return /^https:\/\/.+\.dlvault\.js(\?.*)?$/.test(url.value);
  if (source.value === 'upload') return !!uploadBase64.value && !!uploadFilename.value;
  return false;
});

function open() {
  reset();
  visible.value = true;
}

function reset() {
  step.value = 'source';
  source.value = 'url';
  url.value = '';
  uploadFile.value = null;
  uploadBase64.value = null;
  uploadFilename.value = null;
  preview.value = null;
  disclaimerAccepted.value = false;
  loading.value = false;
  installing.value = false;
}

function close() {
  visible.value = false;
}

function goBack() {
  step.value = 'source';
  disclaimerAccepted.value = false;
  preview.value = null;
}

async function onFileSelected(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  if (!file.name.endsWith('.dlvault.js')) {
    toast.value?.add('Datei muss auf .dlvault.js enden', 'warning');
    target.value = '';
    return;
  }
  uploadFile.value = file;
  uploadFilename.value = file.name;
  uploadBase64.value = await readFileAsBase64(file);
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:application/javascript;base64,XXX" — strip the prefix
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function loadPreview() {
  loading.value = true;
  try {
    const res = source.value === 'url'
      ? await previewPluginFromUrl(url.value)
      : await previewPluginFromUpload(uploadBase64.value!);
    preview.value = res.data;
    step.value = 'preview';
  } catch (err: any) {
    toast.value?.add(err.response?.data?.error || 'Vorschau fehlgeschlagen', 'error');
  } finally {
    loading.value = false;
  }
}

async function doInstall() {
  if (!disclaimerAccepted.value || !preview.value) return;
  installing.value = true;
  try {
    if (source.value === 'url') {
      await installPluginFromUrl(url.value, true);
    } else {
      await installPluginFromUpload(uploadFilename.value!, uploadBase64.value!, true);
    }
    toast.value?.add(`${preview.value.manifest.name} installiert`, 'success');
    emit('installed');
    close();
  } catch (err: any) {
    toast.value?.add(err.response?.data?.error || 'Installation fehlgeschlagen', 'error');
  } finally {
    installing.value = false;
  }
}

defineExpose({ open });
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9998;
  backdrop-filter: blur(2px);
  padding: 20px;
}
.modal-box {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  max-width: 420px;
  width: 100%;
}
.modal-box-wide {
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
}
.modal-title {
  font-size: 1.1rem;
  margin-bottom: 6px;
}
.modal-disclaimer {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin-bottom: 18px;
  line-height: 1.5;
}
.radio-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  cursor: pointer;
}
.radio-row input[type="radio"] {
  width: 16px;
  height: 16px;
}
.drop-instructions {
  background: var(--color-bg-subtle, rgba(0,0,0,0.2));
  padding: 14px 18px;
  border-radius: 8px;
  margin: 10px 0;
}
.drop-instructions h4 {
  margin-top: 0;
  margin-bottom: 10px;
}
.drop-instructions ol {
  padding-left: 22px;
  line-height: 1.6;
}
.drop-instructions code {
  font-family: var(--font-mono, monospace);
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 5px;
  border-radius: 3px;
}

.preview-card {
  background: var(--color-bg-subtle, rgba(0,0,0,0.2));
  padding: 14px 18px;
  border-radius: 8px;
  margin: 12px 0;
}
.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.preview-header h4 { margin: 0; }
.preview-description {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin: 6px 0 10px;
}
.preview-details {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 6px 12px;
  font-size: 0.85rem;
  margin: 0;
}
.preview-details dt {
  color: var(--text-secondary);
  font-weight: 600;
}
.preview-details dd {
  margin: 0;
  word-break: break-word;
}
.preview-details code { font-family: var(--font-mono, monospace); }
.sha { font-size: 0.75rem; }
.domain-list { font-size: 0.8rem; }

.warning-box {
  background: rgba(212, 160, 23, 0.1);
  border-left: 3px solid var(--color-accent, #d4a017);
  padding: 10px 14px;
  border-radius: 4px;
  font-size: 0.85rem;
  margin: 12px 0;
  line-height: 1.5;
}

.disclaimer-check {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 0;
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1.4;
}
.disclaimer-check input[type="checkbox"] {
  margin-top: 3px;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.modal-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 16px;
}

.modal-enter-active { transition: opacity 0.2s; }
.modal-leave-active { transition: opacity 0.15s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }

@media (max-width: 768px) {
  .preview-details {
    grid-template-columns: 1fr;
    gap: 2px;
  }
  .preview-details dd { margin-bottom: 8px; }
  .modal-actions { flex-direction: column-reverse; }
  .modal-actions .btn { width: 100%; }
}
</style>
