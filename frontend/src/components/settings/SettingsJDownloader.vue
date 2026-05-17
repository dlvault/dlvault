<template>
  <details class="card settings-section" open>
    <summary class="card-toggle"><h2>MyJDownloader</h2></summary>
    <div class="form-grid">
      <div class="form-group">
        <label for="jd-email">E-Mail <span class="required">*</span></label>
        <input
          id="jd-email"
          v-model="settings['jdownloader.email']"
          type="email"
          placeholder="myjdownloader@email.com"
          @blur="validateEmail('jdownloader.email')"
          :class="{ 'input-error': errors['jdownloader.email'] }"
        />
        <span v-if="errors['jdownloader.email']" class="field-error">{{ errors['jdownloader.email'] }}</span>
      </div>
      <div class="form-group">
        <label for="jd-password">Passwort <span class="required">*</span></label>
        <input id="jd-password" v-model="settings['jdownloader.password']" type="password" placeholder="Passwort" />
      </div>
      <div class="form-group">
        <label for="jd-device">Gerätename (leer = erstes Gerät)</label>
        <input id="jd-device" v-model="settings['jdownloader.device_name']" placeholder="JDownloader@Unraid" />
      </div>
    </div>
    <div class="settings-action-row">
      <button class="btn btn-secondary" @click="testJD">Verbindung testen</button>
      <span v-if="jdStatus.connected" class="badge badge-found">
        Verbunden ({{ jdStatus.devices.length }} Gerät{{ jdStatus.devices.length !== 1 ? 'e' : '' }})
      </span>
      <span v-else-if="jdStatus.configured" class="badge badge-not_found">Nicht verbunden</span>
      <span v-else class="badge badge-not_found">Nicht konfiguriert</span>
    </div>
  </details>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { getJDownloaderStatus, testJDownloader } from '../../api/index';
import type { JDStatus } from '../../types/index';
import { useSettingsContext } from '../../composables/useSettingsContext';
import { useToast } from '../../composables/useApp';

const { settings, errors, saveAll, loadSettings, validateEmail } = useSettingsContext();
const toast = useToast();

const jdStatus = ref<JDStatus>({ configured: false, connected: false, devices: [] });

async function testJD() {
  await saveAll();
  try {
    const res = await testJDownloader();
    if (res.data.success) {
      toast.value?.add(`JDownloader verbunden! ${res.data.devices.length} Gerät(e) gefunden.`, 'success');
      await loadSettings();
      jdStatus.value = { configured: true, connected: true, devices: res.data.devices };
    }
  } catch (e: unknown) {
    const axiosErr = e as { response?: { data?: { error?: string } } };
    toast.value?.add(axiosErr.response?.data?.error || 'JDownloader Verbindung fehlgeschlagen', 'error');
  }
}

onMounted(async () => {
  const res = await getJDownloaderStatus().catch(() => ({ data: { configured: false, connected: false, devices: [] } }));
  jdStatus.value = res.data;
});
</script>
